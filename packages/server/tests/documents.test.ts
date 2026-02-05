/**
 * Documents API integration tests.
 *
 * Tests the /api/documents endpoints:
 * - POST /api/documents - Create document
 * - GET /api/documents - List documents
 * - GET /api/documents/:id - Get document with content
 * - PATCH /api/documents/:id - Update document
 * - DELETE /api/documents/:id - Delete document
 *
 * Also tests markdown conversion (content roundtrips correctly)
 * and AI tool integration (doc_list, doc_create, doc_read, doc_edit).
 */

import { describe, test, expect, beforeAll, beforeEach, afterAll, mock } from 'bun:test'
import {
  setupTestEnvironment,
  resetAgentTables,
  closeTestConnections,
  getTestDb,
} from './setup'
import {
  createTestContext,
  type TestContext,
} from './helpers/auth'
import { createMockModel, createToolCallingMock } from './helpers/ai-mock'

// Set up test environment before importing the app
setupTestEnvironment()

// Mock providers for tool tests
let mockModelResponse = 'Here are your documents.'
let mockToolCalls: Array<{ name: string; args: Record<string, unknown> }> = []

mock.module('../lib/providers', () => ({
  getModel: () => {
    if (mockToolCalls.length > 0) {
      return createToolCallingMock(mockToolCalls, {
        response: mockModelResponse,
        streaming: true,
      })
    }
    return createMockModel({
      response: mockModelResponse,
      streaming: true,
    })
  },
  DEFAULT_MODEL: 'mock-model',
  DEFAULT_PROVIDER: 'mock',
}))

// Import after setup
import { withAuth, readSSEEvents, apiRequest } from './helpers/api'
import type { StreamEvent } from '@claude-agent/shared'

// Dynamic import to avoid loading document-manager before env setup
async function getClearCache() {
  const { clearCache } = await import('../document-manager')
  return clearCache
}

