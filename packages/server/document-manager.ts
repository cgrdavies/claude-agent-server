import { getSchema } from '@tiptap/core'
import { Markdown, MarkdownManager } from '@tiptap/markdown'
import StarterKit from '@tiptap/starter-kit'
import { renderToMarkdown } from '@tiptap/static-renderer/pm/markdown'
import {
  prosemirrorJSONToYXmlFragment,
  yXmlFragmentToProsemirrorJSON,
} from 'y-prosemirror'
import * as Y from 'yjs'

import { withRLS } from './lib/db'

export type DocumentInfo = {
  id: string
  name: string
  workspace_id: string
  created_by: string
  created_at: string
  updated_at: string
}

// Shared Tiptap extensions and schema for markdown <-> ProseMirror conversion
const extensions = [StarterKit, Markdown]
const schema = getSchema(extensions)
const markdownManager = new MarkdownManager({ extensions })

// Minimum valid ProseMirror doc (empty paragraph)
const EMPTY_DOC_JSON = { type: 'doc', content: [{ type: 'paragraph' }] }

/**
 * Parse markdown string to ProseMirror JSON.
 */
function markdownToJSON(markdown: string): Record<string, unknown> {
  return markdownManager.parse(markdown)
}

/**
 * Serialize ProseMirror JSON to markdown string.
 */
function jsonToMarkdown(json: Record<string, unknown>): string {
  return renderToMarkdown({ extensions, content: json }).trim()
}

/**
 * Populate a Y.XmlFragment from a markdown string.
 * The fragment should be empty before calling this.
 */
function populateFragment(fragment: Y.XmlFragment, markdown: string): void {
  const json = markdownToJSON(markdown)
  prosemirrorJSONToYXmlFragment(schema, json, fragment)
}

/**
 * Read a Y.XmlFragment as a markdown string.
 */
function fragmentToMarkdown(fragment: Y.XmlFragment): string {
  const json = yXmlFragmentToProsemirrorJSON(fragment)
  return jsonToMarkdown(json)
}

// In-memory cache of active documents
const docs = new Map<string, Y.Doc>()

// Debounce timers for persisting documents
const persistTimers = new Map<string, Timer>()
const PERSIST_DEBOUNCE_MS = 500

function cancelPendingPersist(id: string): void {
  const timer = persistTimers.get(id)
  if (timer) {
    clearTimeout(timer)
    persistTimers.delete(id)
  }
}

/**
 * Get or load a Y.Doc from cache/database.
 * Returns null if document doesn't exist or isn't in the user's workspace.
 */
export async function getDoc(
  userId: string,
  workspaceId: string,
  id: string,
): Promise<Y.Doc | null> {
  if (docs.has(id)) return docs.get(id)!

  const rows = await withRLS(
    userId,
    sql =>
      sql`SELECT yjs_state FROM documents
        WHERE id = ${id} AND workspace_id = ${workspaceId}
        LIMIT 1`,
  )
  const row = rows[0] as { yjs_state: Buffer | Uint8Array } | undefined
  if (!row) return null

  const doc = new Y.Doc()
  const state =
    row.yjs_state instanceof Buffer
      ? new Uint8Array(row.yjs_state)
      : new Uint8Array(row.yjs_state)
  Y.applyUpdate(doc, state)

  // Listen for updates and persist (debounced)
  doc.on('update', () => debouncedPersist(userId, id, doc))

  docs.set(id, doc)
  return doc
}

/**
 * Get a Y.Doc from cache only (no DB load).
 * Used by WebSocket sync handler where the doc should already be loaded.
 */
export function getDocFromCache(id: string): Y.Doc | null {
  return docs.get(id) ?? null
}

/**
 * Create a new document with optional initial markdown content.
 * Stores content as a Y.XmlFragment('default') containing ProseMirror nodes.
 * Returns the document info including generated ID.
 */
