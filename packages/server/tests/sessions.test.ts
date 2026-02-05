/**
 * Sessions API integration tests.
 *
 * Tests the /api/sessions endpoints:
 * - POST /api/sessions - Create session
 * - GET /api/sessions - List sessions
 * - GET /api/sessions/:id - Get session with messages
 * - PATCH /api/sessions/:id - Update session
 */

import { describe, test, expect, beforeAll, beforeEach, afterAll } from 'bun:test'
import {
  setupTestEnvironment,
  resetAgentTables,
  closeTestConnections,
} from './setup'
import {
  createTestContext,
  type TestContext,
} from './helpers/auth'
import { withAuth } from './helpers/api'

// Set up test environment before importing the app
setupTestEnvironment()

describe('Sessions API', () => {
  let ctx: TestContext
  let api: ReturnType<typeof withAuth>

  beforeAll(async () => {
    // Create a test user and workspace
    ctx = await createTestContext()
    api = withAuth(ctx.token, ctx.workspace.id)
  })

  beforeEach(async () => {
    // Reset agent tables between tests
    await resetAgentTables()
  })

  afterAll(async () => {
    await closeTestConnections()
  })

  describe('POST /api/sessions', () => {
    test('creates a session with default values', async () => {
      const res = await api.post<{ session: Record<string, unknown> }>('/api/sessions', {
        body: { project_id: ctx.project.id },
      })

      expect(res.status).toBe(201)
      expect(res.data.session).toMatchObject({
        id: expect.any(String),
        workspace_id: ctx.workspace.id,
        project_id: ctx.project.id,
        title: 'New Session',
        model: expect.any(String),
        provider: expect.any(String),
        created_by: ctx.user.id,
        archived: false,
      })
    })

    test('creates a session with custom title', async () => {
      const res = await api.post<{ session: Record<string, unknown> }>('/api/sessions', {
        body: { title: 'My Custom Session', project_id: ctx.project.id },
      })

      expect(res.status).toBe(201)
      expect(res.data.session.title).toBe('My Custom Session')
    })

    test('creates a session with custom model and provider', async () => {
      const res = await api.post<{ session: Record<string, unknown> }>('/api/sessions', {
        body: {
          title: 'GPT Session',
          model: 'gpt-4o',
          provider: 'openai',
          project_id: ctx.project.id,
        },
      })

      expect(res.status).toBe(201)
      expect(res.data.session.model).toBe('gpt-4o')
      expect(res.data.session.provider).toBe('openai')
    })

    test('requires authentication', async () => {
      const { get } = await import('./helpers/api')
      const res = await get('/api/sessions')

      expect(res.status).toBe(401)
      expect(res.data).toMatchObject({ error: 'Missing authorization token' })
    })

    test('requires workspace_id', async () => {
      const { post } = await import('./helpers/api')
      const res = await post('/api/sessions', { token: ctx.token, body: { project_id: ctx.project.id } })

      expect(res.status).toBe(400)
      expect(res.data).toMatchObject({ error: 'Missing workspace_id' })
    })
  })

  describe('GET /api/sessions', () => {
    test('returns empty list when no sessions exist', async () => {
      const res = await api.get<{ data: unknown[]; cursor: string | null }>('/api/sessions')

      expect(res.status).toBe(200)
      expect(res.data).toMatchObject({
        data: [],
        cursor: null,
      })
    })

    test('returns sessions in descending order by created_at', async () => {
      // Create three sessions
      await api.post('/api/sessions', { body: { title: 'Session 1', project_id: ctx.project.id } })
      await api.post('/api/sessions', { body: { title: 'Session 2', project_id: ctx.project.id } })
      await api.post('/api/sessions', { body: { title: 'Session 3', project_id: ctx.project.id } })

      const res = await api.get<{ data: Array<{ title: string }> }>('/api/sessions')

      expect(res.status).toBe(200)
      expect(res.data.data).toHaveLength(3)
      // Most recent first (Session 3)
      expect(res.data.data[0]!.title).toBe('Session 3')
    })

    test('supports pagination with limit', async () => {
      // Create 5 sessions
      for (let i = 1; i <= 5; i++) {
        await api.post('/api/sessions', { body: { title: `Session ${i}`, project_id: ctx.project.id } })
      }

      const res = await api.get<{ data: unknown[]; cursor: string | null }>('/api/sessions?limit=2')

      expect(res.status).toBe(200)
      expect(res.data.data).toHaveLength(2)
      expect(res.data.cursor).not.toBeNull()
    })

    test('supports cursor-based pagination', async () => {
      // Create 5 sessions
      for (let i = 1; i <= 5; i++) {
        await api.post('/api/sessions', { body: { title: `Session ${i}`, project_id: ctx.project.id } })
      }

      // Get first page
      const page1 = await api.get<{ data: Array<{ id: string }>; cursor: string }>('/api/sessions?limit=2')
      expect(page1.data.data).toHaveLength(2)

      // Get second page using cursor
      const page2 = await api.get<{ data: Array<{ id: string }> }>(`/api/sessions?limit=2&cursor=${page1.data.cursor}`)
      expect(page2.data.data).toHaveLength(2)

      // Ensure no duplicates
      const page1Ids = page1.data.data.map((s) => s.id)
      const page2Ids = page2.data.data.map((s) => s.id)
      expect(page1Ids).not.toEqual(expect.arrayContaining(page2Ids))
    })

    test('excludes archived sessions', async () => {
      // Create a normal session
      await api.post('/api/sessions', { body: { title: 'Active Session', project_id: ctx.project.id } })

      // Create and archive a session
      const archived = await api.post<{ session: { id: string } }>('/api/sessions', {
        body: { title: 'Archived Session', project_id: ctx.project.id },
      })
      await api.patch(`/api/sessions/${archived.data.session.id}`, { body: { archived: true } })

      const res = await api.get<{ data: unknown[] }>('/api/sessions')

      expect(res.data.data).toHaveLength(1)
    })
  })

  describe('GET /api/sessions/:id', () => {
    test('returns session with empty messages', async () => {
      const created = await api.post<{ session: { id: string } }>('/api/sessions', {
        body: { title: 'My Session', project_id: ctx.project.id },
      })

      const res = await api.get<{ session: { title: string }; messages: unknown[] }>(
        `/api/sessions/${created.data.session.id}`
      )

      expect(res.status).toBe(200)
      expect(res.data.session.title).toBe('My Session')
      expect(res.data.messages).toEqual([])
    })

    test('returns 404 for non-existent session', async () => {
      const res = await api.get('/api/sessions/00000000-0000-0000-0000-000000000000')

      expect(res.status).toBe(404)
      expect(res.data).toMatchObject({ error: 'Session not found' })
    })

    test('returns 404 for session in different workspace', async () => {
      // Create another workspace and session
      const otherCtx = await createTestContext({ workspaceName: 'Other Workspace' })
      const otherApi = withAuth(otherCtx.token, otherCtx.workspace.id)

      const otherSession = await otherApi.post<{ session: { id: string } }>('/api/sessions', {
        body: { project_id: otherCtx.project.id },
      })

      // Try to access it from original workspace
      const res = await api.get(`/api/sessions/${otherSession.data.session.id}`)

      expect(res.status).toBe(404)
    })
  })

  describe('PATCH /api/sessions/:id', () => {
    test('updates session title', async () => {
      const created = await api.post<{ session: { id: string } }>('/api/sessions', {
        body: { project_id: ctx.project.id },
      })

      const res = await api.patch<{ session: { title: string } }>(
        `/api/sessions/${created.data.session.id}`,
        { body: { title: 'Updated Title' } }
      )

      expect(res.status).toBe(200)
      expect(res.data.session.title).toBe('Updated Title')
    })

    test('archives a session', async () => {
      const created = await api.post<{ session: { id: string } }>('/api/sessions', {
        body: { project_id: ctx.project.id },
      })

      const res = await api.patch<{ session: { archived: boolean } }>(
        `/api/sessions/${created.data.session.id}`,
        { body: { archived: true } }
      )

      expect(res.status).toBe(200)
      expect(res.data.session.archived).toBe(true)
    })

    test('unarchives a session', async () => {
      const created = await api.post<{ session: { id: string } }>('/api/sessions', {
        body: { project_id: ctx.project.id },
      })
      await api.patch(`/api/sessions/${created.data.session.id}`, { body: { archived: true } })

      const res = await api.patch<{ session: { archived: boolean } }>(
        `/api/sessions/${created.data.session.id}`,
        { body: { archived: false } }
      )

      expect(res.status).toBe(200)
      expect(res.data.session.archived).toBe(false)
    })

    test('returns 404 for non-existent session', async () => {
      const res = await api.patch('/api/sessions/00000000-0000-0000-0000-000000000000', {
        body: { title: 'New Title' },
      })

      expect(res.status).toBe(404)
    })
  })
})
