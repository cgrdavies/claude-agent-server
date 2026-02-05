import { Hono } from 'hono'
import type {
  CreateProjectRequest,
  CreateProjectResponse,
  DeleteProjectResponse,
  GetProjectResponse,
  GetTreeResponse,
  ListProjectsResponse,
  RestoreProjectResponse,
  SearchResponse,
  SearchResult,
  TreeNode,
  UpdateProjectRequest,
  UpdateProjectResponse,
} from '@claude-agent/shared'
import { withRLS } from '../lib/db'
import { foldersRouter } from './folders'
import { sessionsRouter } from './sessions'
import { messagesRouter } from './messages'
import { documentsRouter } from './documents'
import * as folderManager from '../folder-manager'

type Env = { Variables: { userId: string; workspaceId: string; isSuperuser: boolean } }

export const projectsRouter = new Hono<Env>()

// POST /api/projects - Create a new project
projectsRouter.post('/', async (c) => {
  const userId = c.get('userId')
  const workspaceId = c.get('workspaceId')
  const body = await c.req.json<CreateProjectRequest>()

  // Validate name
  const name = body.name?.trim()
  if (!name) {
    return c.json({ error: 'Project name is required' }, 400)
  }
  if (name.length > 100) {
    return c.json({ error: 'Project name must be 100 characters or less' }, 400)
  }

  const rows = await withRLS(userId, (sql) =>
    sql`INSERT INTO projects (workspace_id, name, description, created_by)
        VALUES (${workspaceId}, ${name}, ${body.description ?? null}, ${userId})
        RETURNING id, workspace_id, name, description, is_archived, deleted_at, created_by, created_at, updated_at`
  )
  const project = rows[0]

  return c.json({ project } satisfies CreateProjectResponse, 201)
})

// GET /api/projects - List all non-deleted projects in workspace
projectsRouter.get('/', async (c) => {
  const userId = c.get('userId')
  const workspaceId = c.get('workspaceId')

  const projects = await withRLS(userId, (sql) =>
    sql`SELECT id, workspace_id, name, description, is_archived, deleted_at, created_by, created_at, updated_at
        FROM projects
        WHERE workspace_id = ${workspaceId}
          AND deleted_at IS NULL
        ORDER BY updated_at DESC`
  )

  return c.json({ projects } satisfies ListProjectsResponse)
})

// GET /api/projects/:projectId - Get a single project
projectsRouter.get('/:projectId', async (c) => {
  const userId = c.get('userId')
  const projectId = c.req.param('projectId')

  const rows = await withRLS(userId, (sql) =>
    sql`SELECT id, workspace_id, name, description, is_archived, deleted_at, created_by, created_at, updated_at
        FROM projects
        WHERE id = ${projectId}
          AND deleted_at IS NULL
        LIMIT 1`
  )
  const project = rows[0]
  if (!project) return c.json({ error: 'Project not found' }, 404)

  return c.json({ project } satisfies GetProjectResponse)
})

// PATCH /api/projects/:projectId - Update project (name, description)
projectsRouter.patch('/:projectId', async (c) => {
  const userId = c.get('userId')
  const projectId = c.req.param('projectId')
  const body = await c.req.json<UpdateProjectRequest>()

  // Validate name if provided
  if (body.name !== undefined) {
    const name = body.name?.trim()
    if (!name) {
      return c.json({ error: 'Project name cannot be empty' }, 400)
    }
    if (name.length > 100) {
      return c.json({ error: 'Project name must be 100 characters or less' }, 400)
    }
  }

  // Check if project exists and is not deleted
  const existing = await withRLS(userId, (sql) =>
    sql`SELECT id FROM projects WHERE id = ${projectId} AND deleted_at IS NULL LIMIT 1`
  )
  if (existing.length === 0) {
    return c.json({ error: 'Project not found' }, 404)
  }

  // Build update dynamically
  const rows = await withRLS(userId, (sql) =>
    sql`UPDATE projects
        SET name = COALESCE(${body.name?.trim() ?? null}, name),
            description = COALESCE(${body.description ?? null}, description),
            updated_at = now()
        WHERE id = ${projectId}
          AND deleted_at IS NULL
        RETURNING id, workspace_id, name, description, is_archived, deleted_at, created_by, created_at, updated_at`
  )
  const project = rows[0]
  if (!project) return c.json({ error: 'Project not found' }, 404)

  return c.json({ project } satisfies UpdateProjectResponse)
})

// DELETE /api/projects/:projectId - Soft delete project (superusers only)
projectsRouter.delete('/:projectId', async (c) => {
  const userId = c.get('userId')
  const isSuperuser = c.get('isSuperuser')
  const projectId = c.req.param('projectId')

  // Only superusers can delete projects
  if (!isSuperuser) {
    return c.json({ error: 'Only superusers can delete projects' }, 403)
  }

  // Soft delete: set deleted_at timestamp
  const result = await withRLS(userId, (sql) =>
    sql`UPDATE projects
        SET deleted_at = now(), updated_at = now()
        WHERE id = ${projectId}
          AND deleted_at IS NULL
        RETURNING id`
  )

  if (result.length === 0) {
    return c.json({ error: 'Project not found' }, 404)
  }

  return c.json({ success: true } satisfies DeleteProjectResponse)
})

