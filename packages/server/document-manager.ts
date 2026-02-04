import * as Y from 'yjs'
import { getSchema } from '@tiptap/core'
import StarterKit from '@tiptap/starter-kit'
import { Markdown, MarkdownManager } from '@tiptap/markdown'
import { renderToMarkdown } from '@tiptap/static-renderer/pm/markdown'
import {
  prosemirrorJSONToYXmlFragment,
  yXmlFragmentToProsemirrorJSON,
} from 'y-prosemirror'

import db from './db'

export type DocumentInfo = {
  id: string
  name: string
  createdAt: string
  updatedAt: string
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

/**
 * Get or load a Y.Doc from cache/database.
 * Returns null if document doesn't exist.
 */
export function getDoc(id: string): Y.Doc | null {
  if (docs.has(id)) return docs.get(id)!

  const row = db.query('SELECT state FROM documents WHERE id = ?').get(id) as
    | { state: Buffer }
    | null
  if (!row) return null

  const doc = new Y.Doc()
  Y.applyUpdate(doc, new Uint8Array(row.state))

  // Listen for updates and persist
  doc.on('update', () => persistDoc(id, doc))

  docs.set(id, doc)
  return doc
}

/**
 * Create a new document with optional initial markdown content.
 * Stores content as a Y.XmlFragment('default') containing ProseMirror nodes.
 */
export function createDoc(
  id: string,
  name: string,
  content?: string,
): Y.Doc {
  if (docs.has(id)) throw new Error(`Document ${id} already exists`)

  const existing = db.query('SELECT id FROM documents WHERE id = ?').get(id)
  if (existing) throw new Error(`Document ${id} already exists`)

  const doc = new Y.Doc()
  const fragment = doc.getXmlFragment('default')

  if (content) {
    populateFragment(fragment, content)
  } else {
    prosemirrorJSONToYXmlFragment(schema, EMPTY_DOC_JSON, fragment)
  }

  const state = Y.encodeStateAsUpdate(doc)
  db.query(
    'INSERT INTO documents (id, name, state) VALUES (?, ?, ?)',
  ).run(id, name, Buffer.from(state))

  doc.on('update', () => persistDoc(id, doc))
  docs.set(id, doc)

  return doc
}

/**
 * Delete a document.
 */
export function deleteDoc(id: string): void {
  const doc = docs.get(id)
  if (doc) {
    doc.destroy()
    docs.delete(id)
  }
  db.query('DELETE FROM documents WHERE id = ?').run(id)
}

/**
 * List all documents.
 */
export function listDocs(): DocumentInfo[] {
  const rows = db.query(
    'SELECT id, name, created_at as createdAt, updated_at as updatedAt FROM documents ORDER BY updated_at DESC',
  ).all() as DocumentInfo[]
  return rows
}

/**
 * Read document content as markdown string.
 * Converts the Y.XmlFragment to ProseMirror JSON, then to markdown.
 */
export function readDocAsText(id: string): string | null {
  const doc = getDoc(id)
  if (!doc) return null
  const fragment = doc.getXmlFragment('default')
  return fragmentToMarkdown(fragment)
}

/**
 * Apply a find-and-replace edit to a document.
 * Serializes XmlFragment to markdown, applies the text edit, then replaces
 * the fragment content atomically.
 * Returns true if the edit was applied, false if old_text was not found.
 */
export function editDoc(
  id: string,
  oldText: string,
  newText: string,
): boolean {
  const doc = getDoc(id)
  if (!doc) throw new Error(`Document ${id} not found`)

  const fragment = doc.getXmlFragment('default')
  const content = fragmentToMarkdown(fragment)
  const index = content.indexOf(oldText)
  if (index === -1) return false

  const edited = content.slice(0, index) + newText + content.slice(index + oldText.length)

  doc.transact(() => {
    // Clear existing content
    while (fragment.length > 0) {
      fragment.delete(0, 1)
    }
    // Populate with edited markdown
    populateFragment(fragment, edited)
  })

  return true
}

/**
 * Append markdown content to the end of a document.
 * Parses the appended markdown to ProseMirror nodes and appends them
 * to the existing XmlFragment.
 */
export function appendDoc(id: string, content: string): void {
  const doc = getDoc(id)
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
}

/**
 * Persist a document's current state to SQLite.
 */
function persistDoc(id: string, doc: Y.Doc): void {
  const state = Y.encodeStateAsUpdate(doc)
  db.query(
    "UPDATE documents SET state = ?, updated_at = datetime('now') WHERE id = ?",
  ).run(Buffer.from(state), id)
}

/**
 * Get a document's info without loading the full Y.Doc.
 */
export function getDocInfo(id: string): DocumentInfo | null {
  return db.query(
    'SELECT id, name, created_at as createdAt, updated_at as updatedAt FROM documents WHERE id = ?',
  ).get(id) as DocumentInfo | null
}

/**
 * Clear the in-memory document cache. Useful for testing persistence.
 */
export function clearCache(): void {
  docs.forEach(doc => doc.destroy())
  docs.clear()
}