describe('Documents API', () => {
  let ctx: TestContext
  let api: ReturnType<typeof withAuth>

  beforeAll(async () => {
    ctx = await createTestContext()
    api = withAuth(ctx.token, ctx.workspace.id)
  })

  beforeEach(async () => {
    await resetAgentTables()
    // Clear document cache to ensure fresh state
    const clearCache = await getClearCache()
    clearCache()
    // Reset mock defaults
    mockModelResponse = 'Here are your documents.'
    mockToolCalls = []
  })

  afterAll(async () => {
    await closeTestConnections()
  })

  // ==========================================================================
  // CRUD Operations
  // ==========================================================================

  describe('POST /api/documents', () => {
    test('creates a document with name only', async () => {
      const res = await api.post<{ document: Record<string, unknown> }>('/api/documents', {
        body: { name: 'My Document', project_id: ctx.project.id },
      })

      expect(res.status).toBe(201)
      expect(res.data.document).toMatchObject({
        id: expect.any(String),
        project_id: ctx.project.id,
        workspace_id: ctx.workspace.id,
        name: 'My Document',
        created_by: ctx.user.id,
        created_at: expect.any(String),
        updated_at: expect.any(String),
      })
    })

    test('creates a document with initial content', async () => {
      const res = await api.post<{ document: { id: string } }>('/api/documents', {
        body: {
          name: 'Test Doc',
          content: '# Hello World\n\nThis is a test.',
          project_id: ctx.project.id,
        },
      })

      expect(res.status).toBe(201)

      // Verify content was saved
      const getRes = await api.get<{ document: { content: string } }>(
        `/api/documents/${res.data.document.id}?project_id=${ctx.project.id}`
      )
      expect(getRes.data.document.content).toContain('Hello World')
      expect(getRes.data.document.content).toContain('This is a test')
    })

    test('requires authentication', async () => {
      const { post } = await import('./helpers/api')
      const res = await post('/api/documents', { body: { name: 'Test', project_id: ctx.project.id } })

      expect(res.status).toBe(401)
      expect(res.data).toMatchObject({ error: 'Missing authorization token' })
    })

    test('requires workspace_id', async () => {
      const { post } = await import('./helpers/api')
      const res = await post('/api/documents', {
        token: ctx.token,
        body: { name: 'Test', project_id: ctx.project.id },
      })

      expect(res.status).toBe(400)
      expect(res.data).toMatchObject({ error: 'Missing workspace_id' })
    })
  })

  describe('GET /api/documents', () => {
    test('returns empty list when no documents exist', async () => {
      const res = await api.get<{ documents: unknown[] }>(`/api/documents?project_id=${ctx.project.id}`)

      expect(res.status).toBe(200)
      expect(res.data.documents).toEqual([])
    })

    test('returns all documents in project', async () => {
      // Create three documents
      await api.post('/api/documents', { body: { name: 'Doc 1', project_id: ctx.project.id } })
      await api.post('/api/documents', { body: { name: 'Doc 2', project_id: ctx.project.id } })
      await api.post('/api/documents', { body: { name: 'Doc 3', project_id: ctx.project.id } })

      const res = await api.get<{ documents: Array<{ name: string }> }>(`/api/documents?project_id=${ctx.project.id}`)

      expect(res.status).toBe(200)
      expect(res.data.documents).toHaveLength(3)
      // Most recently updated first
      expect(res.data.documents.map(d => d.name)).toContain('Doc 1')
      expect(res.data.documents.map(d => d.name)).toContain('Doc 2')
      expect(res.data.documents.map(d => d.name)).toContain('Doc 3')
    })

    test('does not include documents from other projects', async () => {
      // Create a document in our project
      await api.post('/api/documents', { body: { name: 'My Doc', project_id: ctx.project.id } })

      // Create another workspace/project and document
      const otherCtx = await createTestContext({ workspaceName: 'Other Workspace' })
      const otherApi = withAuth(otherCtx.token, otherCtx.workspace.id)
      await otherApi.post('/api/documents', { body: { name: 'Other Doc', project_id: otherCtx.project.id } })

      // Our list should only show our document
      const res = await api.get<{ documents: Array<{ name: string }> }>(`/api/documents?project_id=${ctx.project.id}`)

      expect(res.data.documents).toHaveLength(1)
      expect(res.data.documents[0]!.name).toBe('My Doc')
    })
  })

  describe('GET /api/documents/:id', () => {
    test('returns document with content', async () => {
      const createRes = await api.post<{ document: { id: string } }>('/api/documents', {
        body: {
          name: 'My Doc',
          content: '# Title\n\nSome content here.',
          project_id: ctx.project.id,
        },
      })

      const res = await api.get<{ document: { name: string; content: string } }>(
        `/api/documents/${createRes.data.document.id}?project_id=${ctx.project.id}`
      )

      expect(res.status).toBe(200)
      expect(res.data.document.name).toBe('My Doc')
      expect(res.data.document.content).toContain('Title')
      expect(res.data.document.content).toContain('Some content here')
    })

    test('returns 404 for non-existent document', async () => {
      const res = await api.get(`/api/documents/00000000-0000-0000-0000-000000000000?project_id=${ctx.project.id}`)

      expect(res.status).toBe(404)
      expect(res.data).toMatchObject({ error: 'Document not found' })
    })

    test('returns 404 for document in different project', async () => {
      // Create another workspace/project and document
      const otherCtx = await createTestContext({ workspaceName: 'Other Workspace' })
      const otherApi = withAuth(otherCtx.token, otherCtx.workspace.id)

      const otherDoc = await otherApi.post<{ document: { id: string } }>('/api/documents', {
        body: { name: 'Secret Doc', project_id: otherCtx.project.id },
      })

      // Try to access from original project
      const res = await api.get(`/api/documents/${otherDoc.data.document.id}?project_id=${ctx.project.id}`)

      expect(res.status).toBe(404)
    })
  })

  describe('PATCH /api/documents/:id', () => {
    test('updates document name', async () => {
      const createRes = await api.post<{ document: { id: string } }>('/api/documents', {
        body: { name: 'Original Name', project_id: ctx.project.id },
      })

      const res = await api.patch<{ document: { name: string } }>(
        `/api/documents/${createRes.data.document.id}`,
        { body: { name: 'Updated Name', project_id: ctx.project.id } }
      )

      expect(res.status).toBe(200)
      expect(res.data.document.name).toBe('Updated Name')
    })

    test('updates document content', async () => {
      const createRes = await api.post<{ document: { id: string } }>('/api/documents', {
        body: { name: 'Test', content: 'Original content', project_id: ctx.project.id },
      })

      await api.patch(
        `/api/documents/${createRes.data.document.id}`,
        { body: { content: '# New Content\n\nCompletely replaced.', project_id: ctx.project.id } }
      )

      // Verify content was updated
      const getRes = await api.get<{ document: { content: string } }>(
        `/api/documents/${createRes.data.document.id}?project_id=${ctx.project.id}`
      )
      expect(getRes.data.document.content).toContain('New Content')
      expect(getRes.data.document.content).toContain('Completely replaced')
      expect(getRes.data.document.content).not.toContain('Original content')
    })

    test('updates both name and content', async () => {
      const createRes = await api.post<{ document: { id: string } }>('/api/documents', {
        body: { name: 'Original', content: 'Old content', project_id: ctx.project.id },
      })

      const res = await api.patch<{ document: { name: string } }>(
        `/api/documents/${createRes.data.document.id}`,
        { body: { name: 'New Name', content: 'New content', project_id: ctx.project.id } }
      )

      expect(res.data.document.name).toBe('New Name')

      const getRes = await api.get<{ document: { content: string } }>(
        `/api/documents/${createRes.data.document.id}?project_id=${ctx.project.id}`
      )
      expect(getRes.data.document.content).toContain('New content')
    })

    test('returns 404 for non-existent document', async () => {
      const res = await api.patch('/api/documents/00000000-0000-0000-0000-000000000000', {
        body: { name: 'New Name', project_id: ctx.project.id },
      })

      expect(res.status).toBe(404)
    })
  })

  describe('DELETE /api/documents/:id', () => {
    test('deletes a document', async () => {
      const createRes = await api.post<{ document: { id: string } }>('/api/documents', {
        body: { name: 'To Delete', project_id: ctx.project.id },
      })
      const docId = createRes.data.document.id

      const res = await api.del<{ success: boolean }>(`/api/documents/${docId}?project_id=${ctx.project.id}`)

      expect(res.status).toBe(200)
      expect(res.data.success).toBe(true)

      // Verify it's gone
      const getRes = await api.get(`/api/documents/${docId}?project_id=${ctx.project.id}`)
      expect(getRes.status).toBe(404)
    })

    test('returns 404 for non-existent document', async () => {
      const res = await api.del(`/api/documents/00000000-0000-0000-0000-000000000000?project_id=${ctx.project.id}`)

      expect(res.status).toBe(404)
    })

    test('cannot delete document from another project', async () => {
      // Create another workspace/project and document
      const otherCtx = await createTestContext({ workspaceName: 'Other Workspace' })
      const otherApi = withAuth(otherCtx.token, otherCtx.workspace.id)

      const otherDoc = await otherApi.post<{ document: { id: string } }>('/api/documents', {
        body: { name: 'Other Doc', project_id: otherCtx.project.id },
      })

      // Try to delete from original project
      const res = await api.del(`/api/documents/${otherDoc.data.document.id}?project_id=${ctx.project.id}`)

      expect(res.status).toBe(404)

      // Verify it still exists in the other project
      const getRes = await otherApi.get(`/api/documents/${otherDoc.data.document.id}?project_id=${otherCtx.project.id}`)
      expect(getRes.status).toBe(200)
    })
  })

  // ==========================================================================
  // Markdown Conversion
  // ==========================================================================

  describe('Markdown Conversion', () => {
    test('preserves simple markdown formatting', async () => {
      const content = `# Heading 1

## Heading 2

This is a paragraph with **bold** and *italic* text.

- List item 1
- List item 2
- List item 3`

      const createRes = await api.post<{ document: { id: string } }>('/api/documents', {
        body: { name: 'Markdown Test', content, project_id: ctx.project.id },
      })

      const getRes = await api.get<{ document: { content: string } }>(
        `/api/documents/${createRes.data.document.id}?project_id=${ctx.project.id}`
      )

      // Content should preserve major formatting elements
      expect(getRes.data.document.content).toContain('Heading 1')
      expect(getRes.data.document.content).toContain('Heading 2')
      expect(getRes.data.document.content).toContain('bold')
      expect(getRes.data.document.content).toContain('italic')
      expect(getRes.data.document.content).toContain('List item 1')
    })

    test('preserves code blocks', async () => {
      const content = `# Code Example

\`\`\`typescript
function hello() {
  console.log('world')
}
\`\`\`

Inline \`code\` also works.`

      const createRes = await api.post<{ document: { id: string } }>('/api/documents', {
        body: { name: 'Code Test', content, project_id: ctx.project.id },
      })

      const getRes = await api.get<{ document: { content: string } }>(
        `/api/documents/${createRes.data.document.id}?project_id=${ctx.project.id}`
      )

      expect(getRes.data.document.content).toContain('function hello')
      expect(getRes.data.document.content).toContain("console.log('world')")
    })

    test('handles empty document', async () => {
      const createRes = await api.post<{ document: { id: string } }>('/api/documents', {
        body: { name: 'Empty Doc', project_id: ctx.project.id },
      })

      const getRes = await api.get<{ document: { content: string } }>(
        `/api/documents/${createRes.data.document.id}?project_id=${ctx.project.id}`
      )

      // Empty doc should return empty or minimal content
      expect(getRes.status).toBe(200)
      expect(typeof getRes.data.document.content).toBe('string')
    })

    test('content survives update roundtrip', async () => {
      const initialContent = '# Original\n\nSome text.'
      const updatedContent = '# Updated\n\nNew text with **formatting**.'

      const createRes = await api.post<{ document: { id: string } }>('/api/documents', {
        body: { name: 'Roundtrip Test', content: initialContent, project_id: ctx.project.id },
      })
      const docId = createRes.data.document.id

      // Update content
      await api.patch(`/api/documents/${docId}`, { body: { content: updatedContent, project_id: ctx.project.id } })

      // Read back
      const getRes = await api.get<{ document: { content: string } }>(`/api/documents/${docId}?project_id=${ctx.project.id}`)

      expect(getRes.data.document.content).toContain('Updated')
      expect(getRes.data.document.content).toContain('New text')
      expect(getRes.data.document.content).toContain('formatting')
      expect(getRes.data.document.content).not.toContain('Original')
    })
  })

  // ==========================================================================
  // AI Tool Integration (via mocked agent - verifies tool events are emitted)
  // ==========================================================================

  describe('AI Tool Integration', () => {
    test('doc_list tool call is emitted', async () => {
      // Create a session with project_id
      const sessionRes = await api.post<{ session: { id: string } }>('/api/sessions', {
        body: { project_id: ctx.project.id },
      })
      const sessionId = sessionRes.data.session.id

      // Configure mock to call doc_list
      mockToolCalls = [{ name: 'doc_list', args: {} }]

      const { app } = await import('../index')
      const request = new Request(`http://localhost/api/sessions/${sessionId}/messages`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${ctx.token}`,
          'X-Workspace-Id': ctx.workspace.id,
        },
        body: JSON.stringify({ content: 'List my documents' }),
      })

      const response = await app.fetch(request)
      expect(response.status).toBe(200)

      const events = await readSSEEvents<StreamEvent>(response)
      const toolCallEvent = events.find(e => e.event === 'tool-call-complete')

      expect(toolCallEvent?.data).toMatchObject({
        type: 'tool-call-complete',
        toolName: 'doc_list',
        toolCallId: expect.any(String),
      })
    })

    test('doc_create tool call is emitted', async () => {
      const sessionRes = await api.post<{ session: { id: string } }>('/api/sessions', {
        body: { project_id: ctx.project.id },
      })
      const sessionId = sessionRes.data.session.id

      mockToolCalls = [{
        name: 'doc_create',
        args: { name: 'Test Doc', content: '# Hello' },
      }]

      const { app } = await import('../index')
      const request = new Request(`http://localhost/api/sessions/${sessionId}/messages`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${ctx.token}`,
          'X-Workspace-Id': ctx.workspace.id,
        },
        body: JSON.stringify({ content: 'Create a document' }),
      })

      const response = await app.fetch(request)
      expect(response.status).toBe(200)

      const events = await readSSEEvents<StreamEvent>(response)
      const toolCallEvent = events.find(e => e.event === 'tool-call-complete')

      expect(toolCallEvent?.data).toMatchObject({
        type: 'tool-call-complete',
        toolName: 'doc_create',
        args: { name: 'Test Doc', content: '# Hello' },
      })
    })

    test('doc_read tool call is emitted', async () => {
      const sessionRes = await api.post<{ session: { id: string } }>('/api/sessions', {
        body: { project_id: ctx.project.id },
      })
      const sessionId = sessionRes.data.session.id

      mockToolCalls = [{ name: 'doc_read', args: { id: 'some-doc-id' } }]

      const { app } = await import('../index')
      const request = new Request(`http://localhost/api/sessions/${sessionId}/messages`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${ctx.token}`,
          'X-Workspace-Id': ctx.workspace.id,
        },
        body: JSON.stringify({ content: 'Read the document' }),
      })

      const response = await app.fetch(request)
      expect(response.status).toBe(200)

      const events = await readSSEEvents<StreamEvent>(response)
      const toolCallEvent = events.find(e => e.event === 'tool-call-complete')

      expect(toolCallEvent?.data).toMatchObject({
        type: 'tool-call-complete',
        toolName: 'doc_read',
        args: { id: 'some-doc-id' },
      })
    })

    test('doc_edit tool call is emitted', async () => {
      const sessionRes = await api.post<{ session: { id: string } }>('/api/sessions', {
        body: { project_id: ctx.project.id },
      })
      const sessionId = sessionRes.data.session.id

      mockToolCalls = [{
        name: 'doc_edit',
        args: { id: 'doc-id', old_text: 'old', new_text: 'new' },
      }]

      const { app } = await import('../index')
      const request = new Request(`http://localhost/api/sessions/${sessionId}/messages`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${ctx.token}`,
          'X-Workspace-Id': ctx.workspace.id,
        },
        body: JSON.stringify({ content: 'Edit the document' }),
      })

      const response = await app.fetch(request)
      expect(response.status).toBe(200)

      const events = await readSSEEvents<StreamEvent>(response)
      const toolCallEvent = events.find(e => e.event === 'tool-call-complete')

      expect(toolCallEvent?.data).toMatchObject({
        type: 'tool-call-complete',
        toolName: 'doc_edit',
        args: { id: 'doc-id', old_text: 'old', new_text: 'new' },
      })
    })
  })

  // ==========================================================================
  // Direct Tool Function Tests (verifies side effects by calling tools directly)
  // ==========================================================================

  describe('Direct Tool Functions', () => {
    test('doc_create creates a document and returns info', async () => {
      const { createDocumentTools } = await import('../tools/document-tools')
      const tools = createDocumentTools(ctx.project.id, ctx.user.id)

      const result = await tools.doc_create.execute!(
        { name: 'Direct Test Doc', content: '# Created Directly\n\nContent here.' },
        { toolCallId: 'test-call-1', messages: [], abortSignal: undefined as unknown as AbortSignal }
      )

      expect(result).toMatchObject({
        id: expect.any(String),
        name: 'Direct Test Doc',
      })

      // Verify via API
      const listRes = await api.get<{ documents: Array<{ name: string }> }>(`/api/documents?project_id=${ctx.project.id}`)
      expect(listRes.data.documents.some(d => d.name === 'Direct Test Doc')).toBe(true)
    })

    test('doc_list returns project documents', async () => {
      // Create documents via API first
      await api.post('/api/documents', { body: { name: 'List Test A', project_id: ctx.project.id } })
      await api.post('/api/documents', { body: { name: 'List Test B', project_id: ctx.project.id } })

      const { createDocumentTools } = await import('../tools/document-tools')
      const tools = createDocumentTools(ctx.project.id, ctx.user.id)

      const result = await tools.doc_list.execute!(
        {},
        { toolCallId: 'test-call-2', messages: [], abortSignal: undefined as unknown as AbortSignal }
      )

      expect(result).toMatchObject({
        documents: expect.arrayContaining([
          expect.objectContaining({ name: 'List Test A' }),
          expect.objectContaining({ name: 'List Test B' }),
        ]),
      })
    })

    test('doc_read returns document content', async () => {
      // Create a document via API
      const createRes = await api.post<{ document: { id: string } }>('/api/documents', {
        body: { name: 'Read Test', content: '# Readable\n\nThis is content.', project_id: ctx.project.id },
      })
      const docId = createRes.data.document.id

      // Clear cache so tool reads from DB
      const clearCache = await getClearCache()
      clearCache()

      const { createDocumentTools } = await import('../tools/document-tools')
      const tools = createDocumentTools(ctx.project.id, ctx.user.id)

      const result = await tools.doc_read.execute!(
        { id: docId },
        { toolCallId: 'test-call-3', messages: [], abortSignal: undefined as unknown as AbortSignal }
      )

      expect(result).toMatchObject({
        id: docId,
        name: 'Read Test',
        content: expect.stringContaining('Readable'),
      })
    })

    test('doc_edit modifies document content', async () => {
      // Create a document via API
      const createRes = await api.post<{ document: { id: string } }>('/api/documents', {
        body: { name: 'Edit Test', content: 'Hello world', project_id: ctx.project.id },
      })
      const docId = createRes.data.document.id

      const { createDocumentTools } = await import('../tools/document-tools')
      const tools = createDocumentTools(ctx.project.id, ctx.user.id)

      const result = await tools.doc_edit.execute!(
        { id: docId, old_text: 'Hello world', new_text: 'Goodbye world' },
        { toolCallId: 'test-call-4', messages: [], abortSignal: undefined as unknown as AbortSignal }
      )

      expect(result).toMatchObject({ success: true })

      // Clear cache and verify via API
      const clearCache = await getClearCache()
      clearCache()

      const getRes = await api.get<{ document: { content: string } }>(`/api/documents/${docId}?project_id=${ctx.project.id}`)
      expect(getRes.data.document.content).toContain('Goodbye world')
      expect(getRes.data.document.content).not.toContain('Hello world')
    })

    test('doc_append adds content to end of document', async () => {
      // Create a document via API
      const createRes = await api.post<{ document: { id: string } }>('/api/documents', {
        body: { name: 'Append Test', content: '# Original', project_id: ctx.project.id },
      })
      const docId = createRes.data.document.id

      const { createDocumentTools } = await import('../tools/document-tools')
      const tools = createDocumentTools(ctx.project.id, ctx.user.id)

      const result = await tools.doc_append.execute!(
        { id: docId, content: '\n\n## Appended Section' },
        { toolCallId: 'test-call-5', messages: [], abortSignal: undefined as unknown as AbortSignal }
      )

      expect(result).toMatchObject({ success: true })

      // Clear cache and verify
      const clearCache = await getClearCache()
      clearCache()

      const getRes = await api.get<{ document: { content: string } }>(`/api/documents/${docId}?project_id=${ctx.project.id}`)
      expect(getRes.data.document.content).toContain('Original')
      expect(getRes.data.document.content).toContain('Appended Section')
    })

    test('doc_delete removes a document', async () => {
      // Create a document via API
      const createRes = await api.post<{ document: { id: string } }>('/api/documents', {
        body: { name: 'Delete Test', project_id: ctx.project.id },
      })
      const docId = createRes.data.document.id

      const { createDocumentTools } = await import('../tools/document-tools')
      const tools = createDocumentTools(ctx.project.id, ctx.user.id)

      const result = await tools.doc_delete.execute!(
        { id: docId },
        { toolCallId: 'test-call-6', messages: [], abortSignal: undefined as unknown as AbortSignal }
      )

      expect(result).toMatchObject({ success: true })

      // Verify via API
      const getRes = await api.get(`/api/documents/${docId}?project_id=${ctx.project.id}`)
      expect(getRes.status).toBe(404)
    })

    test('doc_read returns error for non-existent document', async () => {
      const { createDocumentTools } = await import('../tools/document-tools')
      const tools = createDocumentTools(ctx.project.id, ctx.user.id)

      const result = await tools.doc_read.execute!(
        { id: '00000000-0000-0000-0000-000000000000' },
        { toolCallId: 'test-call-7', messages: [], abortSignal: undefined as unknown as AbortSignal }
      )

      expect(result).toMatchObject({ error: 'Document not found' })
    })

    test('doc_edit returns error when old_text not found', async () => {
      const createRes = await api.post<{ document: { id: string } }>('/api/documents', {
        body: { name: 'Edit Fail Test', content: 'Some content', project_id: ctx.project.id },
      })
      const docId = createRes.data.document.id

      const { createDocumentTools } = await import('../tools/document-tools')
      const tools = createDocumentTools(ctx.project.id, ctx.user.id)

      const result = await tools.doc_edit.execute!(
        { id: docId, old_text: 'nonexistent text', new_text: 'replacement' },
        { toolCallId: 'test-call-8', messages: [], abortSignal: undefined as unknown as AbortSignal }
      )

      expect(result).toMatchObject({ success: false, error: 'old_text not found in document' })
    })
  })
})
