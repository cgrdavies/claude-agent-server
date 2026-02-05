/**
 * Manual verification script for Phase 5: Document Routes Updates
 *
 * Run with: bun test tests/verify-phase5.ts
 */

import { describe, test, expect, beforeAll, afterAll } from 'bun:test'
import {
  setupTestEnvironment,
  resetAgentTables,
  closeTestConnections,
  getTestDb,
} from './setup'
import { createTestContext, type TestContext } from './helpers/auth'
import { withAuth } from './helpers/api'

// Set up test environment
setupTestEnvironment()

describe('Phase 5 Manual Verification: Document Routes with project_id', () => {
  let ctx: TestContext
  let api: ReturnType<typeof withAuth>
  let projectId: string

  beforeAll(async () => {
    await resetAgentTables()
    ctx = await createTestContext()
    api = withAuth(ctx.token, ctx.workspace.id)

    // Create a project directly in DB (bypasses org-based RLS for project creation)
    const db = getTestDb()
    const [project] = await db`
      INSERT INTO projects (workspace_id, name, description, created_by)
      VALUES (${ctx.workspace.id}, 'Test Project', 'For document tests', ${ctx.user.id})
      RETURNING id
    `
    projectId = project.id
    console.log(`Created project: ${projectId}`)
  })

  afterAll(async () => {
    await closeTestConnections()
  })

  test('1. POST /api/documents with project_id creates document', async () => {
    const res = await api.post<{ document: { id: string; project_id: string; name: string } }>('/api/documents', {
      body: {
        name: 'Test Document',
        content: '# Hello World',
        project_id: projectId
      },
    })

    console.log('POST /api/documents response:', res.status, JSON.stringify(res.data, null, 2))

    expect(res.status).toBe(201)
    expect(res.data.document.project_id).toBe(projectId)
    expect(res.data.document.name).toBe('Test Document')
  })

  test('2. GET /api/documents?project_id=xxx lists documents in project', async () => {
    // Create another document first
    await api.post('/api/documents', {
      body: { name: 'Second Doc', project_id: projectId },
    })

    const res = await api.get<{ documents: Array<{ id: string; name: string; project_id: string }> }>(
      `/api/documents?project_id=${projectId}`
    )

    console.log('GET /api/documents response:', res.status, JSON.stringify(res.data, null, 2))

    expect(res.status).toBe(200)
    expect(res.data.documents.length).toBeGreaterThanOrEqual(2)
    expect(res.data.documents.every(d => d.project_id === projectId)).toBe(true)
  })

  test('3. GET /api/documents/:id?project_id=xxx returns document with content', async () => {
    // Create a document with content
    const createRes = await api.post<{ document: { id: string } }>('/api/documents', {
      body: {
        name: 'Content Test',
        content: '# Test Content\n\nThis is a test.',
        project_id: projectId
      },
    })
    const docId = createRes.data.document.id

    const res = await api.get<{ document: { id: string; name: string; content: string; project_id: string } }>(
      `/api/documents/${docId}?project_id=${projectId}`
    )

    console.log('GET /api/documents/:id response:', res.status, JSON.stringify(res.data, null, 2))

    expect(res.status).toBe(200)
    expect(res.data.document.id).toBe(docId)
    expect(res.data.document.project_id).toBe(projectId)
    expect(res.data.document.content).toContain('Test Content')
  })

  test('4. PATCH /api/documents/:id with project_id updates document', async () => {
    // Create a document
    const createRes = await api.post<{ document: { id: string } }>('/api/documents', {
      body: { name: 'Update Test', project_id: projectId },
    })
    const docId = createRes.data.document.id

    const res = await api.patch<{ document: { id: string; name: string } }>(
      `/api/documents/${docId}`,
      { body: { name: 'Updated Name', project_id: projectId } }
    )

    console.log('PATCH /api/documents/:id response:', res.status, JSON.stringify(res.data, null, 2))

    expect(res.status).toBe(200)
    expect(res.data.document.name).toBe('Updated Name')
  })

  test('5. DELETE /api/documents/:id?project_id=xxx deletes document', async () => {
    // Create a document to delete
    const createRes = await api.post<{ document: { id: string } }>('/api/documents', {
      body: { name: 'Delete Me', project_id: projectId },
    })
    const docId = createRes.data.document.id

    const res = await api.del<{ success: boolean }>(
      `/api/documents/${docId}?project_id=${projectId}`
    )

    console.log('DELETE /api/documents/:id response:', res.status, JSON.stringify(res.data, null, 2))

    expect(res.status).toBe(200)
    expect(res.data.success).toBe(true)

    // Verify it's gone
    const getRes = await api.get(`/api/documents/${docId}?project_id=${projectId}`)
    expect(getRes.status).toBe(404)
  })

  test('6. Requests without project_id return 400 error', async () => {
    // POST without project_id
    const postRes = await api.post('/api/documents', {
      body: { name: 'No Project' },
    })
    console.log('POST without project_id:', postRes.status, JSON.stringify(postRes.data, null, 2))
    expect(postRes.status).toBe(400)
    expect(postRes.data).toMatchObject({ error: 'project_id is required' })

    // GET list without project_id
    const getListRes = await api.get('/api/documents')
    console.log('GET list without project_id:', getListRes.status, JSON.stringify(getListRes.data, null, 2))
    expect(getListRes.status).toBe(400)
    expect(getListRes.data).toMatchObject({ error: 'project_id query parameter is required' })

    // GET single without project_id
    const getRes = await api.get('/api/documents/some-id')
    console.log('GET single without project_id:', getRes.status, JSON.stringify(getRes.data, null, 2))
    expect(getRes.status).toBe(400)
    expect(getRes.data).toMatchObject({ error: 'project_id query parameter is required' })

    // PATCH without project_id
    const patchRes = await api.patch('/api/documents/some-id', {
      body: { name: 'New Name' },
    })
    console.log('PATCH without project_id:', patchRes.status, JSON.stringify(patchRes.data, null, 2))
    expect(patchRes.status).toBe(400)
    expect(patchRes.data).toMatchObject({ error: 'project_id is required' })

    // DELETE without project_id
    const delRes = await api.del('/api/documents/some-id')
    console.log('DELETE without project_id:', delRes.status, JSON.stringify(delRes.data, null, 2))
    expect(delRes.status).toBe(400)
    expect(delRes.data).toMatchObject({ error: 'project_id query parameter is required' })
  })
})
