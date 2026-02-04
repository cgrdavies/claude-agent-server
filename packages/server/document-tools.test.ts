import { test, expect, beforeEach } from 'bun:test'
import * as docManager from './document-manager'
import {
  docCreate,
  docRead,
  docEdit,
  docAppend,
  docList,
  docDelete,
} from './document-tools'

// Helper to parse the text content from a tool result
function parseResult(result: { content: { type: string; text: string }[] }) {
  return JSON.parse(result.content[0].text)
}

// Clean up between tests
beforeEach(() => {
  for (const doc of docManager.listDocs()) {
    docManager.deleteDoc(doc.id)
  }
})

// doc_create

test('doc_create creates a document and returns id + name', async () => {
  const result = await docCreate.handler({ name: 'My Doc', content: '# Hello' }, undefined)
  const data = parseResult(result)

  expect(data.id).toBeDefined()
  expect(data.name).toBe('My Doc')

  // Verify document actually exists
  const content = docManager.readDocAsText(data.id)
  expect(content).toBe('# Hello')
})

test('doc_create works without initial content', async () => {
  const result = await docCreate.handler({ name: 'Empty Doc' }, undefined)
  const data = parseResult(result)

  expect(data.id).toBeDefined()
  const content = docManager.readDocAsText(data.id)
  expect(content).toBe('')
})

// doc_read

test('doc_read returns document content', async () => {
  docManager.createDoc('read-test', 'Read Test', 'Some content here')

  const result = await docRead.handler({ id: 'read-test' }, undefined)
  const data = parseResult(result)

  expect(data.id).toBe('read-test')
  expect(data.name).toBe('Read Test')
  expect(data.content).toBe('Some content here')
  expect(result.isError).toBeUndefined()
})

test('doc_read returns isError for non-existent document', async () => {
  const result = await docRead.handler({ id: 'does-not-exist' }, undefined)
  const data = parseResult(result)

  expect(data.error).toBe('Document not found')
  expect(result.isError).toBe(true)
})

// doc_edit

test('doc_edit replaces matching text', async () => {
  docManager.createDoc('edit-test', 'Edit Test', 'Hello world, this is a test.')

  const result = await docEdit.handler({
    id: 'edit-test',
    old_text: 'Hello world',
    new_text: 'Goodbye world',
  }, undefined)
  const data = parseResult(result)

  expect(data.success).toBe(true)

  const content = docManager.readDocAsText('edit-test')
  expect(content).toBe('Goodbye world, this is a test.')
})

test('doc_edit returns success: false when old_text not found', async () => {
  docManager.createDoc('edit-miss', 'Edit Miss', 'Hello world')

  const result = await docEdit.handler({
    id: 'edit-miss',
    old_text: 'does not exist',
    new_text: 'replacement',
  }, undefined)
  const data = parseResult(result)

  expect(data.success).toBe(false)
  expect(data.error).toContain('not found')
})

test('doc_edit returns isError for non-existent document', async () => {
  const result = await docEdit.handler({
    id: 'no-such-doc',
    old_text: 'a',
    new_text: 'b',
  }, undefined)
  const data = parseResult(result)

  expect(data.error).toBeDefined()
  expect(result.isError).toBe(true)
})

// doc_append

test('doc_append adds content to end of document', async () => {
  docManager.createDoc('append-test', 'Append Test', 'Line 1')

  const result = await docAppend.handler({
    id: 'append-test',
    content: '\nLine 2',
  }, undefined)
  const data = parseResult(result)

  expect(data.success).toBe(true)

  const content = docManager.readDocAsText('append-test')
  expect(content).toBe('Line 1\nLine 2')
})

test('doc_append returns isError for non-existent document', async () => {
  const result = await docAppend.handler({
    id: 'no-such-doc',
    content: 'stuff',
  }, undefined)
  const data = parseResult(result)

  expect(data.error).toBeDefined()
  expect(result.isError).toBe(true)
})

// doc_list

test('doc_list returns empty list when no documents', async () => {
  const result = await docList.handler({}, undefined)
  const data = parseResult(result)

  expect(data.documents).toEqual([])
})

test('doc_list returns all documents', async () => {
  docManager.createDoc('list-1', 'Doc One', 'content')
  docManager.createDoc('list-2', 'Doc Two', 'content')

  const result = await docList.handler({}, undefined)
  const data = parseResult(result)

  expect(data.documents).toHaveLength(2)
  const names = data.documents.map((d: any) => d.name)
  expect(names).toContain('Doc One')
  expect(names).toContain('Doc Two')
})

// doc_delete

test('doc_delete removes a document', async () => {
  docManager.createDoc('del-test', 'Delete Me', 'bye')

  const result = await docDelete.handler({ id: 'del-test' }, undefined)
  const data = parseResult(result)
  expect(data.success).toBe(true)

  // Verify it's gone
  const content = docManager.readDocAsText('del-test')
  expect(content).toBeNull()
})

test('doc_delete on non-existent doc succeeds silently', async () => {
  const result = await docDelete.handler({ id: 'already-gone' }, undefined)
  const data = parseResult(result)
  expect(data.success).toBe(true)
})

// End-to-end flow

test('full workflow: create, read, edit, append, list, delete', async () => {
  // Create
  const createResult = await docCreate.handler({ name: 'Workflow Doc', content: '# Draft' }, undefined)
  const { id } = parseResult(createResult)

  // Read
  const readResult = await docRead.handler({ id }, undefined)
  expect(parseResult(readResult).content).toBe('# Draft')

  // Edit
  await docEdit.handler({ id, old_text: '# Draft', new_text: '# Final' }, undefined)
  const afterEdit = await docRead.handler({ id }, undefined)
  expect(parseResult(afterEdit).content).toBe('# Final')

  // Append
  await docAppend.handler({ id, content: '\n\nSome body text.' }, undefined)
  const afterAppend = await docRead.handler({ id }, undefined)
  expect(parseResult(afterAppend).content).toBe('# Final\n\nSome body text.')

  // List
  const listResult = await docList.handler({}, undefined)
  expect(parseResult(listResult).documents).toHaveLength(1)

  // Delete
  await docDelete.handler({ id }, undefined)
  const afterDelete = await docRead.handler({ id }, undefined)
  expect(afterDelete.isError).toBe(true)
})
