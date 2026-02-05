/**
 * Folders API integration tests.
 *
 * Tests the /api/projects/:projectId/folders endpoints:
 * - POST /api/projects/:projectId/folders - Create folder
 * - GET /api/projects/:projectId/folders - List folders
 * - GET /api/projects/:projectId/folders/:id - Get folder
 * - GET /api/projects/:projectId/folders/:id/contents - Get folder contents count
 * - PATCH /api/projects/:projectId/folders/:id - Update folder (rename/move)
 * - DELETE /api/projects/:projectId/folders/:id - Soft delete folder
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
import { withAuth, type ApiResponse } from './helpers/api'

describe('Folders API', () => {
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
  // POST /api/projects/:projectId/folders - Create folder
  // ==========================================================================

  describe('POST /api/projects/:projectId/folders', () => {
    test('creates a folder at project root', async () => {
      const res = await api.post<{ folder: Record<string, unknown> }>(
        `/api/projects/${ctx.project.id}/folders`,
        { body: { name: 'Documents' } }
      )

      expect(res.status).toBe(201)
      expect(res.data.folder).toMatchObject({
        id: expect.any(String),
        project_id: ctx.project.id,
        parent_id: null,
        name: 'Documents',
        created_by: ctx.user.id,
        created_at: expect.any(String),
        updated_at: expect.any(String),
      })
    })

    test('creates a nested folder', async () => {
      // Create parent folder
      const parentRes = await api.post<{ folder: { id: string } }>(
        `/api/projects/${ctx.project.id}/folders`,
        { body: { name: 'Parent' } }
      )
      const parentId = parentRes.data.folder.id

      // Create child folder
      const res = await api.post<{ folder: Record<string, unknown> }>(
        `/api/projects/${ctx.project.id}/folders`,
        { body: { name: 'Child', parent_id: parentId } }
      )

      expect(res.status).toBe(201)
      expect(res.data.folder).toMatchObject({
        name: 'Child',
        parent_id: parentId,
      })
    })

    test('rejects empty folder name', async () => {
      const res = await api.post(
        `/api/projects/${ctx.project.id}/folders`,
        { body: { name: '' } }
      )

      expect(res.status).toBe(400)
      expect(res.data).toMatchObject({ error: 'Folder name cannot be empty' })
    })

    test('rejects folder name with invalid characters', async () => {
      const res = await api.post(
        `/api/projects/${ctx.project.id}/folders`,
        { body: { name: 'folder/name' } }
      )

      expect(res.status).toBe(400)
      expect(res.data).toMatchObject({ error: 'Folder name contains invalid characters' })
    })

    test('rejects duplicate folder name in same parent (409)', async () => {
      // Create first folder
      await api.post(
        `/api/projects/${ctx.project.id}/folders`,
        { body: { name: 'Documents' } }
      )

      // Try to create duplicate
      const res = await api.post(
        `/api/projects/${ctx.project.id}/folders`,
        { body: { name: 'Documents' } }
      )

      expect(res.status).toBe(409)
      expect(res.data).toMatchObject({ error: 'A folder with this name already exists in this location' })
    })

    test('allows same name in different parents', async () => {
      // Create two parent folders
      const parent1 = await api.post<{ folder: { id: string } }>(
        `/api/projects/${ctx.project.id}/folders`,
        { body: { name: 'Parent1' } }
      )
      const parent2 = await api.post<{ folder: { id: string } }>(
        `/api/projects/${ctx.project.id}/folders`,
        { body: { name: 'Parent2' } }
      )

      // Create same-named folder in each parent
      const res1 = await api.post(
        `/api/projects/${ctx.project.id}/folders`,
        { body: { name: 'Docs', parent_id: parent1.data.folder.id } }
      )
      const res2 = await api.post(
        `/api/projects/${ctx.project.id}/folders`,
        { body: { name: 'Docs', parent_id: parent2.data.folder.id } }
      )

      expect(res1.status).toBe(201)
      expect(res2.status).toBe(201)
    })

    test('rejects folder beyond depth 5 (400)', async () => {
      // Create folders up to depth 5
      let parentId: string | null = null
      for (let i = 1; i <= 5; i++) {
        const createRes: ApiResponse<{ folder: { id: string } }> = await api.post<{ folder: { id: string } }>(
          `/api/projects/${ctx.project.id}/folders`,
          { body: { name: `Level${i}`, parent_id: parentId ?? undefined } }
        )
        expect(createRes.status).toBe(201)
        parentId = createRes.data.folder.id
      }

      // Try to create depth 6 - should fail
      const res = await api.post(
        `/api/projects/${ctx.project.id}/folders`,
        { body: { name: 'Level6', parent_id: parentId! } }
      )

      expect(res.status).toBe(400)
      expect(res.data).toMatchObject({ error: 'Maximum folder depth of 5 exceeded' })
    })
  })

  // ==========================================================================
  // GET /api/projects/:projectId/folders - List folders
  // ==========================================================================

  describe('GET /api/projects/:projectId/folders', () => {
    test('returns empty list when no folders exist', async () => {
      const res = await api.get<{ folders: unknown[] }>(
        `/api/projects/${ctx.project.id}/folders`
      )

      expect(res.status).toBe(200)
      expect(res.data.folders).toEqual([])
    })

    test('returns all folders when no parent_id filter', async () => {
      // Create some folders
      await api.post(`/api/projects/${ctx.project.id}/folders`, { body: { name: 'Folder1' } })
      await api.post(`/api/projects/${ctx.project.id}/folders`, { body: { name: 'Folder2' } })
      await api.post(`/api/projects/${ctx.project.id}/folders`, { body: { name: 'Folder3' } })

      const res = await api.get<{ folders: Array<{ name: string }> }>(
        `/api/projects/${ctx.project.id}/folders`
      )

      expect(res.status).toBe(200)
      expect(res.data.folders).toHaveLength(3)
    })

    test('filters by parent_id', async () => {
      // Create parent and children
      const parent = await api.post<{ folder: { id: string } }>(
        `/api/projects/${ctx.project.id}/folders`,
        { body: { name: 'Parent' } }
      )
      await api.post(`/api/projects/${ctx.project.id}/folders`, { body: { name: 'Child1', parent_id: parent.data.folder.id } })
      await api.post(`/api/projects/${ctx.project.id}/folders`, { body: { name: 'Child2', parent_id: parent.data.folder.id } })
      await api.post(`/api/projects/${ctx.project.id}/folders`, { body: { name: 'RootFolder' } })

      // Get children of parent
      const res = await api.get<{ folders: Array<{ name: string }> }>(
        `/api/projects/${ctx.project.id}/folders?parent_id=${parent.data.folder.id}`
      )

      expect(res.status).toBe(200)
      expect(res.data.folders).toHaveLength(2)
      expect(res.data.folders.map(f => f.name).sort()).toEqual(['Child1', 'Child2'])
    })

    test('filters root folders with empty parent_id', async () => {
      // Create parent and child
      const parent = await api.post<{ folder: { id: string } }>(
        `/api/projects/${ctx.project.id}/folders`,
        { body: { name: 'RootFolder' } }
      )
      await api.post(`/api/projects/${ctx.project.id}/folders`, { body: { name: 'ChildFolder', parent_id: parent.data.folder.id } })

      // Get root folders only
      const res = await api.get<{ folders: Array<{ name: string }> }>(
        `/api/projects/${ctx.project.id}/folders?parent_id=`
      )

      expect(res.status).toBe(200)
      expect(res.data.folders).toHaveLength(1)
      expect(res.data.folders[0]!.name).toBe('RootFolder')
    })
  })

  // ==========================================================================
  // GET /api/projects/:projectId/folders/:id - Get single folder
  // ==========================================================================

  describe('GET /api/projects/:projectId/folders/:id', () => {
    test('returns folder by id', async () => {
      const createRes = await api.post<{ folder: { id: string } }>(
        `/api/projects/${ctx.project.id}/folders`,
        { body: { name: 'MyFolder' } }
      )
      const folderId = createRes.data.folder.id

      const res = await api.get<{ folder: Record<string, unknown> }>(
        `/api/projects/${ctx.project.id}/folders/${folderId}`
      )

      expect(res.status).toBe(200)
      expect(res.data.folder).toMatchObject({
        id: folderId,
        name: 'MyFolder',
        parent_id: null,
      })
    })

    test('returns 404 for non-existent folder', async () => {
      const res = await api.get(
        `/api/projects/${ctx.project.id}/folders/00000000-0000-0000-0000-000000000000`
      )

      expect(res.status).toBe(404)
      expect(res.data).toMatchObject({ error: 'Folder not found' })
    })
  })

  // ==========================================================================
  // GET /api/projects/:projectId/folders/:id/contents - Get folder contents count
  // ==========================================================================

  describe('GET /api/projects/:projectId/folders/:id/contents', () => {
    test('returns zero counts for empty folder', async () => {
      const createRes = await api.post<{ folder: { id: string } }>(
        `/api/projects/${ctx.project.id}/folders`,
        { body: { name: 'EmptyFolder' } }
      )
      const folderId = createRes.data.folder.id

      const res = await api.get<{ documentsCount: number; foldersCount: number }>(
        `/api/projects/${ctx.project.id}/folders/${folderId}/contents`
      )

      expect(res.status).toBe(200)
      expect(res.data).toMatchObject({
        documentsCount: 0,
        foldersCount: 0,
      })
    })

    test('returns counts including nested content', async () => {
      // Create folder structure:
      // Parent/
      //   Child1/
      //     GrandChild/
      //   Child2/
      const parent = await api.post<{ folder: { id: string } }>(
        `/api/projects/${ctx.project.id}/folders`,
        { body: { name: 'Parent' } }
      )
      const child1 = await api.post<{ folder: { id: string } }>(
        `/api/projects/${ctx.project.id}/folders`,
        { body: { name: 'Child1', parent_id: parent.data.folder.id } }
      )
      await api.post(
        `/api/projects/${ctx.project.id}/folders`,
        { body: { name: 'Child2', parent_id: parent.data.folder.id } }
      )
      await api.post(
        `/api/projects/${ctx.project.id}/folders`,
        { body: { name: 'GrandChild', parent_id: child1.data.folder.id } }
      )

      const res = await api.get<{ documentsCount: number; foldersCount: number }>(
        `/api/projects/${ctx.project.id}/folders/${parent.data.folder.id}/contents`
      )

      expect(res.status).toBe(200)
      expect(res.data).toMatchObject({
        documentsCount: 0, // No documents yet
        foldersCount: 3,   // Child1, Child2, GrandChild
      })
    })

    test('returns 404 for non-existent folder', async () => {
      const res = await api.get(
        `/api/projects/${ctx.project.id}/folders/00000000-0000-0000-0000-000000000000/contents`
      )

      expect(res.status).toBe(404)
    })
  })

  // ==========================================================================
  // PATCH /api/projects/:projectId/folders/:id - Rename folder
  // ==========================================================================

  describe('PATCH /api/projects/:projectId/folders/:id - Rename', () => {
    test('renames a folder', async () => {
      const createRes = await api.post<{ folder: { id: string } }>(
        `/api/projects/${ctx.project.id}/folders`,
        { body: { name: 'OldName' } }
      )
      const folderId = createRes.data.folder.id

      const res = await api.patch<{ folder: { name: string } }>(
        `/api/projects/${ctx.project.id}/folders/${folderId}`,
        { body: { name: 'NewName' } }
      )

      expect(res.status).toBe(200)
      expect(res.data.folder.name).toBe('NewName')
    })

    test('rejects rename to duplicate name in same parent', async () => {
      // Create two folders
      await api.post(`/api/projects/${ctx.project.id}/folders`, { body: { name: 'Folder1' } })
      const folder2 = await api.post<{ folder: { id: string } }>(
        `/api/projects/${ctx.project.id}/folders`,
        { body: { name: 'Folder2' } }
      )

      // Try to rename Folder2 to Folder1
      const res = await api.patch(
        `/api/projects/${ctx.project.id}/folders/${folder2.data.folder.id}`,
        { body: { name: 'Folder1' } }
      )

      expect(res.status).toBe(409)
    })

    test('returns 404 for non-existent folder', async () => {
      const res = await api.patch(
        `/api/projects/${ctx.project.id}/folders/00000000-0000-0000-0000-000000000000`,
        { body: { name: 'NewName' } }
      )

      expect(res.status).toBe(404)
    })
  })

  // ==========================================================================
  // PATCH /api/projects/:projectId/folders/:id - Move folder
  // ==========================================================================

  describe('PATCH /api/projects/:projectId/folders/:id - Move', () => {
    test('moves folder to different parent', async () => {
      // Create source and target folders
      const source = await api.post<{ folder: { id: string } }>(
        `/api/projects/${ctx.project.id}/folders`,
        { body: { name: 'ToMove' } }
      )
      const target = await api.post<{ folder: { id: string } }>(
        `/api/projects/${ctx.project.id}/folders`,
        { body: { name: 'Target' } }
      )

      const res = await api.patch<{ folder: { parent_id: string } }>(
        `/api/projects/${ctx.project.id}/folders/${source.data.folder.id}`,
        { body: { parent_id: target.data.folder.id } }
      )

      expect(res.status).toBe(200)
      expect(res.data.folder.parent_id).toBe(target.data.folder.id)
    })

    test('moves folder to root', async () => {
      // Create nested folder
      const parent = await api.post<{ folder: { id: string } }>(
        `/api/projects/${ctx.project.id}/folders`,
        { body: { name: 'Parent' } }
      )
      const child = await api.post<{ folder: { id: string } }>(
        `/api/projects/${ctx.project.id}/folders`,
        { body: { name: 'Child', parent_id: parent.data.folder.id } }
      )

      // Move child to root
      const res = await api.patch<{ folder: { parent_id: string | null } }>(
        `/api/projects/${ctx.project.id}/folders/${child.data.folder.id}`,
        { body: { parent_id: null } }
      )

      expect(res.status).toBe(200)
      expect(res.data.folder.parent_id).toBe(null)
    })

    test('rejects moving folder into itself', async () => {
      const folder = await api.post<{ folder: { id: string } }>(
        `/api/projects/${ctx.project.id}/folders`,
        { body: { name: 'Folder' } }
      )

      const res = await api.patch(
        `/api/projects/${ctx.project.id}/folders/${folder.data.folder.id}`,
        { body: { parent_id: folder.data.folder.id } }
      )

      expect(res.status).toBe(400)
      expect(res.data).toMatchObject({ error: 'Cannot move folder into itself or its descendants' })
    })

    test('rejects moving folder into its descendant', async () => {
      // Create Parent -> Child structure
      const parent = await api.post<{ folder: { id: string } }>(
        `/api/projects/${ctx.project.id}/folders`,
        { body: { name: 'Parent' } }
      )
      const child = await api.post<{ folder: { id: string } }>(
        `/api/projects/${ctx.project.id}/folders`,
        { body: { name: 'Child', parent_id: parent.data.folder.id } }
      )

      // Try to move parent into child (its descendant)
      const res = await api.patch(
        `/api/projects/${ctx.project.id}/folders/${parent.data.folder.id}`,
        { body: { parent_id: child.data.folder.id } }
      )

      expect(res.status).toBe(400)
      expect(res.data).toMatchObject({ error: 'Cannot move folder into itself or its descendants' })
    })

    test('rejects move that would exceed max depth', async () => {
      // Create a deep chain (4 levels)
      let parentId: string | null = null
      for (let i = 1; i <= 4; i++) {
        const createRes: ApiResponse<{ folder: { id: string } }> = await api.post<{ folder: { id: string } }>(
          `/api/projects/${ctx.project.id}/folders`,
          { body: { name: `Level${i}`, parent_id: parentId ?? undefined } }
        )
        parentId = createRes.data.folder.id
      }

      // Create a separate folder with a child
      const other = await api.post<{ folder: { id: string } }>(
        `/api/projects/${ctx.project.id}/folders`,
        { body: { name: 'Other' } }
      )
      const otherChild = await api.post<{ folder: { id: string } }>(
        `/api/projects/${ctx.project.id}/folders`,
        { body: { name: 'OtherChild', parent_id: other.data.folder.id } }
      )

      // Try to move 'Other' (which has a child) into Level4
      // This would make OtherChild at depth 6, exceeding limit
      const res = await api.patch(
        `/api/projects/${ctx.project.id}/folders/${other.data.folder.id}`,
        { body: { parent_id: parentId! } }
      )

      expect(res.status).toBe(400)
      expect(res.data).toMatchObject({ error: 'Maximum folder depth of 5 exceeded' })
    })
  })

  // ==========================================================================
  // DELETE /api/projects/:projectId/folders/:id - Soft delete folder
  // ==========================================================================

  describe('DELETE /api/projects/:projectId/folders/:id', () => {
    test('soft deletes an empty folder', async () => {
      const createRes = await api.post<{ folder: { id: string } }>(
        `/api/projects/${ctx.project.id}/folders`,
        { body: { name: 'ToDelete' } }
      )
      const folderId = createRes.data.folder.id

      const res = await api.del<{ success: boolean; documentsDeleted: number; foldersDeleted: number }>(
        `/api/projects/${ctx.project.id}/folders/${folderId}`
      )

      expect(res.status).toBe(200)
      expect(res.data).toMatchObject({
        success: true,
        documentsDeleted: 0,
        foldersDeleted: 0,
      })

      // Verify it's no longer accessible
      const getRes = await api.get(`/api/projects/${ctx.project.id}/folders/${folderId}`)
      expect(getRes.status).toBe(404)
    })

    test('soft deletes folder with nested folders', async () => {
      // Create Parent -> Child1, Child2 structure
      const parent = await api.post<{ folder: { id: string } }>(
        `/api/projects/${ctx.project.id}/folders`,
        { body: { name: 'Parent' } }
      )
      const child1 = await api.post<{ folder: { id: string } }>(
        `/api/projects/${ctx.project.id}/folders`,
        { body: { name: 'Child1', parent_id: parent.data.folder.id } }
      )
      await api.post(
        `/api/projects/${ctx.project.id}/folders`,
        { body: { name: 'Child2', parent_id: parent.data.folder.id } }
      )

      // Delete parent
      const res = await api.del<{ success: boolean; foldersDeleted: number }>(
        `/api/projects/${ctx.project.id}/folders/${parent.data.folder.id}`
      )

      expect(res.status).toBe(200)
      expect(res.data.foldersDeleted).toBe(2) // Child1 + Child2

      // Verify children are also deleted
      const child1Res = await api.get(`/api/projects/${ctx.project.id}/folders/${child1.data.folder.id}`)
      expect(child1Res.status).toBe(404)
    })

    test('returns 404 for non-existent folder', async () => {
      const res = await api.del(
        `/api/projects/${ctx.project.id}/folders/00000000-0000-0000-0000-000000000000`
      )

      expect(res.status).toBe(404)
    })

    test('returns 404 for already deleted folder', async () => {
      const createRes = await api.post<{ folder: { id: string } }>(
        `/api/projects/${ctx.project.id}/folders`,
        { body: { name: 'ToDelete' } }
      )
      const folderId = createRes.data.folder.id

      // Delete once
      await api.del(`/api/projects/${ctx.project.id}/folders/${folderId}`)

      // Try to delete again
      const res = await api.del(`/api/projects/${ctx.project.id}/folders/${folderId}`)

      expect(res.status).toBe(404)
    })
  })

  // ==========================================================================
  // Authentication/Authorization
  // ==========================================================================

  describe('Authentication', () => {
    test('requires authentication', async () => {
      const { post } = await import('./helpers/api')
      const res = await post(`/api/projects/${ctx.project.id}/folders`, {
        body: { name: 'Test' },
      })

      expect(res.status).toBe(401)
    })

    test('requires workspace_id header', async () => {
      const { post } = await import('./helpers/api')
      const res = await post(`/api/projects/${ctx.project.id}/folders`, {
        token: ctx.token,
        body: { name: 'Test' },
      })

      expect(res.status).toBe(400)
    })
  })
})
