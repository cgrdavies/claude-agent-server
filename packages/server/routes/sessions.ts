import { Hono } from 'hono'
import type {
  CreateSessionRequest,
  CreateSessionResponse,
  GetSessionResponse,
  ListSessionsResponse,
  UpdateSessionRequest,
  UpdateSessionResponse,
} from '@claude-agent/shared'
import { withRLS } from '../lib/db'
import { DEFAULT_MODEL, DEFAULT_PROVIDER } from '../lib/providers'

type Env = { Variables: { userId: string; workspaceId: string } }

export const sessionsRouter = new Hono<Env>()

// POST /api/sessions
sessionsRouter.post('/', async (c) => {
  const userId = c.get('userId')
  const workspaceId = c.get('workspaceId')
  const body = await c.req.json<CreateSessionRequest>()

  const projectId = body.project_id
  if (!projectId) {
    return c.json({ error: 'project_id is required' }, 400)
  }

  const title = body.title ?? 'New Session'
  const model = body.model ?? DEFAULT_MODEL
  const provider = body.provider ?? DEFAULT_PROVIDER
  const systemPrompt = body.system_prompt ?? null

  const rows = await withRLS(userId, (sql) =>
    sql`INSERT INTO agent_sessions (workspace_id, project_id, title, model, provider, system_prompt, created_by)
        VALUES (${workspaceId}, ${projectId}, ${title}, ${model}, ${provider}, ${systemPrompt}, ${userId})
        RETURNING *`
  )
  const session = rows[0]

  return c.json({ session } satisfies CreateSessionResponse, 201)
})

// GET /api/sessions
sessionsRouter.get('/', async (c) => {
  const userId = c.get('userId')
  const workspaceId = c.get('workspaceId')
  const cursor = c.req.query('cursor')
  const limit = Math.min(Number(c.req.query('limit') ?? 50), 100)

  const sessions = await withRLS(userId, (sql) =>
    cursor
      ? sql`SELECT * FROM agent_sessions
            WHERE workspace_id = ${workspaceId}
              AND archived = false
              AND created_at < ${cursor}
            ORDER BY created_at DESC
            LIMIT ${limit + 1}`
      : sql`SELECT * FROM agent_sessions
            WHERE workspace_id = ${workspaceId}
              AND archived = false
            ORDER BY created_at DESC
            LIMIT ${limit + 1}`
  )

  const hasMore = sessions.length > limit
  const page = hasMore ? sessions.slice(0, limit) : sessions
  const nextCursor = hasMore
    ? (page[page.length - 1] as Record<string, unknown>)?.created_at as string
    : null

  return c.json({
    data: page,
    cursor: nextCursor,
  } satisfies ListSessionsResponse)
})

// GET /api/sessions/:id
sessionsRouter.get('/:id', async (c) => {
  const userId = c.get('userId')
  const sessionId = c.req.param('id')

  const result = await withRLS(userId, async (sql) => {
    const sessions = await sql`SELECT * FROM agent_sessions WHERE id = ${sessionId} LIMIT 1`
    const session = sessions[0]
    if (!session) return null

    const messages = await sql`SELECT * FROM messages
                               WHERE session_id = ${sessionId}
                               ORDER BY created_at ASC`
    return { session, messages }
  })

  if (!result) return c.json({ error: 'Session not found' }, 404)

  return c.json({
    session: result.session,
    messages: result.messages,
  } satisfies GetSessionResponse)
})

// PATCH /api/sessions/:id
sessionsRouter.patch('/:id', async (c) => {
  const userId = c.get('userId')
  const sessionId = c.req.param('id')
  const body = await c.req.json<UpdateSessionRequest>()

  const rows = await withRLS(userId, async (sql) => {
    if (body.title !== undefined && body.archived !== undefined) {
      return sql`UPDATE agent_sessions
                 SET title = ${body.title}, archived = ${body.archived}, updated_at = now()
                 WHERE id = ${sessionId} RETURNING *`
    } else if (body.title !== undefined) {
      return sql`UPDATE agent_sessions
                 SET title = ${body.title}, updated_at = now()
                 WHERE id = ${sessionId} RETURNING *`
    } else if (body.archived !== undefined) {
      return sql`UPDATE agent_sessions
                 SET archived = ${body.archived}, updated_at = now()
                 WHERE id = ${sessionId} RETURNING *`
    }
    return sql`SELECT * FROM agent_sessions WHERE id = ${sessionId} LIMIT 1`
  })

  const session = rows[0]
  if (!session) return c.json({ error: 'Session not found' }, 404)
  return c.json({ session } satisfies UpdateSessionResponse)
})
