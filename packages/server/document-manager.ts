import { getSchema } from '@tiptap/core'
import { TableKit } from '@tiptap/extension-table'
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
  project_id: string
  workspace_id: string
  folder_id: string | null
  name: string
  created_by: string
  created_at: string
  updated_at: string
}

// Shared Tiptap extensions and schema for markdown <-> ProseMirror conversion
const extensions = [StarterKit, Markdown, TableKit]
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

// In-memory cache of active documents (keyed by projectId:docId for security)
const docs = new Map<string, Y.Doc>()

// Track pending loads to prevent race conditions
const pendingLoads = new Map<string, Promise<Y.Doc | null>>()

function cacheKey(projectId: string, id: string): string {
  return `${projectId}:${id}`
}

// Debounce timers for persisting documents
const persistTimers = new Map<string, Timer>()
const PERSIST_DEBOUNCE_MS = 500

function cancelPendingPersist(projectId: string, id: string): void {
  const key = cacheKey(projectId, id)
  const timer = persistTimers.get(key)
  if (timer) {
    clearTimeout(timer)
    persistTimers.delete(key)
  }
}

/**
 * Get or load a Y.Doc from cache/database.
 * Returns null if document doesn't exist or user doesn't have access.
 */
export async function getDoc(
  userId: string,
  projectId: string,
  id: string,
): Promise<Y.Doc | null> {
  const key = cacheKey(projectId, id)

  // Return cached doc if available
  if (docs.has(key)) {
    return docs.get(key)!
  }

  // If a load is already in progress, wait for it
  if (pendingLoads.has(key)) {
    return pendingLoads.get(key)!
  }

  // Start loading and track the promise
  const loadPromise = loadDoc(userId, projectId, id, key)
  pendingLoads.set(key, loadPromise)

  try {
    return await loadPromise
  } finally {
    pendingLoads.delete(key)
  }
}

