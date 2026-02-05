import { describe, expect, test, mock, beforeEach } from 'bun:test'
import { Hono } from 'hono'

type TestEnv = { Variables: { userId: string; workspaceId: string } }

describe('AI Phase 2: Session Creation with Project Context', () => {
  beforeEach(() => {
    mock.restore()
  })

  test('session system_prompt includes project context (small project)', async () => {
    const userId = 'u1'
    const workspaceId = 'w1'
    const projectId = 'p-small'

    // Mock project lookup (workspace_id) + insert; capture combined system prompt.
    let insertedSystemPrompt: string | undefined

    mock.module('../../lib/db', () => ({
      withRLS: async (_userId: string, fn: (sql: any) => Promise<any>) => {
        // Fake SQL tag fn that returns expected rows.
        const sql = async (strings: TemplateStringsArray, ...values: any[]) => {
          const text = strings.join('${}')
          if (text.includes('SELECT workspace_id')) {
            return [{ workspace_id: workspaceId }]
          }
          if (text.includes('INSERT INTO agent_sessions')) {
            insertedSystemPrompt = values[5]
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
          throw new Error(`Unexpected SQL in withRLS mock: ${text}`)
        }

        return fn(sql)
      },
    }))

    mock.module('../../lib/project-context', () => ({
      buildProjectContext: async () => ({
        projectId,
        projectName: 'Small Project',
        documentCount: 5,
        documents: [
          { id: 'd0', name: 'Doc 0', folder_path: '/', updated_at: new Date().toISOString() },
        ],
        isLargeProject: false,
      }),
      formatProjectContextPrompt: () => `## Project Context\n\n- **Doc 0** - ID: \`d0\`\n\nUse \`doc_read\`.`,
    }))

    const { sessionsRouter } = await import('../../routes/sessions')

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
    expect(body.session.system_prompt).toContain('Doc 0')
    expect(insertedSystemPrompt).toBe(body.session.system_prompt)
  })

  test('custom prompt is preserved alongside project context', async () => {
    const userId = 'u1'
    const workspaceId = 'w1'
    const projectId = 'p-small'

    let insertedSystemPrompt: string | undefined

    mock.module('../../lib/db', () => ({
      withRLS: async (_userId: string, fn: (sql: any) => Promise<any>) => {
        const sql = async (strings: TemplateStringsArray, ...values: any[]) => {
          const text = strings.join('${}')
          if (text.includes('SELECT workspace_id')) {
            return [{ workspace_id: workspaceId }]
          }
          if (text.includes('INSERT INTO agent_sessions')) {
            insertedSystemPrompt = values[5]
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
          throw new Error(`Unexpected SQL in withRLS mock: ${text}`)
        }

        return fn(sql)
      },
    }))

    mock.module('../../lib/project-context', () => ({
      buildProjectContext: async () => ({
        projectId,
        projectName: 'Small Project',
        documentCount: 0,
        documents: [],
        isLargeProject: false,
      }),
      formatProjectContextPrompt: () => `## Project Context\n\nThis project has no documents yet.`,
    }))

    const { sessionsRouter } = await import('../../routes/sessions')

    const app = new Hono<TestEnv>()
    app.use('*', async (c, next) => {
      c.set('userId', userId)
      c.set('workspaceId', workspaceId)
      await next()
    })
    app.route('/api/projects/:projectId/sessions', sessionsRouter)

    const customPrompt = 'You are a code reviewer.'
    const res = await app.fetch(
      new Request(`http://localhost/api/projects/${projectId}/sessions`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ title: 'Custom Session', system_prompt: customPrompt }),
      }),
    )

    expect(res.status).toBe(201)
    const body = (await res.json()) as { session: { system_prompt: string } }
    expect(body.session.system_prompt).toContain(customPrompt)
    expect(body.session.system_prompt).toContain('Project Context')
    expect(insertedSystemPrompt).toBe(body.session.system_prompt)
  })

  test('large project session includes tool instructions', async () => {
    const userId = 'u1'
    const workspaceId = 'w1'
    const projectId = 'p-large'

    mock.module('../../lib/db', () => ({
      withRLS: async (_userId: string, fn: (sql: any) => Promise<any>) => {
        const sql = async (strings: TemplateStringsArray, ...values: any[]) => {
          const text = strings.join('${}')
          if (text.includes('SELECT workspace_id')) {
            return [{ workspace_id: workspaceId }]
          }
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
          throw new Error(`Unexpected SQL in withRLS mock: ${text}`)
        }

        return fn(sql)
      },
    }))

    mock.module('../../lib/project-context', () => ({
      buildProjectContext: async () => ({
        projectId,
        projectName: 'Large Project',
        documentCount: 25,
        documents: [],
        isLargeProject: true,
      }),
      formatProjectContextPrompt: () =>
        `## Project Context\n\nUse \`doc_list\` and \`doc_search\` to find documents.`,
    }))

    const { sessionsRouter } = await import('../../routes/sessions')

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
        body: JSON.stringify({ title: 'Large Session' }),
      }),
    )

    expect(res.status).toBe(201)
    const body = (await res.json()) as { session: { system_prompt: string } }
    expect(body.session.system_prompt).toContain('doc_list')
    expect(body.session.system_prompt).toContain('doc_search')
    expect(body.session.system_prompt).not.toContain('Doc 0')
  })
})
