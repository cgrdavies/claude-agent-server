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
import { buildProjectContext, formatProjectContextPrompt } from '../lib/project-context'

type Env = { Variables: { userId: string; workspaceId: string } }

export const sessionsRouter = new Hono<Env>()

// POST /api/sessions
sessionsRouter.post('/', async (c) => {
  const userId = c.get('userId')
  const workspaceId = c.get('workspaceId')
  const body = await c.req.json<CreateSessionRequest>()

  // Prefer nested route param (/api/projects/:projectId/sessions), but keep legacy
  // support for /api/sessions with project_id in the body.
  const projectId = c.req.param('projectId') ?? body.project_id
  if (!projectId) {
    return c.json({ error: 'project_id is required' }, 400)
  }

  // Get workspace_id from project to avoid creating inconsistent rows.
  const projectRows = await withRLS(userId, (sql) =>
    sql`SELECT workspace_id
        FROM projects
        WHERE id = ${projectId} AND deleted_at IS NULL
        LIMIT 1`,
  )
  const projectWorkspaceId = (projectRows[0] as { workspace_id: string } | undefined)
    ?.workspace_id
  if (!projectWorkspaceId) return c.json({ error: 'Project not found' }, 404)

  // Enforce "workspace context" from auth middleware. Users can belong to multiple
  // workspaces; this prevents accidentally operating on a project from a different
  // workspace than the one selected by the client.
  if (projectWorkspaceId !== workspaceId) {
    return c.json({ error: 'Project not in this workspace' }, 403)
  }

  // Build project context and inject into system prompt.
  const projectContext = await buildProjectContext(userId, projectId)
  if (!projectContext) return c.json({ error: 'Project not found' }, 404)

  const projectPrompt = formatProjectContextPrompt(projectContext)
  const customPrompt = body.system_prompt?.trim()
  const combinedPrompt = customPrompt ? `${customPrompt}\n\n${projectPrompt}` : projectPrompt

  const title = body.title ?? 'New Session'
  const model = body.model ?? DEFAULT_MODEL
  const provider = body.provider ?? DEFAULT_PROVIDER

  const rows = await withRLS(userId, (sql) =>
    sql`INSERT INTO agent_sessions (workspace_id, project_id, title, model, provider, system_prompt, created_by)
        VALUES (${projectWorkspaceId}, ${projectId}, ${title}, ${model}, ${provider}, ${combinedPrompt}, ${userId})
        RETURNING *`
  )
  const session = rows[0]

  return c.json({ session } satisfies CreateSessionResponse, 201)
})

// GET /api/sessions
sessionsRouter.get('/', async (c) => {
  const userId = c.get('userId')
  const workspaceId = c.get('workspaceId')
  const projectId = c.req.param('projectId')
  const cursor = c.req.query('cursor')
  const limit = Math.min(Number(c.req.query('limit') ?? 50), 100)

  const sessions = await withRLS(userId, (sql) =>
    cursor
      ? projectId
        ? sql`SELECT * FROM agent_sessions
              WHERE workspace_id = ${workspaceId}
                AND project_id = ${projectId}
                AND archived = false
                AND COALESCE(last_message_at, created_at) < ${cursor}
              ORDER BY COALESCE(last_message_at, created_at) DESC
              LIMIT ${limit + 1}`
        : sql`SELECT * FROM agent_sessions
              WHERE workspace_id = ${workspaceId}
                AND archived = false
                AND COALESCE(last_message_at, created_at) < ${cursor}
              ORDER BY COALESCE(last_message_at, created_at) DESC
              LIMIT ${limit + 1}`
      : projectId
        ? sql`SELECT * FROM agent_sessions
              WHERE workspace_id = ${workspaceId}
                AND project_id = ${projectId}
                AND archived = false
              ORDER BY COALESCE(last_message_at, created_at) DESC
              LIMIT ${limit + 1}`
        : sql`SELECT * FROM agent_sessions
              WHERE workspace_id = ${workspaceId}
                AND archived = false
              ORDER BY COALESCE(last_message_at, created_at) DESC
              LIMIT ${limit + 1}`
  )

  const hasMore = sessions.length > limit
  const page = hasMore ? sessions.slice(0, limit) : sessions
  const nextCursor = hasMore
    ? ((page[page.length - 1] as Record<string, unknown>)?.last_message_at ??
      (page[page.length - 1] as Record<string, unknown>)?.created_at) as string
    : null

  return c.json({
    data: page,
    cursor: nextCursor,
  } satisfies ListSessionsResponse)
})

// GET /api/sessions/:id
sessionsRouter.get('/:id', async (c) => {
  const userId = c.get('userId')
  const workspaceId = c.get('workspaceId')
  const sessionId = c.req.param('id')
  const projectId = c.req.param('projectId')

  const result = await withRLS(userId, async (sql) => {
    const sessions = projectId
      ? await sql`SELECT * FROM agent_sessions
                  WHERE id = ${sessionId}
                    AND project_id = ${projectId}
                    AND workspace_id = ${workspaceId}
                  LIMIT 1`
      : await sql`SELECT * FROM agent_sessions
                  WHERE id = ${sessionId}
                    AND workspace_id = ${workspaceId}
                  LIMIT 1`
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
  const workspaceId = c.get('workspaceId')
  const projectId = c.req.param('projectId')
  const body = await c.req.json<UpdateSessionRequest>()

  const rows = await withRLS(userId, async (sql) => {
    if (body.title !== undefined && body.archived !== undefined) {
      return projectId
        ? sql`UPDATE agent_sessions
                 SET title = ${body.title}, archived = ${body.archived}, updated_at = now()
                 WHERE id = ${sessionId} AND project_id = ${projectId} AND workspace_id = ${workspaceId} RETURNING *`
        : sql`UPDATE agent_sessions
                 SET title = ${body.title}, archived = ${body.archived}, updated_at = now()
                 WHERE id = ${sessionId} AND workspace_id = ${workspaceId} RETURNING *`
    } else if (body.title !== undefined) {
      return projectId
        ? sql`UPDATE agent_sessions
                 SET title = ${body.title}, updated_at = now()
                 WHERE id = ${sessionId} AND project_id = ${projectId} AND workspace_id = ${workspaceId} RETURNING *`
        : sql`UPDATE agent_sessions
                 SET title = ${body.title}, updated_at = now()
                 WHERE id = ${sessionId} AND workspace_id = ${workspaceId} RETURNING *`
    } else if (body.archived !== undefined) {
      return projectId
        ? sql`UPDATE agent_sessions
                 SET archived = ${body.archived}, updated_at = now()
                 WHERE id = ${sessionId} AND project_id = ${projectId} AND workspace_id = ${workspaceId} RETURNING *`
        : sql`UPDATE agent_sessions
                 SET archived = ${body.archived}, updated_at = now()
                 WHERE id = ${sessionId} AND workspace_id = ${workspaceId} RETURNING *`
    }
    return projectId
      ? sql`SELECT * FROM agent_sessions
            WHERE id = ${sessionId}
              AND project_id = ${projectId}
              AND workspace_id = ${workspaceId}
            LIMIT 1`
      : sql`SELECT * FROM agent_sessions
            WHERE id = ${sessionId}
              AND workspace_id = ${workspaceId}
            LIMIT 1`
  })

  const session = rows[0]
  if (!session) return c.json({ error: 'Session not found' }, 404)
  return c.json({ session } satisfies UpdateSessionResponse)
})
