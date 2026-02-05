import { Hono } from 'hono'
import type {
  BreadcrumbItem,
  CreateDocumentRequest,
  CreateDocumentResponse,
  GetDocumentResponse,
  ListDocumentsResponse,
  UpdateDocumentRequest,
  UpdateDocumentResponse,
} from '@claude-agent/shared'
import * as docManager from '../document-manager'
import * as folderManager from '../folder-manager'

type Env = { Variables: { userId: string; workspaceId: string } }

export const documentsRouter = new Hono<Env>()

// POST /api/documents
documentsRouter.post('/', async (c) => {
  const userId = c.get('userId')
  const body = await c.req.json<CreateDocumentRequest>()

  if (!body.project_id) {
    return c.json({ error: 'project_id is required' }, 400)
  }

  const info = await docManager.createDoc(userId, body.project_id, body.name, body.content, body.folder_id)

  return c.json({
    document: {
      id: info.id,
      project_id: info.project_id,
      workspace_id: info.workspace_id,
      folder_id: info.folder_id,
      name: info.name,
      created_by: info.created_by,
      created_at: info.created_at,
      updated_at: info.updated_at,
    },
  } satisfies CreateDocumentResponse, 201)
})

// GET /api/documents?project_id=xxx&folder_id=xxx (optional)
documentsRouter.get('/', async (c) => {
  const userId = c.get('userId')
  const projectId = c.req.query('project_id')
  const folderIdParam = c.req.query('folder_id')

  if (!projectId) {
    return c.json({ error: 'project_id query parameter is required' }, 400)
  }

  // Parse folder_id: undefined = all docs, 'null' string = root only, uuid = specific folder
  const folderId = folderIdParam === undefined
    ? undefined  // no filter, all docs
    : folderIdParam === 'null' || folderIdParam === ''
      ? null  // root level docs only
      : folderIdParam  // specific folder

  const documents = await docManager.listDocs(userId, projectId, folderId)

  return c.json({
    documents: documents.map((d) => ({
      id: d.id,
      project_id: d.project_id,
      workspace_id: d.workspace_id,
      folder_id: d.folder_id,
      name: d.name,
      created_by: d.created_by,
      created_at: d.created_at,
      updated_at: d.updated_at,
    })),
  } satisfies ListDocumentsResponse)
})

// GET /api/documents/:id?project_id=xxx
documentsRouter.get('/:id', async (c) => {
  const userId = c.get('userId')
  const docId = c.req.param('id')
  const projectId = c.req.query('project_id')

  if (!projectId) {
    return c.json({ error: 'project_id query parameter is required' }, 400)
  }

  const result = await docManager.readDocAsText(userId, projectId, docId)
  if (!result) return c.json({ error: 'Document not found' }, 404)

  const info = await docManager.getDocInfo(userId, projectId, docId)
  if (!info) return c.json({ error: 'Document not found' }, 404)

  // Build breadcrumb: folder ancestors + the document itself
  const folderBreadcrumb = await folderManager.getBreadcrumb(userId, projectId, info.folder_id)
  const breadcrumb: BreadcrumbItem[] = [
    ...folderBreadcrumb,
    { id: info.id, name: info.name, type: 'document' },
  ]

  return c.json({
    document: {
      id: info.id,
      project_id: info.project_id,
      workspace_id: info.workspace_id,
      folder_id: info.folder_id,
      name: info.name,
      created_by: info.created_by,
      created_at: info.created_at,
      updated_at: info.updated_at,
      content: result.content,
      breadcrumb,
    },
  } satisfies GetDocumentResponse)
})

// PATCH /api/documents/:id
documentsRouter.patch('/:id', async (c) => {
  const userId = c.get('userId')
  const docId = c.req.param('id')
  const body = await c.req.json<UpdateDocumentRequest>()

  if (!body.project_id) {
    return c.json({ error: 'project_id is required' }, 400)
  }

  const existing = await docManager.getDocInfo(userId, body.project_id, docId)
  if (!existing) return c.json({ error: 'Document not found' }, 404)

  if (body.content !== undefined) {
    await docManager.replaceDocContent(userId, body.project_id, docId, body.content)
  }
  if (body.name !== undefined) {
    await docManager.renameDoc(userId, body.project_id, docId, body.name)
  }
  if (body.folder_id !== undefined) {
    await docManager.moveDoc(userId, body.project_id, docId, body.folder_id)
  }

  const updated = await docManager.getDocInfo(userId, body.project_id, docId)
  if (!updated) return c.json({ error: 'Document not found' }, 404)

  return c.json({
    document: {
      id: updated.id,
      project_id: updated.project_id,
      workspace_id: updated.workspace_id,
      folder_id: updated.folder_id,
      name: updated.name,
      created_by: updated.created_by,
      created_at: updated.created_at,
      updated_at: updated.updated_at,
    },
  } satisfies UpdateDocumentResponse)
})

// DELETE /api/documents/:id?project_id=xxx
documentsRouter.delete('/:id', async (c) => {
  const userId = c.get('userId')
  const docId = c.req.param('id')
  const projectId = c.req.query('project_id')

  if (!projectId) {
    return c.json({ error: 'project_id query parameter is required' }, 400)
  }

  const deleted = await docManager.deleteDoc(userId, projectId, docId)
  if (!deleted) return c.json({ error: 'Document not found' }, 404)

  return c.json({ success: true })
})
