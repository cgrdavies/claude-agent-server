import { test, expect, beforeEach, afterAll } from 'bun:test'
import { Database } from 'bun:sqlite'
import { join } from 'path'
import { homedir } from 'os'
import { unlinkSync } from 'node:fs'

import { WORKSPACE_DIR_NAME } from './const'

// Import document manager functions
import * as docManager from './document-manager'

// Clean up documents between tests
beforeEach(() => {
  // Delete all documents from the database
  const docs = docManager.listDocs()
  for (const doc of docs) {
    docManager.deleteDoc(doc.id)
  }
})

test('createDoc creates a document with content', () => {
  const doc = docManager.createDoc('test-1', 'Test Doc', '# Hello World')
  expect(doc).toBeDefined()

  const content = docManager.readDocAsText('test-1')
  expect(content).toBe('# Hello World')
})

test('createDoc creates a document without content', () => {
  const doc = docManager.createDoc('test-2', 'Empty Doc')
  expect(doc).toBeDefined()

  const content = docManager.readDocAsText('test-2')
  expect(content).toBe('')
})

test('createDoc throws for duplicate IDs', () => {
  docManager.createDoc('dup-1', 'First')
  expect(() => docManager.createDoc('dup-1', 'Second')).toThrow('already exists')
})

test('readDocAsText returns null for non-existent document', () => {
  const content = docManager.readDocAsText('nonexistent')
  expect(content).toBeNull()
})

test('getDoc returns null for non-existent document', () => {
  const doc = docManager.getDoc('nonexistent')
  expect(doc).toBeNull()
})

test('editDoc performs find-and-replace', () => {
  docManager.createDoc('edit-1', 'Edit Test', 'Hello World, this is a test.')
  const success = docManager.editDoc('edit-1', 'World', 'Yjs')
  expect(success).toBe(true)

  const content = docManager.readDocAsText('edit-1')
  expect(content).toBe('Hello Yjs, this is a test.')
})

test('editDoc returns false when old text not found', () => {
  docManager.createDoc('edit-2', 'Edit Test', 'Hello World')
  const success = docManager.editDoc('edit-2', 'Nonexistent', 'Replacement')
  expect(success).toBe(false)

  const content = docManager.readDocAsText('edit-2')
  expect(content).toBe('Hello World')
})

test('editDoc throws for non-existent document', () => {
  expect(() => docManager.editDoc('nonexistent', 'a', 'b')).toThrow('not found')
})

test('appendDoc adds content to end', () => {
  docManager.createDoc('append-1', 'Append Test', 'Line 1')
  docManager.appendDoc('append-1', '\nLine 2')

  const content = docManager.readDocAsText('append-1')
  expect(content).toBe('Line 1\nLine 2')
})

test('appendDoc throws for non-existent document', () => {
  expect(() => docManager.appendDoc('nonexistent', 'content')).toThrow('not found')
})

test('deleteDoc removes from memory and database', () => {
  docManager.createDoc('del-1', 'Delete Me', 'content')
  expect(docManager.readDocAsText('del-1')).toBe('content')

  docManager.deleteDoc('del-1')

  expect(docManager.readDocAsText('del-1')).toBeNull()
  expect(docManager.getDocInfo('del-1')).toBeNull()
})

test('listDocs returns all documents', () => {
  docManager.createDoc('list-1', 'Doc A', 'content A')
  docManager.createDoc('list-2', 'Doc B', 'content B')
  docManager.createDoc('list-3', 'Doc C', 'content C')

  const docs = docManager.listDocs()
  expect(docs.length).toBe(3)

  const names = docs.map(d => d.name)
  expect(names).toContain('Doc A')
  expect(names).toContain('Doc B')
  expect(names).toContain('Doc C')
})

test('getDocInfo returns document metadata', () => {
  docManager.createDoc('info-1', 'Info Test', 'content')

  const info = docManager.getDocInfo('info-1')
  expect(info).not.toBeNull()
  expect(info!.id).toBe('info-1')
  expect(info!.name).toBe('Info Test')
  expect(info!.createdAt).toBeDefined()
  expect(info!.updatedAt).toBeDefined()
})

test('getDocInfo returns null for non-existent document', () => {
  const info = docManager.getDocInfo('nonexistent')
  expect(info).toBeNull()
})

test('document survives cache eviction (reloads from SQLite)', () => {
  docManager.createDoc('persist-1', 'Persist Test', '# Persistent Content')

  // Evict from cache
  docManager.clearCache()

  // Should reload from SQLite
  const content = docManager.readDocAsText('persist-1')
  expect(content).toBe('# Persistent Content')
})

