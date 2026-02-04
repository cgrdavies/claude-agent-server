import * as Y from 'yjs'

import db from './db'

export type DocumentInfo = {
  id: string
  name: string
  createdAt: string
  updatedAt: string
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

  if (content) {
    const ytext = doc.getText('default')
    ytext.insert(0, content)
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
 */
export function readDocAsText(id: string): string | null {
  const doc = getDoc(id)
  if (!doc) return null
  return doc.getText('default').toString()
}

/**
 * Apply a find-and-replace edit to a document.
 * Returns true if the edit was applied, false if old_text was not found.
 */
export function editDoc(
  id: string,
  oldText: string,
  newText: string,
): boolean {
  const doc = getDoc(id)
  if (!doc) throw new Error(`Document ${id} not found`)

  const ytext = doc.getText('default')
  const content = ytext.toString()
  const index = content.indexOf(oldText)
  if (index === -1) return false

  doc.transact(() => {
    ytext.delete(index, oldText.length)
    ytext.insert(index, newText)
  })

  return true
}

/**
 * Append text to the end of a document.
 */
export function appendDoc(id: string, content: string): void {
  const doc = getDoc(id)
  if (!doc) throw new Error(`Document ${id} not found`)

  const ytext = doc.getText('default')
  ytext.insert(ytext.length, content)
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
