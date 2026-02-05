/**
 * Search API integration tests.
 *
 * Tests the GET /api/projects/:projectId/search endpoint.
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
import type { SearchResponse, SearchResult } from '@claude-agent/shared'

describe('Search API', () => {
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
  // GET /api/projects/:projectId/search
  // ==========================================================================

  describe('GET /api/projects/:projectId/search', () => {
    test('returns empty results for empty query', async () => {
      const res = await api.get<SearchResponse>(
        `/api/projects/${ctx.project.id}/search?q=`
      )

      expect(res.status).toBe(200)
      expect(res.data.results).toEqual([])
    })

    test('returns matching items', async () => {
      // Create test data
      await api.post(`/api/projects/${ctx.project.id}/folders`, { body: { name: 'TestFolder' } })
      await api.post(`/api/documents`, { body: { name: 'TestDocument', project_id: ctx.project.id } })
      await api.post(`/api/projects/${ctx.project.id}/folders`, { body: { name: 'OtherFolder' } })

      // Search for "test"
      const res = await api.get<SearchResponse>(
        `/api/projects/${ctx.project.id}/search?q=test`
      )

      expect(res.status).toBe(200)
      expect(res.data.results).toHaveLength(2)

      const names = res.data.results.map(r => r.name)
      expect(names).toContain('TestFolder')
      expect(names).toContain('TestDocument')
      expect(names).not.toContain('OtherFolder')
    })

    test('search is case-insensitive', async () => {
      // Create folders with different cases
      await api.post(`/api/projects/${ctx.project.id}/folders`, { body: { name: 'UPPERCASE' } })
      await api.post(`/api/projects/${ctx.project.id}/folders`, { body: { name: 'lowercase' } })
      await api.post(`/api/projects/${ctx.project.id}/folders`, { body: { name: 'MixedCase' } })

      // Search with lowercase for "case" - should match all 3 (UPPERCASE, lowercase, MixedCase all contain "case")
      const res1 = await api.get<SearchResponse>(
        `/api/projects/${ctx.project.id}/search?q=case`
      )
      expect(res1.data.results).toHaveLength(3)
      expect(res1.data.results.map(r => r.name)).toContain('UPPERCASE')
      expect(res1.data.results.map(r => r.name)).toContain('lowercase')
      expect(res1.data.results.map(r => r.name)).toContain('MixedCase')

      // Search with uppercase "LOWER" - should match "lowercase"
      const res2 = await api.get<SearchResponse>(
        `/api/projects/${ctx.project.id}/search?q=LOWER`
      )
      expect(res2.data.results).toHaveLength(1)
      expect(res2.data.results[0]!.name).toBe('lowercase')

      // Search with mixed case "Upper" - should match "UPPERCASE"
      const res3 = await api.get<SearchResponse>(
        `/api/projects/${ctx.project.id}/search?q=Upper`
      )
      expect(res3.data.results).toHaveLength(1)
      expect(res3.data.results[0]!.name).toBe('UPPERCASE')
    })

    test('results include breadcrumb paths', async () => {
      // Create nested structure: Parent > Child > document
      const parentRes = await api.post<{ folder: { id: string } }>(
        `/api/projects/${ctx.project.id}/folders`,
        { body: { name: 'Parent' } }
      )
      const parentId = parentRes.data.folder.id

      const childRes = await api.post<{ folder: { id: string } }>(
        `/api/projects/${ctx.project.id}/folders`,
        { body: { name: 'ChildFolder', parent_id: parentId } }
      )
      const childId = childRes.data.folder.id

      await api.post(
        `/api/documents`,
        { body: { name: 'NestedDoc', project_id: ctx.project.id, folder_id: childId } }
      )

      // Search for the document
      const res = await api.get<SearchResponse>(
        `/api/projects/${ctx.project.id}/search?q=nested`
      )

      expect(res.status).toBe(200)
      expect(res.data.results).toHaveLength(1)

      const docResult = res.data.results[0]!
      expect(docResult.name).toBe('NestedDoc')
      expect(docResult.type).toBe('document')

      // Breadcrumb should show folder path
      expect(docResult.breadcrumb).toHaveLength(2)
      expect(docResult.breadcrumb[0]).toMatchObject({ name: 'Parent', type: 'folder' })
      expect(docResult.breadcrumb[1]).toMatchObject({ name: 'ChildFolder', type: 'folder' })
    })

    test('folder results include breadcrumb for parent folders', async () => {
      // Create nested folder: Root > Nested
      const rootRes = await api.post<{ folder: { id: string } }>(
        `/api/projects/${ctx.project.id}/folders`,
        { body: { name: 'RootFolder' } }
      )

      await api.post(
        `/api/projects/${ctx.project.id}/folders`,
        { body: { name: 'NestedFolder', parent_id: rootRes.data.folder.id } }
      )

      // Search for nested folder
      const res = await api.get<SearchResponse>(
        `/api/projects/${ctx.project.id}/search?q=nested`
      )

      expect(res.status).toBe(200)
      const folderResult = res.data.results.find(r => r.type === 'folder')
      expect(folderResult).toBeDefined()
      expect(folderResult!.breadcrumb).toHaveLength(1)
      expect(folderResult!.breadcrumb[0]).toMatchObject({ name: 'RootFolder', type: 'folder' })
    })

    test('can filter by type=documents', async () => {
      await api.post(`/api/projects/${ctx.project.id}/folders`, { body: { name: 'SearchFolder' } })
      await api.post(`/api/documents`, { body: { name: 'SearchDoc', project_id: ctx.project.id } })

      const res = await api.get<SearchResponse>(
        `/api/projects/${ctx.project.id}/search?q=search&type=documents`
      )

      expect(res.status).toBe(200)
      expect(res.data.results).toHaveLength(1)
      expect(res.data.results[0]!.type).toBe('document')
      expect(res.data.results[0]!.name).toBe('SearchDoc')
    })

    test('can filter by type=folders', async () => {
      await api.post(`/api/projects/${ctx.project.id}/folders`, { body: { name: 'SearchFolder' } })
      await api.post(`/api/documents`, { body: { name: 'SearchDoc', project_id: ctx.project.id } })

      const res = await api.get<SearchResponse>(
        `/api/projects/${ctx.project.id}/search?q=search&type=folders`
      )

      expect(res.status).toBe(200)
      expect(res.data.results).toHaveLength(1)
      expect(res.data.results[0]!.type).toBe('folder')
      expect(res.data.results[0]!.name).toBe('SearchFolder')
    })

    test('type=all returns both folders and documents', async () => {
      await api.post(`/api/projects/${ctx.project.id}/folders`, { body: { name: 'AllFolder' } })
      await api.post(`/api/documents`, { body: { name: 'AllDoc', project_id: ctx.project.id } })

      const res = await api.get<SearchResponse>(
        `/api/projects/${ctx.project.id}/search?q=all&type=all`
      )

      expect(res.status).toBe(200)
      expect(res.data.results).toHaveLength(2)

      const types = res.data.results.map(r => r.type)
      expect(types).toContain('folder')
      expect(types).toContain('document')
    })

    test('results are sorted alphabetically', async () => {
      await api.post(`/api/documents`, { body: { name: 'Zebra', project_id: ctx.project.id } })
      await api.post(`/api/documents`, { body: { name: 'Apple', project_id: ctx.project.id } })
      await api.post(`/api/documents`, { body: { name: 'Mango', project_id: ctx.project.id } })

      const res = await api.get<SearchResponse>(
        `/api/projects/${ctx.project.id}/search?q=a`  // matches Apple, Mango, Zebra
      )

      const names = res.data.results.map(r => r.name)
      expect(names).toEqual([...names].sort())
    })

    test('limits results to 20', async () => {
      // Create 25 folders
      for (let i = 0; i < 25; i++) {
        await api.post(`/api/projects/${ctx.project.id}/folders`, { body: { name: `Folder${i.toString().padStart(2, '0')}` } })
      }

      const res = await api.get<SearchResponse>(
        `/api/projects/${ctx.project.id}/search?q=folder`
      )

      expect(res.status).toBe(200)
      expect(res.data.results).toHaveLength(20)
    })

    test('does not include deleted items', async () => {
      // Create and delete a folder
      const folderRes = await api.post<{ folder: { id: string } }>(
        `/api/projects/${ctx.project.id}/folders`,
        { body: { name: 'DeletedFolder' } }
      )
      await api.del(`/api/projects/${ctx.project.id}/folders/${folderRes.data.folder.id}`)

      // Create a folder that stays
      await api.post(`/api/projects/${ctx.project.id}/folders`, { body: { name: 'ActiveFolder' } })

      const res = await api.get<SearchResponse>(
        `/api/projects/${ctx.project.id}/search?q=folder`
      )

      expect(res.data.results).toHaveLength(1)
      expect(res.data.results[0]!.name).toBe('ActiveFolder')
    })

    test('escapes special SQL characters in query', async () => {
      // Create folder with special characters
      await api.post(`/api/projects/${ctx.project.id}/folders`, { body: { name: 'Normal' } })
      await api.post(`/api/projects/${ctx.project.id}/folders`, { body: { name: '50% Off' } })

      // Search with % which is a SQL wildcard
      const res = await api.get<SearchResponse>(
        `/api/projects/${ctx.project.id}/search?q=%`
      )

      // Should only match the literal % not everything
      expect(res.data.results).toHaveLength(1)
      expect(res.data.results[0]!.name).toBe('50% Off')
    })

    test('returns 404 for non-existent project', async () => {
      const res = await api.get(
        `/api/projects/00000000-0000-0000-0000-000000000000/search?q=test`
      )

      expect(res.status).toBe(404)
    })

    test('root level items have empty breadcrumb', async () => {
      await api.post(`/api/documents`, { body: { name: 'RootDoc', project_id: ctx.project.id } })

      const res = await api.get<SearchResponse>(
        `/api/projects/${ctx.project.id}/search?q=root`
      )

      expect(res.data.results).toHaveLength(1)
      expect(res.data.results[0]!.breadcrumb).toEqual([])
    })
  })
})
