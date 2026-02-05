/**
 * Tree API integration tests.
 *
 * Tests the GET /api/projects/:projectId/tree endpoint.
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

// Set up test environment before importing the app
setupTestEnvironment()

// Import after setup
import { withAuth } from './helpers/api'
import type { TreeNode, GetTreeResponse } from '@claude-agent/shared'

describe('Tree API', () => {
  let ctx: TestContext
  let api: ReturnType<typeof withAuth>

  beforeAll(async () => {
    ctx = await createTestContext()
    api = withAuth(ctx.token, ctx.workspace.id)
  })

  beforeEach(async () => {
    await resetAgentTables()
  })

  afterAll(async () => {
    await closeTestConnections()
  })

  // ==========================================================================
  // GET /api/projects/:projectId/tree
  // ==========================================================================

  describe('GET /api/projects/:projectId/tree', () => {
    test('returns empty list when project has no folders or documents', async () => {
      const res = await api.get<GetTreeResponse>(
        `/api/projects/${ctx.project.id}/tree`
      )

      expect(res.status).toBe(200)
      expect(res.data.nodes).toEqual([])
    })

    test('returns folders and documents in flat list', async () => {
      // Create a folder
      const folderRes = await api.post<{ folder: { id: string; name: string } }>(
        `/api/projects/${ctx.project.id}/folders`,
        { body: { name: 'Documents' } }
      )
      const folderId = folderRes.data.folder.id

      // Create a document at root
      const docRes = await api.post<{ document: { id: string; name: string } }>(
        `/api/documents`,
        { body: { name: 'README', project_id: ctx.project.id } }
      )
      const docId = docRes.data.document.id

      // Get tree
      const res = await api.get<GetTreeResponse>(
        `/api/projects/${ctx.project.id}/tree`
      )

      expect(res.status).toBe(200)
      expect(res.data.nodes).toHaveLength(2)

      // Find folder and document in results
      const folderNode = res.data.nodes.find(n => n.id === folderId)
      const docNode = res.data.nodes.find(n => n.id === docId)

      expect(folderNode).toMatchObject({
        id: folderId,
        name: 'Documents',
        type: 'folder',
        parent_id: null,
        updated_at: expect.any(String),
      })

      expect(docNode).toMatchObject({
        id: docId,
        name: 'README',
        type: 'document',
        parent_id: null,
        updated_at: expect.any(String),
      })
    })

    test('returns proper parent_id relationships', async () => {
      // Create folder structure:
      // Parent/
      //   Child/
      //     doc.md
      const parentRes = await api.post<{ folder: { id: string } }>(
        `/api/projects/${ctx.project.id}/folders`,
        { body: { name: 'Parent' } }
      )
      const parentId = parentRes.data.folder.id

      const childRes = await api.post<{ folder: { id: string } }>(
        `/api/projects/${ctx.project.id}/folders`,
        { body: { name: 'Child', parent_id: parentId } }
      )
      const childId = childRes.data.folder.id

      // Create document in child folder
      const docRes = await api.post<{ document: { id: string } }>(
        `/api/documents`,
        { body: { name: 'doc', project_id: ctx.project.id, folder_id: childId } }
      )
      const docId = docRes.data.document.id

      // Get tree
      const res = await api.get<GetTreeResponse>(
        `/api/projects/${ctx.project.id}/tree`
      )

      expect(res.status).toBe(200)
      expect(res.data.nodes).toHaveLength(3)

      // Verify relationships
      const parentNode = res.data.nodes.find(n => n.id === parentId)
      const childNode = res.data.nodes.find(n => n.id === childId)
      const docNode = res.data.nodes.find(n => n.id === docId)

      expect(parentNode?.parent_id).toBe(null)
      expect(childNode?.parent_id).toBe(parentId)
      expect(docNode?.parent_id).toBe(childId)
    })

    test('documents show folder_id as parent_id', async () => {
      // Create a folder
      const folderRes = await api.post<{ folder: { id: string } }>(
        `/api/projects/${ctx.project.id}/folders`,
        { body: { name: 'Folder' } }
      )
      const folderId = folderRes.data.folder.id

      // Create document in folder
      const docRes = await api.post<{ document: { id: string } }>(
        `/api/documents`,
        { body: { name: 'nested-doc', project_id: ctx.project.id, folder_id: folderId } }
      )
      const docId = docRes.data.document.id

      // Get tree
      const res = await api.get<GetTreeResponse>(
        `/api/projects/${ctx.project.id}/tree`
      )

      const docNode = res.data.nodes.find(n => n.id === docId)
      expect(docNode?.type).toBe('document')
      expect(docNode?.parent_id).toBe(folderId)
    })

    test('does not include deleted folders', async () => {
      // Create and delete a folder
      const folderRes = await api.post<{ folder: { id: string } }>(
        `/api/projects/${ctx.project.id}/folders`,
        { body: { name: 'ToDelete' } }
      )
      await api.del(`/api/projects/${ctx.project.id}/folders/${folderRes.data.folder.id}`)

      // Create a folder that stays
      const keepRes = await api.post<{ folder: { id: string } }>(
        `/api/projects/${ctx.project.id}/folders`,
        { body: { name: 'Keep' } }
      )

      // Get tree
      const res = await api.get<GetTreeResponse>(
        `/api/projects/${ctx.project.id}/tree`
      )

      expect(res.data.nodes).toHaveLength(1)
      expect(res.data.nodes[0]!.name).toBe('Keep')
    })

    test('returns 404 for non-existent project', async () => {
      const res = await api.get(
        `/api/projects/00000000-0000-0000-0000-000000000000/tree`
      )

      expect(res.status).toBe(404)
    })

    test('returns nodes sorted by name', async () => {
      // Create folders in non-alphabetical order
      await api.post(`/api/projects/${ctx.project.id}/folders`, { body: { name: 'Zebra' } })
      await api.post(`/api/projects/${ctx.project.id}/folders`, { body: { name: 'Apple' } })
      await api.post(`/api/projects/${ctx.project.id}/folders`, { body: { name: 'Mango' } })

      // Get tree
      const res = await api.get<GetTreeResponse>(
        `/api/projects/${ctx.project.id}/tree`
      )

      const folderNames = res.data.nodes.filter(n => n.type === 'folder').map(n => n.name)
      expect(folderNames).toEqual(['Apple', 'Mango', 'Zebra'])
    })
  })
})