export async function createDoc(
  userId: string,
  workspaceId: string,
  name: string,
  content?: string,
): Promise<DocumentInfo> {
  const doc = new Y.Doc()
  const fragment = doc.getXmlFragment('default')

  if (content) {
    populateFragment(fragment, content)
  } else {
    prosemirrorJSONToYXmlFragment(schema, EMPTY_DOC_JSON, fragment)
  }

  const state = Buffer.from(Y.encodeStateAsUpdate(doc))
  const id = crypto.randomUUID()

  const rows = await withRLS(
    userId,
    sql =>
      sql`INSERT INTO documents (id, workspace_id, name, yjs_state, created_by)
        VALUES (${id}, ${workspaceId}, ${name}, ${state}, ${userId})
        RETURNING id, workspace_id, name, created_by, created_at, updated_at`,
  )
  const info = rows[0] as DocumentInfo

  doc.on('update', () => debouncedPersist(userId, id, doc))
  docs.set(id, doc)

  return info
}

/**
 * Delete a document.
 */
export async function deleteDoc(
  userId: string,
  workspaceId: string,
  id: string,
): Promise<boolean> {
  const doc = docs.get(id)
  if (doc) {
    doc.destroy()
    docs.delete(id)
  }

  // Cancel any pending persist
  const timer = persistTimers.get(id)
  if (timer) {
    clearTimeout(timer)
    persistTimers.delete(id)
  }

  const result = await withRLS(
    userId,
    sql =>
      sql`DELETE FROM documents WHERE id = ${id} AND workspace_id = ${workspaceId} RETURNING id`,
  )
  return result.length > 0
}

/**
 * List all documents in a workspace.
 */
export async function listDocs(
  userId: string,
  workspaceId: string,
): Promise<DocumentInfo[]> {
  const rows = await withRLS(
    userId,
    sql =>
      sql`SELECT id, workspace_id, name, created_by, created_at, updated_at
        FROM documents
        WHERE workspace_id = ${workspaceId}
        ORDER BY updated_at DESC`,
  )
  return rows as unknown as DocumentInfo[]
}

/**
 * Read document content as markdown string.
 * Converts the Y.XmlFragment to ProseMirror JSON, then to markdown.
 */
export async function readDocAsText(
  userId: string,
  workspaceId: string,
  id: string,
): Promise<{ name: string; content: string } | null> {
  const doc = await getDoc(userId, workspaceId, id)
  if (!doc) return null

  // Get the name from DB
  const rows = await withRLS(
    userId,
    sql =>
      sql`SELECT name FROM documents WHERE id = ${id} AND workspace_id = ${workspaceId} LIMIT 1`,
  )
  const row = rows[0] as { name: string } | undefined
  if (!row) return null

  const fragment = doc.getXmlFragment('default')
  return { name: row.name, content: fragmentToMarkdown(fragment) }
}

/**
 * Apply a find-and-replace edit to a document.
 * Serializes XmlFragment to markdown, applies the text edit, then replaces
 * the fragment content atomically.
 * Returns true if the edit was applied, false if old_text was not found.
 */
export async function editDoc(
  userId: string,
  workspaceId: string,
  id: string,
  oldText: string,
  newText: string,
): Promise<boolean> {
  const doc = await getDoc(userId, workspaceId, id)
  if (!doc) throw new Error(`Document ${id} not found`)

  const fragment = doc.getXmlFragment('default')
  const content = fragmentToMarkdown(fragment)
  const index = content.indexOf(oldText)
  if (index === -1) return false

  const edited =
    content.slice(0, index) + newText + content.slice(index + oldText.length)

  doc.transact(() => {
    // Clear existing content
    while (fragment.length > 0) {
      fragment.delete(0, 1)
    }
    // Populate with edited markdown
    populateFragment(fragment, edited)
  })

  cancelPendingPersist(id)
  await persistDoc(userId, id, doc)

  return true
}

