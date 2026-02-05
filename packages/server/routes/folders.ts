import { Hono } from 'hono'
import type {
  CreateFolderRequest,
  CreateFolderResponse,
  DeleteFolderResponse,
  GetFolderContentsResponse,
  GetFolderResponse,
  ListFoldersResponse,
  UpdateFolderRequest,
  UpdateFolderResponse,
} from '@claude-agent/shared'
import * as folderManager from '../folder-manager'

type Env = { Variables: { userId: string; workspaceId: string } }

export const foldersRouter = new Hono<Env>()

// POST /api/projects/:projectId/folders - Create a new folder
foldersRouter.post('/', async (c) => {
  const userId = c.get('userId')
  const projectId = c.req.param('projectId')!
  const body = await c.req.json<CreateFolderRequest>()

  try {
    const folder = await folderManager.createFolder(
      userId,
      projectId,
      body.name,
      body.parent_id,
    )
    return c.json({ folder } satisfies CreateFolderResponse, 201)
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Failed to create folder'
    // Check for unique constraint violation
    if (message.includes('unique') || message.includes('duplicate')) {
      return c.json({ error: 'A folder with this name already exists in this location' }, 409)
    }
    return c.json({ error: message }, 400)
  }
})

// GET /api/projects/:projectId/folders - List folders
foldersRouter.get('/', async (c) => {
  const userId = c.get('userId')
  const projectId = c.req.param('projectId')!
  const parentIdParam = c.req.query('parent_id') // optional filter

  // Convert query param to proper type:
  // - undefined (no param): list all folders
  // - empty string: list root folders (parent_id is null)
  // - string value: list children of that parent
  let parentId: string | null | undefined = undefined
  if (parentIdParam !== undefined) {
    parentId = parentIdParam === '' ? null : parentIdParam
  }

  const folders = await folderManager.listFolders(userId, projectId, parentId)
  return c.json({ folders } satisfies ListFoldersResponse)
})

// GET /api/projects/:projectId/folders/:id - Get single folder
foldersRouter.get('/:id', async (c) => {
  const userId = c.get('userId')
  const projectId = c.req.param('projectId')!
  const folderId = c.req.param('id')!

  const folder = await folderManager.getFolder(userId, projectId, folderId)
  if (!folder) return c.json({ error: 'Folder not found' }, 404)

  return c.json({ folder } satisfies GetFolderResponse)
})

// GET /api/projects/:projectId/folders/:id/contents - Get folder contents counts (for delete confirmation)
foldersRouter.get('/:id/contents', async (c) => {
  const userId = c.get('userId')
  const projectId = c.req.param('projectId')!
  const folderId = c.req.param('id')!

  const contents = await folderManager.getFolderContents(userId, projectId, folderId)
  if (!contents) return c.json({ error: 'Folder not found' }, 404)

  return c.json(contents satisfies GetFolderContentsResponse)
})

// PATCH /api/projects/:projectId/folders/:id - Update folder (rename or move)
foldersRouter.patch('/:id', async (c) => {
  const userId = c.get('userId')
  const projectId = c.req.param('projectId')!
  const folderId = c.req.param('id')!
  const body = await c.req.json<UpdateFolderRequest>()

  try {
    let folder = await folderManager.getFolder(userId, projectId, folderId)
    if (!folder) return c.json({ error: 'Folder not found' }, 404)

    // Handle rename
    if (body.name !== undefined) {
      folder = await folderManager.renameFolder(userId, projectId, folderId, body.name)
      if (!folder) return c.json({ error: 'Folder not found' }, 404)
    }

    // Handle move (parent_id can be null to move to root)
    if (body.parent_id !== undefined) {
      folder = await folderManager.moveFolder(userId, projectId, folderId, body.parent_id)
      if (!folder) return c.json({ error: 'Folder not found' }, 404)
    }

    return c.json({ folder } satisfies UpdateFolderResponse)
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Failed to update folder'
    if (message.includes('unique') || message.includes('duplicate')) {
      return c.json({ error: 'A folder with this name already exists in this location' }, 409)
    }
    if (message.includes('depth')) {
      return c.json({ error: message }, 400)
    }
    if (message.includes('itself')) {
      return c.json({ error: message }, 400)
    }
    return c.json({ error: message }, 400)
  }
})

// DELETE /api/projects/:projectId/folders/:id - Soft delete folder and contents
foldersRouter.delete('/:id', async (c) => {
  const userId = c.get('userId')
  const projectId = c.req.param('projectId')!
  const folderId = c.req.param('id')!

  const result = await folderManager.deleteFolder(userId, projectId, folderId)
  if (!result.deleted) return c.json({ error: 'Folder not found' }, 404)

  return c.json({
    success: true,
    documentsDeleted: result.documentsDeleted,
    foldersDeleted: result.foldersDeleted,
  } satisfies DeleteFolderResponse)
})
