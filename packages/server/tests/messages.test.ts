/**
 * Messages API integration tests.
 *
 * Tests the POST /api/sessions/:sessionId/messages endpoint:
 * - Message creation (user message saved)
 * - SSE streaming events (started, text-delta, step-complete, done)
 * - AI model mocking
 * - Tool execution
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

// Mock the providers module to return our controlled mock model
// This must happen before the app is imported
let mockModelResponse = 'Hello, this is a test response!'
let mockToolCalls: Array<{ name: string; args: Record<string, unknown> }> = []
let mockStreaming = true

mock.module('../lib/providers', () => ({
  getModel: () => {
    if (mockToolCalls.length > 0) {
      return createToolCallingMock(mockToolCalls, {
        response: mockModelResponse,
        streaming: mockStreaming,
      })
    }
    return createMockModel({
      response: mockModelResponse,
      streaming: mockStreaming,
    })
  },
  DEFAULT_MODEL: 'mock-model',
  DEFAULT_PROVIDER: 'mock',
}))

// Now import the API helpers (which will import the app with mocked providers)
import { withAuth, readSSEEvents, apiRequest } from './helpers/api'
import type { StreamEvent } from '@claude-agent/shared'

describe('Messages API', () => {
  let ctx: TestContext
  let api: ReturnType<typeof withAuth>

  beforeAll(async () => {
    ctx = await createTestContext()
    api = withAuth(ctx.token, ctx.workspace.id)
  })

  beforeEach(async () => {
    await resetAgentTables()
    // Reset mock defaults
    mockModelResponse = 'Hello, this is a test response!'
    mockToolCalls = []
    mockStreaming = true
  })

  afterAll(async () => {
    await closeTestConnections()
  })

  describe('POST /api/sessions/:sessionId/messages', () => {
    test('returns 404 for non-existent session', async () => {
      const res = await api.post('/api/sessions/00000000-0000-0000-0000-000000000000/messages', {
        body: { content: 'Hello' },
      })

      expect(res.status).toBe(404)
      expect(res.data).toMatchObject({ error: 'Session not found' })
    })

    test('saves user message to database', async () => {
      // Create a session with project_id
      const sessionRes = await api.post<{ session: { id: string } }>('/api/sessions', {
        body: { project_id: ctx.project.id },
      })
      const sessionId = sessionRes.data.session.id

      // Send a message
      await apiRequest('POST', `/api/sessions/${sessionId}/messages`, {
        token: ctx.token,
        workspaceId: ctx.workspace.id,
        body: { content: 'Hello, AI!' },
      })

      // Verify the user message was saved
      const db = getTestDb()
      const messages = await db`
        SELECT * FROM messages
        WHERE session_id = ${sessionId}
        ORDER BY created_at ASC
      `

      // Should have at least the user message and an assistant message
      expect(messages.length).toBeGreaterThanOrEqual(2)

      // First message should be the user's
      const userMsg = messages[0]
      expect(userMsg.role).toBe('user')
      expect(JSON.parse(userMsg.content as string)).toBe('Hello, AI!')
    })

    test('streams SSE events correctly', async () => {
      mockModelResponse = 'Hello world!'

      // Create a session
      const sessionRes = await api.post<{ session: { id: string } }>('/api/sessions', { body: { project_id: ctx.project.id } })
      const sessionId = sessionRes.data.session.id

      // Send a message and get raw response for SSE parsing
      const { app } = await import('../index')
      const request = new Request(`http://localhost/api/sessions/${sessionId}/messages`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${ctx.token}`,
          'X-Workspace-Id': ctx.workspace.id,
        },
        body: JSON.stringify({ content: 'Hello!' }),
      })

      const response = await app.fetch(request)
      expect(response.status).toBe(200)
      expect(response.headers.get('content-type')).toContain('text/event-stream')

      // Parse SSE events
      const events = await readSSEEvents<StreamEvent>(response)

      // Verify we get the expected event types
      const eventTypes = events.map(e => e.event)
      expect(eventTypes).toContain('started')
      expect(eventTypes).toContain('text-delta')
      expect(eventTypes).toContain('step-complete')
      expect(eventTypes).toContain('done')

      // Verify started event
      const startedEvent = events.find(e => e.event === 'started')
      expect(startedEvent?.data).toMatchObject({
        type: 'started',
        sessionId,
      })

      // Verify done event has the full text
      const doneEvent = events.find(e => e.event === 'done')
      expect(doneEvent?.data).toMatchObject({
        type: 'done',
        text: expect.any(String),
        totalTokensIn: expect.any(Number),
        totalTokensOut: expect.any(Number),
        totalSteps: expect.any(Number),
      })
    })

    test('saves assistant response to database', async () => {
      mockModelResponse = 'This is the assistant response.'

      // Create a session
      const sessionRes = await api.post<{ session: { id: string } }>('/api/sessions', { body: { project_id: ctx.project.id } })
      const sessionId = sessionRes.data.session.id

      // Send a message
      await apiRequest('POST', `/api/sessions/${sessionId}/messages`, {
        token: ctx.token,
        workspaceId: ctx.workspace.id,
        body: { content: 'Hello!' },
      })

      // Verify the assistant message was saved
      const db = getTestDb()
      const messages = await db`
        SELECT * FROM messages
        WHERE session_id = ${sessionId} AND role = 'assistant'
        ORDER BY created_at ASC
      `

      expect(messages.length).toBeGreaterThanOrEqual(1)
      const assistantMsg = messages[0]
      expect(assistantMsg.role).toBe('assistant')
      // Content should contain our mock response
      const content = JSON.parse(assistantMsg.content as string)
      if (typeof content === 'string') {
        expect(content).toContain('assistant')
      } else {
        // Array format with text parts
        expect(content).toEqual(expect.arrayContaining([
          expect.objectContaining({ type: 'text' })
        ]))
      }
    })

    test('updates session last_message_at', async () => {
      // Create a session
      const sessionRes = await api.post<{ session: { id: string; last_message_at: string | null } }>('/api/sessions', { body: { project_id: ctx.project.id } })
      const sessionId = sessionRes.data.session.id
      const originalLastMessageAt = sessionRes.data.session.last_message_at

      // Send a message
      await apiRequest('POST', `/api/sessions/${sessionId}/messages`, {
        token: ctx.token,
        workspaceId: ctx.workspace.id,
        body: { content: 'Hello!' },
      })

      // Check the session was updated
      const db = getTestDb()
      const [session] = await db`
        SELECT last_message_at FROM agent_sessions WHERE id = ${sessionId}
      `

      expect(session.last_message_at).not.toBe(originalLastMessageAt)
      expect(session.last_message_at).not.toBeNull()
    })

    test('emits tool-call-complete event when model returns tool call', async () => {
      // Configure mock to make a doc_list tool call
      mockToolCalls = [
        { name: 'doc_list', args: {} },
      ]
      mockModelResponse = 'Here are the documents in your workspace.'

      // Create a session
      const sessionRes = await api.post<{ session: { id: string } }>('/api/sessions', { body: { project_id: ctx.project.id } })
      const sessionId = sessionRes.data.session.id

      // Send a message and get raw response for SSE parsing
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
      const eventTypes = events.map(e => e.event)

      // Should have tool-call-complete event
      expect(eventTypes).toContain('tool-call-complete')

      // Verify tool call event structure
      const toolCallEvent = events.find(e => e.event === 'tool-call-complete')
      expect(toolCallEvent?.data).toMatchObject({
        type: 'tool-call-complete',
        toolName: 'doc_list',
        toolCallId: expect.any(String),
      })

      // Should complete successfully (even if tool execution doesn't happen with mock)
      expect(eventTypes).toContain('done')
    })

    test('saves assistant message with tool calls to database', async () => {
      // Configure mock to make a doc_list tool call
      mockToolCalls = [
        { name: 'doc_list', args: {} },
      ]

      // Create a session
      const sessionRes = await api.post<{ session: { id: string } }>('/api/sessions', { body: { project_id: ctx.project.id } })
      const sessionId = sessionRes.data.session.id

      // Send a message
      await apiRequest('POST', `/api/sessions/${sessionId}/messages`, {
        token: ctx.token,
        workspaceId: ctx.workspace.id,
        body: { content: 'List documents' },
      })

      // Verify assistant messages were saved (may include tool call in content)
      const db = getTestDb()
      const messages = await db`
        SELECT * FROM messages
        WHERE session_id = ${sessionId} AND role = 'assistant'
        ORDER BY created_at ASC
      `

      expect(messages.length).toBeGreaterThanOrEqual(1)
    })

    test('enforces RLS - cannot access other workspace session', async () => {
      // Create another user/workspace context
      const otherCtx = await createTestContext({ workspaceName: 'Other Workspace' })
      const otherApi = withAuth(otherCtx.token, otherCtx.workspace.id)

      // Create a session in the other workspace
      const otherSession = await otherApi.post<{ session: { id: string } }>('/api/sessions', { body: { project_id: otherCtx.project.id } })

      // Try to send a message to it from the original context
      const res = await api.post(`/api/sessions/${otherSession.data.session.id}/messages`, {
        body: { content: 'Hello' },
      })

      expect(res.status).toBe(404)
      expect(res.data).toMatchObject({ error: 'Session not found' })
    })

    test('streams text deltas word by word', async () => {
      mockModelResponse = 'One two three four five'

      // Create a session
      const sessionRes = await api.post<{ session: { id: string } }>('/api/sessions', { body: { project_id: ctx.project.id } })
      const sessionId = sessionRes.data.session.id

      // Send a message
      const { app } = await import('../index')
      const request = new Request(`http://localhost/api/sessions/${sessionId}/messages`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${ctx.token}`,
          'X-Workspace-Id': ctx.workspace.id,
        },
        body: JSON.stringify({ content: 'Count to five' }),
      })

      const response = await app.fetch(request)
      const events = await readSSEEvents<StreamEvent>(response)

      // Get all text-delta events
      const textDeltas = events
        .filter(e => e.event === 'text-delta')
        .map(e => (e.data as { delta: string }).delta)

      // Should have multiple deltas (streamed word by word)
      expect(textDeltas.length).toBeGreaterThan(1)

      // Combined should form the full response
      const fullText = textDeltas.join('')
      expect(fullText).toBe('One two three four five')
    })
  })
})