/**
 * Append markdown content to the end of a document.
 * Parses the appended markdown to ProseMirror nodes and appends them
 * to the existing XmlFragment.
 */
export async function appendDoc(
  userId: string,
  workspaceId: string,
  id: string,
  content: string,
): Promise<void> {
  const doc = await getDoc(userId, workspaceId, id)
  if (!doc) throw new Error(`Document ${id} not found`)

  const fragment = doc.getXmlFragment('default')

  // Get current content as markdown, append, and replace
  const current = fragmentToMarkdown(fragment)
  const combined = current + content

  doc.transact(() => {
    while (fragment.length > 0) {
      fragment.delete(0, 1)
    }
    populateFragment(fragment, combined)
  })

  cancelPendingPersist(id)
  await persistDoc(userId, id, doc)
}

/**
 * Replace a document's entire content with new markdown.
 * Clears the XmlFragment and re-populates from the new markdown.
 */
export async function replaceDocContent(
  userId: string,
  workspaceId: string,
  id: string,
  markdown: string,
): Promise<void> {
  const doc = await getDoc(userId, workspaceId, id)
  if (!doc) throw new Error(`Document ${id} not found`)

  const fragment = doc.getXmlFragment('default')

  doc.transact(() => {
    while (fragment.length > 0) {
      fragment.delete(0, 1)
    }
    populateFragment(fragment, markdown)
  })

  cancelPendingPersist(id)
  await persistDoc(userId, id, doc)
}

/**
 * Update a document's name in the database.
 */
export async function renameDoc(
  userId: string,
  workspaceId: string,
  id: string,
  name: string,
): Promise<void> {
  await withRLS(
    userId,
    sql =>
      sql`UPDATE documents SET name = ${name}, updated_at = now()
        WHERE id = ${id} AND workspace_id = ${workspaceId}`,
  )
}

/**
 * Persist a document's current state to Supabase (debounced).
 */
function debouncedPersist(userId: string, id: string, doc: Y.Doc): void {
  const existing = persistTimers.get(id)
  if (existing) clearTimeout(existing)

  persistTimers.set(
    id,
    setTimeout(async () => {
      persistTimers.delete(id)
      await persistDoc(userId, id, doc)
    }, PERSIST_DEBOUNCE_MS),
  )
}

/**
 * Persist a document's current state to Supabase.
 */
async function persistDoc(
  userId: string,
  id: string,
  doc: Y.Doc,
): Promise<void> {
  const state = Buffer.from(Y.encodeStateAsUpdate(doc))
  await withRLS(
    userId,
    sql =>
      sql`UPDATE documents SET yjs_state = ${state}, updated_at = now()
        WHERE id = ${id}`,
  )
}

/**
 * Get a document's info without loading the full Y.Doc.
 */
export async function getDocInfo(
  userId: string,
  workspaceId: string,
  id: string,
): Promise<DocumentInfo | null> {
  const rows = await withRLS(
    userId,
    sql =>
      sql`SELECT id, workspace_id, name, created_by, created_at, updated_at
        FROM documents
        WHERE id = ${id} AND workspace_id = ${workspaceId}
        LIMIT 1`,
  )
  return (rows[0] as DocumentInfo | undefined) ?? null
}

/**
 * Clear the in-memory document cache. Useful for testing persistence.
 */
export function clearCache(): void {
  docs.forEach(doc => doc.destroy())
  docs.clear()
  persistTimers.forEach(timer => clearTimeout(timer))
  persistTimers.clear()
}

/**
 * Flush any pending persist operations immediately.
 * Useful before tests or shutdown.
 */
export async function flushPendingPersists(userId: string): Promise<void> {
  const promises: Promise<void>[] = []
  for (const [id, timer] of persistTimers) {
    clearTimeout(timer)
    persistTimers.delete(id)
    const doc = docs.get(id)
    if (doc) {
      promises.push(persistDoc(userId, id, doc))
    }
  }
  await Promise.all(promises)
}
