/**
 * Phase 5: AI Session Context Integration (unit-level with DB mocked).
 *
 * These tests validate the end-to-end wiring between:
 * - project context builder (via injected prompt)
 * - session creation prompt composition
 * - session list ordering by last_message_at (COALESCE)
 *
 * Full DB/RLS integration is covered by the broader API test suite when a
 * Supabase test stack is available.
 */

import { describe, expect, test, mock, beforeEach } from 'bun:test'
import { Hono } from 'hono'

type TestEnv = { Variables: { userId: string; workspaceId: string } }

describe('AI Session Context Integration', () => {
  beforeEach(() => {
    mock.restore()
  })

  test('small project: session includes document list in system prompt', async () => {
    const workspaceId = 'w1'
    const userId = 'u1'
    const projectId = 'p-small'

    mock.module('../lib/db', () => ({
      db: {},
      withRLS: async (_userId: string, fn: (sql: any) => Promise<any>) => {
        const sql = async (strings: TemplateStringsArray, ...values: any[]) => {
          const text = strings.join('${}')
          if (text.includes('SELECT workspace_id')) return [{ workspace_id: workspaceId }]
          if (text.includes('INSERT INTO agent_sessions')) {
            return [
              {
                id: 's1',
                workspace_id: values[0],
                project_id: values[1],
                title: values[2],
                model: values[3],
                provider: values[4],
                system_prompt: values[5],
                created_by: values[6],
                created_at: new Date().toISOString(),
                updated_at: new Date().toISOString(),
                last_message_at: null,
                archived: false,
              },
            ]
          }
          throw new Error(`Unexpected SQL: ${text}`)
        }
        return fn(sql)
      },
    }))

    mock.module('../lib/project-context', () => ({
      buildProjectContext: async () => ({
        projectId,
        projectName: 'Test Project',
        documentCount: 3,
        documents: [
          { id: 'd1', name: 'Requirements', folder_path: '/', updated_at: new Date().toISOString() },
          { id: 'd2', name: 'Design Spec', folder_path: '/', updated_at: new Date().toISOString() },
          { id: 'd3', name: 'API Reference', folder_path: '/', updated_at: new Date().toISOString() },
        ],
        isLargeProject: false,
      }),
      formatProjectContextPrompt: () =>
        `## Project Context\n\n- **Requirements** - ID: \`d1\`\n- **Design Spec** - ID: \`d2\`\n- **API Reference** - ID: \`d3\`\n`,
    }))

    const { sessionsRouter } = await import('../routes/sessions')

    const app = new Hono<TestEnv>()
    app.use('*', async (c, next) => {
      c.set('userId', userId)
      c.set('workspaceId', workspaceId)
      await next()
    })
    app.route('/api/projects/:projectId/sessions', sessionsRouter)

    const res = await app.fetch(
      new Request(`http://localhost/api/projects/${projectId}/sessions`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ title: 'Test Session' }),
      }),
    )

    expect(res.status).toBe(201)
    const body = (await res.json()) as { session: { system_prompt: string } }
    expect(body.session.system_prompt).toContain('Project Context')
    expect(body.session.system_prompt).toContain('Requirements')
    expect(body.session.system_prompt).toContain('Design Spec')
    expect(body.session.system_prompt).toContain('API Reference')
  })

  test('large project: session includes tool instructions instead of doc list', async () => {
    const workspaceId = 'w1'
    const userId = 'u1'
    const projectId = 'p-large'

    mock.module('../lib/db', () => ({
      db: {},
      withRLS: async (_userId: string, fn: (sql: any) => Promise<any>) => {
        const sql = async (strings: TemplateStringsArray, ...values: any[]) => {
          const text = strings.join('${}')
          if (text.includes('SELECT workspace_id')) return [{ workspace_id: workspaceId }]
          if (text.includes('INSERT INTO agent_sessions')) {
            return [
              {
                id: 's1',
                workspace_id: values[0],
                project_id: values[1],
                title: values[2],
                model: values[3],
                provider: values[4],
                system_prompt: values[5],
                created_by: values[6],
                created_at: new Date().toISOString(),
                updated_at: new Date().toISOString(),
                last_message_at: null,
                archived: false,
              },
            ]
          }
          throw new Error(`Unexpected SQL: ${text}`)
        }
        return fn(sql)
      },
    }))

    mock.module('../lib/project-context', () => ({
      buildProjectContext: async () => ({
        projectId,
        projectName: 'Big Project',
        documentCount: 25,
        documents: [],
        isLargeProject: true,
      }),
      formatProjectContextPrompt: () =>
        `## Project Context\n\nThis project contains 25 documents. Use \`doc_list\` and \`doc_search\`.`,
    }))

    const { sessionsRouter } = await import('../routes/sessions')

    const app = new Hono<TestEnv>()
    app.use('*', async (c, next) => {
      c.set('userId', userId)
      c.set('workspaceId', workspaceId)
      await next()
    })
    app.route('/api/projects/:projectId/sessions', sessionsRouter)

    const res = await app.fetch(
      new Request(`http://localhost/api/projects/${projectId}/sessions`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ title: 'Large Project Session' }),
      }),
    )

    expect(res.status).toBe(201)
    const body = (await res.json()) as { session: { system_prompt: string } }
    expect(body.session.system_prompt).toContain('doc_list')
    expect(body.session.system_prompt).toContain('doc_search')
    expect(body.session.system_prompt).not.toContain('Document 0')
  })

  test('session preserves user custom prompt alongside project context', async () => {
    const workspaceId = 'w1'
    const userId = 'u1'
    const projectId = 'p-small'
    const customPrompt = 'You are a helpful assistant specializing in code review.'

    mock.module('../lib/db', () => ({
      db: {},
      withRLS: async (_userId: string, fn: (sql: any) => Promise<any>) => {
        const sql = async (strings: TemplateStringsArray, ...values: any[]) => {
          const text = strings.join('${}')
          if (text.includes('SELECT workspace_id')) return [{ workspace_id: workspaceId }]
          if (text.includes('INSERT INTO agent_sessions')) {
            return [
              {
                id: 's1',
                workspace_id: values[0],
                project_id: values[1],
                title: values[2],
                model: values[3],
                provider: values[4],
                system_prompt: values[5],
                created_by: values[6],
                created_at: new Date().toISOString(),
                updated_at: new Date().toISOString(),
                last_message_at: null,
                archived: false,
              },
            ]
          }
          throw new Error(`Unexpected SQL: ${text}`)
        }
        return fn(sql)
      },
    }))

    mock.module('../lib/project-context', () => ({
      buildProjectContext: async () => ({
        projectId,
        projectName: 'Test Project',
        documentCount: 0,
        documents: [],
        isLargeProject: false,
      }),
      formatProjectContextPrompt: () => `## Project Context\n\nNo docs yet.`,
    }))

    const { sessionsRouter } = await import('../routes/sessions')

    const app = new Hono<TestEnv>()
    app.use('*', async (c, next) => {
      c.set('userId', userId)
      c.set('workspaceId', workspaceId)
      await next()
    })
    app.route('/api/projects/:projectId/sessions', sessionsRouter)

    const res = await app.fetch(
      new Request(`http://localhost/api/projects/${projectId}/sessions`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ title: 'Custom Prompt Session', system_prompt: customPrompt }),
      }),
    )

    expect(res.status).toBe(201)
    const body = (await res.json()) as { session: { system_prompt: string } }
    expect(body.session.system_prompt).toContain(customPrompt)
    expect(body.session.system_prompt).toContain('Project Context')
  })

  test('sessions are ordered by most recently accessed', async () => {
    const workspaceId = 'w1'
    const userId = 'u1'
    const projectId = 'p1'

    const queries: string[] = []

    mock.module('../lib/db', () => ({
      db: {},
      withRLS: async (_userId: string, fn: (sql: any) => Promise<any>) => {
        const sql = async (strings: TemplateStringsArray) => {
          const text = strings.join('${}')
          queries.push(text)

          // Return sessions already in the expected order. This test's primary
          // assertion is that the ORDER BY clause uses COALESCE(last_message_at, created_at).
          return [
            {
              id: 's1',
              project_id: projectId,
              workspace_id: workspaceId,
              title: 'Session 1',
              last_message_at: '2026-02-05T00:00:03.000Z',
              created_at: '2026-02-05T00:00:00.000Z',
              archived: false,
            },
            {
              id: 's3',
              project_id: projectId,
              workspace_id: workspaceId,
              title: 'Session 3',
              last_message_at: null,
              created_at: '2026-02-05T00:00:02.000Z',
              archived: false,
            },
            {
              id: 's2',
              project_id: projectId,
              workspace_id: workspaceId,
              title: 'Session 2',
              last_message_at: null,
              created_at: '2026-02-05T00:00:01.000Z',
              archived: false,
            },
          ]
        }
        return fn(sql)
      },
    }))

    // Avoid pulling in the real project-context dependency tree for this test.
    mock.module('../lib/project-context', () => ({
      buildProjectContext: async () => null,
      formatProjectContextPrompt: () => '',
    }))

    const { sessionsRouter } = await import('../routes/sessions')

    const app = new Hono<TestEnv>()
    app.use('*', async (c, next) => {
      c.set('userId', userId)
      c.set('workspaceId', workspaceId)
      await next()
    })
    app.route('/api/projects/:projectId/sessions', sessionsRouter)

    const res = await app.fetch(
      new Request(`http://localhost/api/projects/${projectId}/sessions`),
    )
    expect(res.status).toBe(200)
    const body = (await res.json()) as { data: Array<{ id: string }>; cursor: string | null }
    expect(body.data[0]!.id).toBe('s1')
    expect(
      queries.some((q) =>
        q.includes('ORDER BY COALESCE(last_message_at, created_at) DESC'),
      ),
    ).toBe(true)
  })
})