// POST /api/projects/:projectId/restore - Restore soft-deleted project (superusers only)
projectsRouter.post('/:projectId/restore', async (c) => {
  const userId = c.get('userId')
  const isSuperuser = c.get('isSuperuser')
  const projectId = c.req.param('projectId')

  // Only superusers can restore projects
  if (!isSuperuser) {
    return c.json({ error: 'Only superusers can restore projects' }, 403)
  }

  // Restore: clear deleted_at timestamp
  const rows = await withRLS(userId, (sql) =>
    sql`UPDATE projects
        SET deleted_at = NULL, updated_at = now()
        WHERE id = ${projectId}
          AND deleted_at IS NOT NULL
        RETURNING id, workspace_id, name, description, is_archived, deleted_at, created_by, created_at, updated_at`
  )

  if (rows.length === 0) {
    return c.json({ error: 'Project not found or not deleted' }, 404)
  }

  return c.json({ project: rows[0] } satisfies RestoreProjectResponse)
})

// GET /api/projects/:projectId/tree - Get complete project structure
projectsRouter.get('/:projectId/tree', async (c) => {
  const userId = c.get('userId')
  const projectId = c.req.param('projectId')

  // Verify project exists and user has access
  const projectRows = await withRLS(userId, (sql) =>
    sql`SELECT id FROM projects WHERE id = ${projectId} AND deleted_at IS NULL LIMIT 1`
  )
  if (projectRows.length === 0) {
    return c.json({ error: 'Project not found' }, 404)
  }

  // Get all folders
  const folderRows = await withRLS(userId, (sql) =>
    sql`SELECT id, parent_id, name, updated_at
        FROM folders
        WHERE project_id = ${projectId} AND deleted_at IS NULL
        ORDER BY name ASC`
  )

  // Get all documents
  const docRows = await withRLS(userId, (sql) =>
    sql`SELECT id, folder_id as parent_id, name, updated_at
        FROM documents
        WHERE project_id = ${projectId} AND deleted_at IS NULL
        ORDER BY name ASC`
  )

  const nodes: TreeNode[] = [
    ...(
      folderRows as unknown as Array<{
        id: string
        parent_id: string | null
        name: string
        updated_at: string
      }>
    ).map((f) => ({
      id: f.id,
      name: f.name,
      type: 'folder' as const,
      parent_id: f.parent_id,
      updated_at: f.updated_at,
    })),
    ...(
      docRows as unknown as Array<{
        id: string
        parent_id: string | null
        name: string
        updated_at: string
      }>
    ).map((d) => ({
      id: d.id,
      name: d.name,
      type: 'document' as const,
      parent_id: d.parent_id,
      updated_at: d.updated_at,
    })),
  ]

  return c.json({ nodes } satisfies GetTreeResponse)
})

// GET /api/projects/:projectId/search - Search documents and folders by name
projectsRouter.get('/:projectId/search', async (c) => {
  const userId = c.get('userId')
  const projectId = c.req.param('projectId')
  const query = c.req.query('q')
  const type = c.req.query('type') as 'all' | 'documents' | 'folders' | undefined

  if (!query || query.length < 1) {
    return c.json({ results: [] } satisfies SearchResponse)
  }

  // Verify project exists and user has access
  const projectRows = await withRLS(userId, (sql) =>
    sql`SELECT id FROM projects WHERE id = ${projectId} AND deleted_at IS NULL LIMIT 1`
  )
  if (projectRows.length === 0) {
    return c.json({ error: 'Project not found' }, 404)
  }

  // Escape special characters for ILIKE
  const searchPattern = `%${query.replace(/[%_]/g, '\\$&')}%`

  const results: SearchResult[] = []

  // Search folders
  if (type === 'all' || type === 'folders' || !type) {
    const folderRows = await withRLS(userId, (sql) =>
      sql`SELECT id, parent_id, name
          FROM folders
          WHERE project_id = ${projectId}
            AND deleted_at IS NULL
            AND name ILIKE ${searchPattern}
          ORDER BY name ASC
          LIMIT 20`
    )

    for (const row of folderRows as unknown as Array<{
      id: string
      parent_id: string | null
      name: string
    }>) {
      const breadcrumb = await folderManager.getBreadcrumb(userId, projectId, row.parent_id)
      results.push({
        id: row.id,
        name: row.name,
        type: 'folder',
        parent_id: row.parent_id,
        breadcrumb,
      })
    }
  }

  // Search documents
  if (type === 'all' || type === 'documents' || !type) {
    const docRows = await withRLS(userId, (sql) =>
      sql`SELECT id, folder_id, name
          FROM documents
          WHERE project_id = ${projectId}
            AND deleted_at IS NULL
            AND name ILIKE ${searchPattern}
          ORDER BY name ASC
          LIMIT 20`
    )

    for (const row of docRows as unknown as Array<{
      id: string
      folder_id: string | null
      name: string
    }>) {
      const breadcrumb = await folderManager.getBreadcrumb(userId, projectId, row.folder_id)
      results.push({
        id: row.id,
        name: row.name,
        type: 'document',
        parent_id: row.folder_id,
        breadcrumb,
      })
    }
  }

  // Sort by name
  results.sort((a, b) => a.name.localeCompare(b.name))

  return c.json({ results: results.slice(0, 20) } satisfies SearchResponse)
})

// Mount nested routers
projectsRouter.route('/:projectId/folders', foldersRouter)
projectsRouter.route('/:projectId/sessions', sessionsRouter)
// Messages are nested under sessions, but mounted here to expose:
// POST /api/projects/:projectId/sessions/:sessionId/messages
projectsRouter.route('/:projectId/sessions', messagesRouter)
projectsRouter.route('/:projectId/documents', documentsRouter)
