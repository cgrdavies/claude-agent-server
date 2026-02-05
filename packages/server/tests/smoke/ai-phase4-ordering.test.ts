import { describe, expect, test, mock, beforeEach } from 'bun:test'
import { Hono } from 'hono'

type TestEnv = { Variables: { userId: string; workspaceId: string } }

describe('AI Phase 4: Session List Ordering', () => {
  beforeEach(() => {
    mock.restore()
  })

  test('uses last_message_at ordering and cursor pagination under project scope', async () => {
    const workspaceId = 'w1'
    const userId = 'u1'
    const projectId = 'p1'

    const seenQueries: string[] = []
    let page = 0

    mock.module('../../lib/db', () => ({
      db: {}, // unused in this smoke test (required for folder-manager import shape)
      withRLS: async (_userId: string, fn: (sql: any) => Promise<any>) => {
        const sql = async (strings: TemplateStringsArray) => {
          const text = strings.join('${}')
          seenQueries.push(text)

          // Simulate two pages.
          page++
          if (page === 1) {
            // Return limit+1 rows to force cursor.
            return [
              { id: 's1', last_message_at: '2026-02-05T00:00:03.000Z', created_at: '2026-02-05T00:00:00.000Z' },
              { id: 's2', last_message_at: null, created_at: '2026-02-05T00:00:02.000Z' },
              { id: 's3', last_message_at: null, created_at: '2026-02-05T00:00:01.000Z' },
            ]
          }
          // Second page: no extra row (no more cursor)
          return [
            { id: 's4', last_message_at: null, created_at: '2026-02-05T00:00:00.500Z' },
          ]
        }

        return fn(sql)
      },
    }))

    const { sessionsRouter } = await import('../../routes/sessions')

    const app = new Hono<TestEnv>()
    app.use('*', async (c, next) => {
      c.set('userId', userId)
      c.set('workspaceId', workspaceId)
      await next()
    })
    app.route('/api/projects/:projectId/sessions', sessionsRouter)

    // Page 1
    const res1 = await app.fetch(
      new Request(`http://localhost/api/projects/${projectId}/sessions?limit=2`),
    )
    expect(res1.status).toBe(200)
    const body1 = (await res1.json()) as { data: any[]; cursor: string | null }
    expect(body1.data).toHaveLength(2)
    expect(body1.cursor).toBe('2026-02-05T00:00:02.000Z') // last item on page: s2 (no last_message_at)

    // Page 2
    const cursor = body1.cursor as string
    const res2 = await app.fetch(
      new Request(
        `http://localhost/api/projects/${projectId}/sessions?limit=2&cursor=${encodeURIComponent(cursor)}`,
      ),
    )
    expect(res2.status).toBe(200)
    const body2 = (await res2.json()) as { data: any[]; cursor: string | null }
    expect(body2.data.length).toBeGreaterThan(0)

    // Query assertions: ensure ordering clause and cursor filter use COALESCE.
    expect(seenQueries.some((q) => q.includes('ORDER BY COALESCE(last_message_at, created_at) DESC'))).toBe(true)
    expect(seenQueries.some((q) => q.includes('COALESCE(last_message_at, created_at) <'))).toBe(true)
    // Ensure project scoping is applied in WHERE clause.
    expect(seenQueries.some((q) => q.includes('project_id ='))).toBe(true)
  })
})
