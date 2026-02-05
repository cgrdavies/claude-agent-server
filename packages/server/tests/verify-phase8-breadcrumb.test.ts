/**
 * Manual verification for Phase 8: Breadcrumb in Document Responses
 *
 * Run with: bun test packages/server/tests/verify-phase8-breadcrumb.test.ts --env-file=.env.test
 */

import { describe, test, expect, beforeAll, afterAll } from 'bun:test'
import {
  setupTestEnvironment,
  resetAgentTables,
  closeTestConnections,
} from './setup'
import { createTestContext, type TestContext } from './helpers/auth'
import { withAuth } from './helpers/api'

// Set up test environment
setupTestEnvironment()

describe('Phase 8: Breadcrumb in Document Responses', () => {
  let ctx: TestContext
  let api: ReturnType<typeof withAuth>

  beforeAll(async () => {
    await resetAgentTables()
    ctx = await createTestContext()
    api = withAuth(ctx.token, ctx.workspace.id)
  })

  afterAll(async () => {
    await closeTestConnections()
  })

  test('1. Document at root has breadcrumb with just the document', async () => {
    // Create a document at root (no folder_id)
    const createRes = await api.post<{ document: { id: string } }>('/api/documents', {
      body: {
        name: 'Root Document',
        content: '# Root Document\n\nThis is at the project root.',
        project_id: ctx.project.id,
      },
    })
    expect(createRes.status).toBe(201)
    const docId = createRes.data.document.id

    // Get the document and check breadcrumb
    const getRes = await api.get<{
      document: {
        id: string
        name: string
        breadcrumb: Array<{ id: string; name: string; type: string }>
      }
    }>(`/api/documents/${docId}?project_id=${ctx.project.id}`)

    expect(getRes.status).toBe(200)
    console.log('\n=== Document at ROOT ===')
    console.log('Document name:', getRes.data.document.name)
    console.log('Breadcrumb:', JSON.stringify(getRes.data.document.breadcrumb, null, 2))

    // Verify breadcrumb has just the document
    expect(getRes.data.document.breadcrumb).toHaveLength(1)
    expect(getRes.data.document.breadcrumb[0]).toEqual({
      id: docId,
      name: 'Root Document',
      type: 'document',
    })
  })

  test('2. Document in folder has breadcrumb with folder path', async () => {
    // Create a folder
    const folderRes = await api.post<{ folder: { id: string; name: string } }>(
      `/api/projects/${ctx.project.id}/folders`,
      { body: { name: 'Design' } }
    )
    expect(folderRes.status).toBe(201)
    const folderId = folderRes.data.folder.id
    console.log('\n=== Created folder: Design ===')

    // Create a document in the folder
    const createRes = await api.post<{ document: { id: string } }>('/api/documents', {
      body: {
        name: 'Spec Document',
        content: '# Spec\n\nThis is in the Design folder.',
        project_id: ctx.project.id,
        folder_id: folderId,
      },
    })
    expect(createRes.status).toBe(201)
    const docId = createRes.data.document.id

    // Get the document and check breadcrumb
    const getRes = await api.get<{
      document: {
        id: string
        name: string
        folder_id: string
        breadcrumb: Array<{ id: string; name: string; type: string }>
      }
    }>(`/api/documents/${docId}?project_id=${ctx.project.id}`)

    expect(getRes.status).toBe(200)
    console.log('\n=== Document in FOLDER ===')
    console.log('Document name:', getRes.data.document.name)
    console.log('Document folder_id:', getRes.data.document.folder_id)
    console.log('Breadcrumb:', JSON.stringify(getRes.data.document.breadcrumb, null, 2))

    // Verify breadcrumb has folder + document
    expect(getRes.data.document.breadcrumb).toHaveLength(2)
    expect(getRes.data.document.breadcrumb[0]).toEqual({
      id: folderId,
      name: 'Design',
      type: 'folder',
    })
    expect(getRes.data.document.breadcrumb[1]).toEqual({
      id: docId,
      name: 'Spec Document',
      type: 'document',
    })
  })

  test('3. Document in nested folders has full breadcrumb path', async () => {
    // Create parent folder
    const parentRes = await api.post<{ folder: { id: string; name: string } }>(
      `/api/projects/${ctx.project.id}/folders`,
      { body: { name: 'Engineering' } }
    )
    expect(parentRes.status).toBe(201)
    const parentId = parentRes.data.folder.id
    console.log('\n=== Created folder: Engineering ===')

    // Create child folder
    const childRes = await api.post<{ folder: { id: string; name: string } }>(
      `/api/projects/${ctx.project.id}/folders`,
      { body: { name: 'Backend', parent_id: parentId } }
    )
    expect(childRes.status).toBe(201)
    const childId = childRes.data.folder.id
    console.log('=== Created folder: Engineering/Backend ===')

    // Create grandchild folder
    const grandchildRes = await api.post<{ folder: { id: string; name: string } }>(
      `/api/projects/${ctx.project.id}/folders`,
      { body: { name: 'API', parent_id: childId } }
    )
    expect(grandchildRes.status).toBe(201)
    const grandchildId = grandchildRes.data.folder.id
    console.log('=== Created folder: Engineering/Backend/API ===')

    // Create a document in the grandchild folder
    const createRes = await api.post<{ document: { id: string } }>('/api/documents', {
      body: {
        name: 'Endpoints Doc',
        content: '# API Endpoints\n\nThis is deep in the hierarchy.',
        project_id: ctx.project.id,
        folder_id: grandchildId,
      },
    })
    expect(createRes.status).toBe(201)
    const docId = createRes.data.document.id

    // Get the document and check breadcrumb
    const getRes = await api.get<{
      document: {
        id: string
        name: string
        breadcrumb: Array<{ id: string; name: string; type: string }>
      }
    }>(`/api/documents/${docId}?project_id=${ctx.project.id}`)

    expect(getRes.status).toBe(200)
    console.log('\n=== Document in NESTED FOLDERS (3 levels deep) ===')
    console.log('Document name:', getRes.data.document.name)
    console.log('Breadcrumb:', JSON.stringify(getRes.data.document.breadcrumb, null, 2))

    // Verify breadcrumb has all ancestors + document
    expect(getRes.data.document.breadcrumb).toHaveLength(4)
    expect(getRes.data.document.breadcrumb[0]).toEqual({
      id: parentId,
      name: 'Engineering',
      type: 'folder',
    })
    expect(getRes.data.document.breadcrumb[1]).toEqual({
      id: childId,
      name: 'Backend',
      type: 'folder',
    })
    expect(getRes.data.document.breadcrumb[2]).toEqual({
      id: grandchildId,
      name: 'API',
      type: 'folder',
    })
    expect(getRes.data.document.breadcrumb[3]).toEqual({
      id: docId,
      name: 'Endpoints Doc',
      type: 'document',
    })

    console.log('\n✅ Breadcrumb correctly shows: Engineering > Backend > API > Endpoints Doc')
  })
})