test('edits persist after cache eviction', () => {
  docManager.createDoc('persist-2', 'Edit Persist', 'Original text')
  docManager.editDoc('persist-2', 'Original', 'Modified')

  // Evict from cache
  docManager.clearCache()

  // Should reload with edits from SQLite
  const content = docManager.readDocAsText('persist-2')
  expect(content).toBe('Modified text')
})

test('multiple sequential edits work correctly', () => {
  docManager.createDoc('multi-1', 'Multi Edit', 'A B C D')
  docManager.editDoc('multi-1', 'B', 'X')
  docManager.editDoc('multi-1', 'C', 'Y')
  docManager.editDoc('multi-1', 'D', 'Z')

  const content = docManager.readDocAsText('multi-1')
  expect(content).toBe('A X Y Z')
})

// --- Edge cases ---

test('editDoc only replaces first occurrence', () => {
  docManager.createDoc('first-only', 'First Only', 'hello hello hello')
  const success = docManager.editDoc('first-only', 'hello', 'goodbye')
  expect(success).toBe(true)

  const content = docManager.readDocAsText('first-only')
  expect(content).toBe('goodbye hello hello')
})

test('getDoc returns same cached Y.Doc instance on repeated calls', () => {
  docManager.createDoc('cache-1', 'Cache Test', 'content')

  const doc1 = docManager.getDoc('cache-1')
  const doc2 = docManager.getDoc('cache-1')
  expect(doc1).toBe(doc2) // same reference
})

test('edits after cache reload still persist to SQLite', () => {
  docManager.createDoc('reload-edit', 'Reload Edit', 'original')

  // Evict from cache
  docManager.clearCache()

  // Load from DB, edit, evict again
  docManager.editDoc('reload-edit', 'original', 'changed')
  docManager.clearCache()

  // Should still have the edit
  const content = docManager.readDocAsText('reload-edit')
  expect(content).toBe('changed')
})

test('deleteDoc works when doc is in DB but not in cache', () => {
  docManager.createDoc('db-only', 'DB Only', 'content')
  docManager.clearCache()

  // Doc is in DB but not in memory
  docManager.deleteDoc('db-only')

  expect(docManager.readDocAsText('db-only')).toBeNull()
  expect(docManager.getDocInfo('db-only')).toBeNull()
})

test('deleteDoc on non-existent doc does not throw', () => {
  expect(() => docManager.deleteDoc('never-existed')).not.toThrow()
})

test('createDoc duplicate check catches DB-only duplicates', () => {
  docManager.createDoc('dup-db', 'First', 'content')
  docManager.clearCache() // remove from memory, keep in DB

  expect(() => docManager.createDoc('dup-db', 'Second', 'other')).toThrow('already exists')
})

test('appendDoc to empty document', () => {
  docManager.createDoc('append-empty', 'Append Empty')
  docManager.appendDoc('append-empty', 'first content')

  const content = docManager.readDocAsText('append-empty')
  expect(content).toBe('first content')
})

test('editDoc with empty old_text matches at start', () => {
  docManager.createDoc('empty-match', 'Empty Match', 'hello')
  const success = docManager.editDoc('empty-match', '', 'prefix-')
  expect(success).toBe(true)

  const content = docManager.readDocAsText('empty-match')
  expect(content).toBe('prefix-hello')
})

test('editDoc replacing with empty string deletes text', () => {
  docManager.createDoc('del-text', 'Delete Text', 'hello world')
  const success = docManager.editDoc('del-text', ' world', '')
  expect(success).toBe(true)

  const content = docManager.readDocAsText('del-text')
  expect(content).toBe('hello')
})

test('document with special characters in content', () => {
  const special = '# Title\n\n```js\nconst x = "hello";\n```\n\n- bullet 1\n- bullet 2\n\n> blockquote'
  docManager.createDoc('special', 'Special Chars', special)

  const content = docManager.readDocAsText('special')
  expect(content).toBe(special)

  // Survives cache eviction
  docManager.clearCache()
  expect(docManager.readDocAsText('special')).toBe(special)
})

test('listDocs returns empty array when no documents', () => {
  const docs = docManager.listDocs()
  expect(docs).toEqual([])
})

test('rapid edits all persist correctly', () => {
  docManager.createDoc('rapid', 'Rapid', 'word1 word2 word3 word4 word5')
  docManager.editDoc('rapid', 'word1', 'a')
  docManager.editDoc('rapid', 'word2', 'b')
  docManager.editDoc('rapid', 'word3', 'c')
  docManager.editDoc('rapid', 'word4', 'd')
  docManager.editDoc('rapid', 'word5', 'e')

  expect(docManager.readDocAsText('rapid')).toBe('a b c d e')

  // Verify persisted
  docManager.clearCache()
  expect(docManager.readDocAsText('rapid')).toBe('a b c d e')
})
