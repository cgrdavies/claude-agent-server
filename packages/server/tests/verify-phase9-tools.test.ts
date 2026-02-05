/**
 * Phase 9 Manual Verification: Agent Tools with Folder Support
 *
 * Tests that the document tools work correctly with folders.
 */
import { describe, test, expect, beforeAll, afterAll } from 'bun:test'
import { createDocumentTools } from '../tools/document-tools'
import { db } from '../lib/db'

describe('Phase 9: Agent Document Tools with Folder Support', () => {
  let projectId: string
  let workspaceId: string
  let userId: string
  let tools: ReturnType<typeof createDocumentTools>

  beforeAll(async () => {
    // Create test user and workspace via direct DB (bypassing RLS for setup)
    userId = crypto.randomUUID()
    workspaceId = crypto.randomUUID()
    projectId = crypto.randomUUID()

    await db`INSERT INTO auth.users (id, email) VALUES (${userId}, ${`test-phase9-${Date.now()}@test.com`})`
    await db`INSERT INTO workspaces (id, name, created_by) VALUES (${workspaceId}, 'Test Workspace', ${userId})`
    await db`INSERT INTO workspace_memberships (workspace_id, user_id, role) VALUES (${workspaceId}, ${userId}, 'owner')`
    await db`INSERT INTO projects (id, workspace_id, name, created_by) VALUES (${projectId}, ${workspaceId}, 'Tool Test Project', ${userId})`

    // Create the tools instance
    tools = createDocumentTools(projectId, userId)
  })

  afterAll(async () => {
    // Cleanup - order matters due to foreign keys
    await db`DELETE FROM documents WHERE project_id = ${projectId}`
    await db`DELETE FROM folders WHERE project_id = ${projectId}`
    await db`DELETE FROM projects WHERE id = ${projectId}`
    await db`DELETE FROM workspace_memberships WHERE workspace_id = ${workspaceId}`
    await db`DELETE FROM workspaces WHERE id = ${workspaceId}`
    // Note: Can't delete auth.users due to FK constraints with public.users - this is fine for tests
  })

  test('folder_create: can create folder at root', async () => {
    const result = await tools.folder_create.execute(
      { name: 'Design' },
      { toolCallId: 'test', messages: [], abortSignal: new AbortController().signal }
    )

    console.log('folder_create result:', result)
    expect(result.id).toBeDefined()
    expect(result.name).toBe('Design')
    expect(result.parent_id).toBeNull()
  })

  test('folder_create: can create nested folder', async () => {
    // First create parent
    const parent = await tools.folder_create.execute(
      { name: 'Engineering' },
      { toolCallId: 'test', messages: [], abortSignal: new AbortController().signal }
    )

    // Then create child
    const child = await tools.folder_create.execute(
      { name: 'Backend', parent_id: parent.id },
      { toolCallId: 'test', messages: [], abortSignal: new AbortController().signal }
    )

    console.log('nested folder_create result:', child)
    expect(child.id).toBeDefined()
    expect(child.name).toBe('Backend')
    expect(child.parent_id).toBe(parent.id)
  })

  test('folder_list: can list all folders', async () => {
    const result = await tools.folder_list.execute(
      {},
      { toolCallId: 'test', messages: [], abortSignal: new AbortController().signal }
    )

    console.log('folder_list result:', result)
    expect(result.folders).toBeArray()
    expect(result.folders.length).toBeGreaterThanOrEqual(2) // Design, Engineering, Backend
  })

  test('doc_create: can create document in folder', async () => {
    // Get the Design folder
    const folders = await tools.folder_list.execute(
      {},
      { toolCallId: 'test', messages: [], abortSignal: new AbortController().signal }
    )
    const designFolder = folders.folders.find(f => f.name === 'Design')
    expect(designFolder).toBeDefined()

    // Create document in folder
    const result = await tools.doc_create.execute(
      { name: 'Spec Document', content: '# Spec\n\nThis is a spec.', folder_id: designFolder!.id },
      { toolCallId: 'test', messages: [], abortSignal: new AbortController().signal }
    )

    console.log('doc_create in folder result:', result)
    expect(result.id).toBeDefined()
    expect(result.name).toBe('Spec Document')
    expect(result.folder_id).toBe(designFolder!.id)
  })

  test('doc_create: can create document at root', async () => {
    const result = await tools.doc_create.execute(
      { name: 'Root Document', content: '# Root\n\nAt the root.' },
      { toolCallId: 'test', messages: [], abortSignal: new AbortController().signal }
    )

    console.log('doc_create at root result:', result)
    expect(result.id).toBeDefined()
    expect(result.name).toBe('Root Document')
    expect(result.folder_id).toBeNull()
  })

  test('doc_list: can list documents with folder info', async () => {
    const result = await tools.doc_list.execute(
      {},
      { toolCallId: 'test', messages: [], abortSignal: new AbortController().signal }
    )

    console.log('doc_list result:', result)
    expect(result.documents).toBeArray()
    expect(result.documents.length).toBeGreaterThanOrEqual(2)

    // Check that folder_id is included
    const specDoc = result.documents.find(d => d.name === 'Spec Document')
    const rootDoc = result.documents.find(d => d.name === 'Root Document')
    expect(specDoc).toBeDefined()
    expect(rootDoc).toBeDefined()
    expect(specDoc!.folder_id).not.toBeNull()
    expect(rootDoc!.folder_id).toBeNull()
  })

  test('doc_move: can move document to different folder', async () => {
    // Get folders and docs
    const folders = await tools.folder_list.execute(
      {},
      { toolCallId: 'test', messages: [], abortSignal: new AbortController().signal }
    )
    const docs = await tools.doc_list.execute(
      {},
      { toolCallId: 'test', messages: [], abortSignal: new AbortController().signal }
    )

    const engineeringFolder = folders.folders.find(f => f.name === 'Engineering')
    const rootDoc = docs.documents.find(d => d.name === 'Root Document')
    expect(engineeringFolder).toBeDefined()
    expect(rootDoc).toBeDefined()

    // Move root doc to Engineering folder
    const moveResult = await tools.doc_move.execute(
      { id: rootDoc!.id, folder_id: engineeringFolder!.id },
      { toolCallId: 'test', messages: [], abortSignal: new AbortController().signal }
    )

    console.log('doc_move result:', moveResult)
    expect(moveResult.success).toBe(true)

    // Verify the move
    const updatedDocs = await tools.doc_list.execute(
      {},
      { toolCallId: 'test', messages: [], abortSignal: new AbortController().signal }
    )
    const movedDoc = updatedDocs.documents.find(d => d.name === 'Root Document')
    expect(movedDoc!.folder_id).toBe(engineeringFolder!.id)
  })

  test('doc_move: can move document to root (null folder)', async () => {
    // Get docs
    const docs = await tools.doc_list.execute(
      {},
      { toolCallId: 'test', messages: [], abortSignal: new AbortController().signal }
    )
    const movedDoc = docs.documents.find(d => d.name === 'Root Document')
    expect(movedDoc).toBeDefined()

    // Move back to root
    const moveResult = await tools.doc_move.execute(
      { id: movedDoc!.id, folder_id: null },
      { toolCallId: 'test', messages: [], abortSignal: new AbortController().signal }
    )

    console.log('doc_move to root result:', moveResult)
    expect(moveResult.success).toBe(true)

    // Verify
    const updatedDocs = await tools.doc_list.execute(
      {},
      { toolCallId: 'test', messages: [], abortSignal: new AbortController().signal }
    )
    const backAtRoot = updatedDocs.documents.find(d => d.name === 'Root Document')
    expect(backAtRoot!.folder_id).toBeNull()
  })
})