async function loadDoc(
  userId: string,
  projectId: string,
  id: string,
  key: string,
): Promise<Y.Doc | null> {
  const rows = await withRLS(
    userId,
    sql =>
      sql`SELECT yjs_state FROM documents
        WHERE id = ${id} AND project_id = ${projectId} AND deleted_at IS NULL
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
  doc.on('update', () => debouncedPersist(userId, projectId, id, doc))

  docs.set(key, doc)
  return doc
}

/**
 * Get a Y.Doc from cache only (no DB load).
 * Used by WebSocket sync handler where the doc should already be loaded.
 */
export function getDocFromCache(projectId: string, id: string): Y.Doc | null {
  return docs.get(cacheKey(projectId, id)) ?? null
}

/**
 * Create a new document with optional initial markdown content.
 * Stores content as a Y.XmlFragment('default') containing ProseMirror nodes.
 * Returns the document info including generated ID.
 */
export async function createDoc(
  userId: string,
  projectId: string,
  name: string,
  content?: string,
  folderId?: string | null,
): Promise<DocumentInfo> {
  // Validate name
  if (!name || !name.trim()) {
    throw new Error('Document name cannot be empty')
  }
  if (name.length > 100) {
    throw new Error('Document name cannot exceed 100 characters')
  }

  const doc = new Y.Doc()
  const fragment = doc.getXmlFragment('default')

  if (content) {
    populateFragment(fragment, content)
  } else {
    prosemirrorJSONToYXmlFragment(schema, EMPTY_DOC_JSON, fragment)
  }

  const state = Buffer.from(Y.encodeStateAsUpdate(doc))
  const id = crypto.randomUUID()

  // Get workspace_id from project
  const projectRows = await withRLS(
    userId,
    sql => sql`SELECT workspace_id FROM projects WHERE id = ${projectId} AND deleted_at IS NULL LIMIT 1`
  )
  const workspaceId = (projectRows[0] as { workspace_id: string })?.workspace_id
  if (!workspaceId) throw new Error('Project not found')

  const rows = await withRLS(
    userId,
    sql =>
      sql`INSERT INTO documents (id, project_id, workspace_id, folder_id, name, yjs_state, created_by)
        VALUES (${id}, ${projectId}, ${workspaceId}, ${folderId ?? null}, ${name.trim()}, ${state}, ${userId})
        RETURNING id, project_id, workspace_id, folder_id, name, created_by, created_at, updated_at`,
  )
  const info = rows[0] as DocumentInfo

  doc.on('update', () => debouncedPersist(userId, projectId, id, doc))
  docs.set(cacheKey(projectId, id), doc)

  return info
}

/**
 * Delete a document.
 */
export async function deleteDoc(
  userId: string,
  projectId: string,
  id: string,
): Promise<boolean> {
  const key = cacheKey(projectId, id)
  const doc = docs.get(key)
  if (doc) {
    doc.destroy()
    docs.delete(key)
  }

  // Cancel any pending persist
  cancelPendingPersist(projectId, id)

  const result = await withRLS(
    userId,
    sql =>
      sql`DELETE FROM documents WHERE id = ${id} AND project_id = ${projectId} RETURNING id`,
  )
  return result.length > 0
}

/**
 * List documents in a project, optionally filtered by folder.
 * @param folderId - If undefined, returns all documents. If null, returns root-level docs. If string, returns docs in that folder.
 */
export async function listDocs(
  userId: string,
  projectId: string,
  folderId?: string | null,
): Promise<DocumentInfo[]> {
  if (folderId === undefined) {
    // All documents in project
    const rows = await withRLS(
      userId,
      sql =>
        sql`SELECT id, project_id, workspace_id, folder_id, name, created_by, created_at, updated_at
          FROM documents
          WHERE project_id = ${projectId} AND deleted_at IS NULL
          ORDER BY updated_at DESC`,
    )
    return rows as unknown as DocumentInfo[]
  }

  // Documents in specific folder (null = root)
  if (folderId === null) {
    const rows = await withRLS(
      userId,
      sql =>
        sql`SELECT id, project_id, workspace_id, folder_id, name, created_by, created_at, updated_at
          FROM documents
          WHERE project_id = ${projectId} AND folder_id IS NULL AND deleted_at IS NULL
          ORDER BY name ASC`,
    )
    return rows as unknown as DocumentInfo[]
  }

  const rows = await withRLS(
    userId,
    sql =>
      sql`SELECT id, project_id, workspace_id, folder_id, name, created_by, created_at, updated_at
        FROM documents
        WHERE project_id = ${projectId} AND folder_id = ${folderId} AND deleted_at IS NULL
        ORDER BY name ASC`,
  )
  return rows as unknown as DocumentInfo[]
}

export type ListDocsPageOptions = {
  /** undefined = all docs, null = root docs, string = docs in that folder */
  folderId?: string | null
  /** default 50 */
  limit?: number
  /** default 0 */
  offset?: number
}

/**
 * Paginated document listing for large projects / AI tools.
 * Returns the current page plus a total count for pagination.
 */
export async function listDocsPage(
  userId: string,
  projectId: string,
  options: ListDocsPageOptions = {},
): Promise<{ documents: DocumentInfo[]; total: number }> {
  const { folderId, limit = 50, offset = 0 } = options

  // Total count (exclude soft-deleted)
  const countRows = await withRLS(userId, (sql) =>
    folderId === undefined
      ? sql`SELECT COUNT(*)::int as count
            FROM documents
            WHERE project_id = ${projectId} AND deleted_at IS NULL`
      : folderId === null
        ? sql`SELECT COUNT(*)::int as count
              FROM documents
              WHERE project_id = ${projectId} AND folder_id IS NULL AND deleted_at IS NULL`
        : sql`SELECT COUNT(*)::int as count
              FROM documents
              WHERE project_id = ${projectId} AND folder_id = ${folderId} AND deleted_at IS NULL`,
  )
  const total = (countRows[0] as { count: number } | undefined)?.count ?? 0

  // Paged rows
  const rows = await withRLS(userId, (sql) =>
    folderId === undefined
      ? sql`SELECT id, project_id, workspace_id, folder_id, name, created_by, created_at, updated_at
            FROM documents
            WHERE project_id = ${projectId} AND deleted_at IS NULL
            ORDER BY updated_at DESC, id DESC
            LIMIT ${limit} OFFSET ${offset}`
      : folderId === null
        ? sql`SELECT id, project_id, workspace_id, folder_id, name, created_by, created_at, updated_at
              FROM documents
              WHERE project_id = ${projectId} AND folder_id IS NULL AND deleted_at IS NULL
              ORDER BY name ASC, id ASC
              LIMIT ${limit} OFFSET ${offset}`
        : sql`SELECT id, project_id, workspace_id, folder_id, name, created_by, created_at, updated_at
              FROM documents
              WHERE project_id = ${projectId} AND folder_id = ${folderId} AND deleted_at IS NULL
              ORDER BY name ASC, id ASC
              LIMIT ${limit} OFFSET ${offset}`,
  )

  return { documents: rows as unknown as DocumentInfo[], total }
}

function escapeLikePattern(input: string): string {
  // Escape LIKE wildcards. We use backslash as the escape character.
  return input.replace(/[%_\\\\]/g, '\\\\$&')
}

/**
 * Search documents by name within a project (case-insensitive).
 */
export async function searchDocs(
  userId: string,
  projectId: string,
  query: string,
  limit: number = 20,
): Promise<DocumentInfo[]> {
  const q = query.trim()
  if (!q) return []

  const safeLimit = Math.min(Math.max(limit, 1), 100)
  const pattern = `%${escapeLikePattern(q)}%`

  const rows = await withRLS(userId, (sql) =>
    sql`SELECT id, project_id, workspace_id, folder_id, name, created_by, created_at, updated_at
        FROM documents
        WHERE project_id = ${projectId}
          AND deleted_at IS NULL
          AND name ILIKE ${pattern} ESCAPE '\\'
        ORDER BY
          CASE WHEN lower(name) = lower(${q}) THEN 0 ELSE 1 END,
          updated_at DESC,
          id DESC
        LIMIT ${safeLimit}`,
  )
  return rows as unknown as DocumentInfo[]
}

/**
 * Read document content as markdown string.
 * Converts the Y.XmlFragment to ProseMirror JSON, then to markdown.
 */
export async function readDocAsText(
  userId: string,
  projectId: string,
  id: string,
): Promise<{ name: string; content: string } | null> {
  const doc = await getDoc(userId, projectId, id)
  if (!doc) return null

  // Get the name from DB
  const rows = await withRLS(
    userId,
    sql =>
      sql`SELECT name FROM documents WHERE id = ${id} AND project_id = ${projectId} AND deleted_at IS NULL LIMIT 1`,
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
/**
 * Normalize whitespace for fuzzy matching: collapse runs of whitespace to single space.
 */
function normalizeWhitespace(text: string): string {
  return text.replace(/\s+/g, ' ').trim()
}

/**
 * Find oldText in content with whitespace-normalized matching.
 * Returns the actual substring in content that matches, or null if not found.
 */
function findNormalizedMatch(content: string, oldText: string): { start: number; end: number } | null {
  // First try exact match
  const exactIndex = content.indexOf(oldText)
  if (exactIndex !== -1) {
    return { start: exactIndex, end: exactIndex + oldText.length }
  }

  // Try whitespace-normalized matching
  const normalizedOld = normalizeWhitespace(oldText)
  if (!normalizedOld) return null

  // Slide a window through content to find a normalized match
  // This is O(n*m) but documents are small enough for it to be fine
  for (let start = 0; start < content.length; start++) {
    for (let end = start + 1; end <= content.length; end++) {
      const chunk = content.slice(start, end)
      if (normalizeWhitespace(chunk) === normalizedOld) {
        return { start, end }
      }
      // Early exit: if normalized chunk is already longer than target, move on
      if (normalizeWhitespace(chunk).length > normalizedOld.length) {
        break
      }
    }
  }

  return null
}

export async function editDoc(
  userId: string,
  projectId: string,
  id: string,
  oldText: string,
  newText: string,
): Promise<boolean> {
  const doc = await getDoc(userId, projectId, id)
  if (!doc) throw new Error(`Document ${id} not found`)

  const fragment = doc.getXmlFragment('default')
  const content = fragmentToMarkdown(fragment)
  const match = findNormalizedMatch(content, oldText)
  if (!match) return false

  const edited =
    content.slice(0, match.start) + newText + content.slice(match.end)

  doc.transact(() => {
    // Clear existing content
    while (fragment.length > 0) {
      fragment.delete(0, 1)
    }
    // Populate with edited markdown
    populateFragment(fragment, edited)
  })

  cancelPendingPersist(projectId, id)
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
  projectId: string,
  id: string,
  content: string,
): Promise<void> {
  const doc = await getDoc(userId, projectId, id)
  if (!doc) throw new Error(`Document ${id} not found`)

  const fragment = doc.getXmlFragment('default')

  // Get current content as markdown, append with proper separator, and replace
  const current = fragmentToMarkdown(fragment)
  // Ensure there's a blank line between existing content and appended content
  const separator = current.endsWith('\n\n') ? '' : current.endsWith('\n') ? '\n' : '\n\n'
  const combined = current + separator + content

  doc.transact(() => {
    while (fragment.length > 0) {
      fragment.delete(0, 1)
    }
    populateFragment(fragment, combined)
  })

  cancelPendingPersist(projectId, id)
  await persistDoc(userId, id, doc)
}

/**
 * Replace a document's entire content with new markdown.
 * Clears the XmlFragment and re-populates from the new markdown.
 */
export async function replaceDocContent(
  userId: string,
  projectId: string,
  id: string,
  markdown: string,
): Promise<void> {
  const doc = await getDoc(userId, projectId, id)
  if (!doc) throw new Error(`Document ${id} not found`)

  const fragment = doc.getXmlFragment('default')

  doc.transact(() => {
    while (fragment.length > 0) {
      fragment.delete(0, 1)
    }
    populateFragment(fragment, markdown)
  })

  cancelPendingPersist(projectId, id)
  await persistDoc(userId, id, doc)
}

/**
 * Update a document's name in the database.
 */
export async function renameDoc(
  userId: string,
  projectId: string,
  id: string,
  name: string,
): Promise<void> {
  await withRLS(
    userId,
    sql =>
      sql`UPDATE documents SET name = ${name}, updated_at = now()
        WHERE id = ${id} AND project_id = ${projectId}`,
  )
}

/**
 * Move a document to a different folder.
 */
export async function moveDoc(
  userId: string,
  projectId: string,
  id: string,
  folderId: string | null,
): Promise<void> {
  await withRLS(
    userId,
    sql =>
      sql`UPDATE documents SET folder_id = ${folderId}, updated_at = now()
        WHERE id = ${id} AND project_id = ${projectId}`,
  )
}

/**
 * Persist a document's current state to Supabase (debounced).
 */
function debouncedPersist(userId: string, projectId: string, id: string, doc: Y.Doc): void {
  const key = cacheKey(projectId, id)
  const existing = persistTimers.get(key)
  if (existing) clearTimeout(existing)

  persistTimers.set(
    key,
    setTimeout(async () => {
      persistTimers.delete(key)
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
  projectId: string,
  id: string,
): Promise<DocumentInfo | null> {
  const rows = await withRLS(
    userId,
    sql =>
      sql`SELECT id, project_id, workspace_id, folder_id, name, created_by, created_at, updated_at
        FROM documents
        WHERE id = ${id} AND project_id = ${projectId} AND deleted_at IS NULL
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
  for (const [key, timer] of persistTimers) {
    clearTimeout(timer)
    persistTimers.delete(key)
    const doc = docs.get(key)
    if (doc) {
      // Extract docId from the cache key (format: projectId:docId)
      const parts = key.split(':')
      const docId = parts[1]
      if (docId) {
        promises.push(persistDoc(userId, docId, doc))
      }
    }
  }
  await Promise.all(promises)
}
