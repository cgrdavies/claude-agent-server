import { Hono } from 'hono'
import type {
  CreateDocumentRequest,
  CreateDocumentResponse,
  GetDocumentResponse,
  ListDocumentsResponse,
  UpdateDocumentRequest,
  UpdateDocumentResponse,
} from '@claude-agent/shared'
import * as docManager from '../document-manager'

type Env = { Variables: { userId: string; workspaceId: string } }

export const documentsRouter = new Hono<Env>()

// POST /api/documents
documentsRouter.post('/', async (c) => {
  const userId = c.get('userId')
  const workspaceId = c.get('workspaceId')
  const body = await c.req.json<CreateDocumentRequest>()

  const info = await docManager.createDoc(userId, workspaceId, body.name, body.content)

  return c.json({
    document: {
      id: info.id,
      workspace_id: info.workspace_id,
      name: info.name,
      created_by: info.created_by,
      created_at: info.created_at,
      updated_at: info.updated_at,
    },
  } satisfies CreateDocumentResponse, 201)
})

// GET /api/documents
documentsRouter.get('/', async (c) => {
  const userId = c.get('userId')
  const workspaceId = c.get('workspaceId')

  const docs = await docManager.listDocs(userId, workspaceId)

  return c.json({
    documents: docs.map((d) => ({
      id: d.id,
      workspace_id: d.workspace_id,
      name: d.name,
      created_by: d.created_by,
      created_at: d.created_at,
      updated_at: d.updated_at,
    })),
  } satisfies ListDocumentsResponse)
})

// GET /api/documents/:id
documentsRouter.get('/:id', async (c) => {
  const userId = c.get('userId')
  const workspaceId = c.get('workspaceId')
  const docId = c.req.param('id')

  const result = await docManager.readDocAsText(userId, workspaceId, docId)
  if (!result) return c.json({ error: 'Document not found' }, 404)

  const info = await docManager.getDocInfo(userId, workspaceId, docId)
  if (!info) return c.json({ error: 'Document not found' }, 404)

  return c.json({
    document: {
      id: info.id,
      workspace_id: info.workspace_id,
      name: info.name,
      created_by: info.created_by,
      created_at: info.created_at,
      updated_at: info.updated_at,
      content: result.content,
    },
  } satisfies GetDocumentResponse)
})

// PATCH /api/documents/:id
documentsRouter.patch('/:id', async (c) => {
  const userId = c.get('userId')
  const workspaceId = c.get('workspaceId')
  const docId = c.req.param('id')
  const body = await c.req.json<UpdateDocumentRequest>()

  const existing = await docManager.getDocInfo(userId, workspaceId, docId)
  if (!existing) return c.json({ error: 'Document not found' }, 404)

  if (body.content !== undefined) {
    await docManager.replaceDocContent(userId, workspaceId, docId, body.content)
  }

  if (body.name !== undefined) {
    await docManager.renameDoc(userId, workspaceId, docId, body.name)
  }

  const updated = await docManager.getDocInfo(userId, workspaceId, docId)
  if (!updated) return c.json({ error: 'Document not found' }, 404)

  return c.json({
    document: {
      id: updated.id,
      workspace_id: updated.workspace_id,
      name: updated.name,
      created_by: updated.created_by,
      created_at: updated.created_at,
      updated_at: updated.updated_at,
    },
  } satisfies UpdateDocumentResponse)
})

// DELETE /api/documents/:id
documentsRouter.delete('/:id', async (c) => {
  const userId = c.get('userId')
  const workspaceId = c.get('workspaceId')
  const docId = c.req.param('id')

  const deleted = await docManager.deleteDoc(userId, workspaceId, docId)
  if (!deleted) return c.json({ error: 'Document not found' }, 404)

  return c.json({ success: true })
})
