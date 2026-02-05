import { describe, expect, test, mock, beforeEach } from 'bun:test'

describe('AI Phase 3: Document Tools Enhancement', () => {
  beforeEach(() => {
    mock.restore()
  })

  test('doc_read truncates large content', async () => {
    mock.module('../../document-manager', () => ({
      readDocAsText: async () => ({
        name: 'Large Doc',
        content: 'x'.repeat(60_000),
      }),
      // Unused in this test but required for module shape in some bundlers.
      listDocsPage: async () => ({ documents: [], total: 0 }),
      searchDocs: async () => [],
    }))

    const { createDocumentTools } = await import('../../tools/document-tools')
    const tools = createDocumentTools('p1', 'u1')

    const result = (await tools.doc_read.execute!(
      { id: 'doc1' },
      { toolCallId: 't1', messages: [], abortSignal: undefined as unknown as AbortSignal },
    )) as any

    expect(result).toMatchObject({
      id: 'doc1',
      name: 'Large Doc',
      truncated: true,
      note: expect.any(String),
    })
    expect(result.content.length).toBeLessThan(60_000)
  })

  test('doc_list enforces max limit and passes pagination options through', async () => {
    const seen: Array<{ folderId?: string | null; limit?: number; offset?: number }> = []

    mock.module('../../document-manager', () => ({
      listDocsPage: async (_userId: string, _projectId: string, options: any) => {
        seen.push(options)
        return {
          documents: Array.from({ length: options.limit ?? 0 }).map((_, i) => ({
            id: `d${i}`,
            project_id: 'p1',
            workspace_id: 'w1',
            folder_id: options.folderId ?? null,
            name: `Doc ${i}`,
            created_by: 'u1',
            created_at: new Date().toISOString(),
            updated_at: new Date().toISOString(),
          })),
          total: 30,
        }
      },
      readDocAsText: async () => null,
      searchDocs: async () => [],
    }))

    const { createDocumentTools } = await import('../../tools/document-tools')
    const tools = createDocumentTools('p1', 'u1')

    const result = (await tools.doc_list.execute!(
      { limit: 200, offset: 10 },
      { toolCallId: 't2', messages: [], abortSignal: undefined as unknown as AbortSignal },
    )) as any

    expect(seen).toHaveLength(1)
    expect(seen[0]).toMatchObject({ limit: 100, offset: 10 }) // max 100

    expect(result.total).toBe(30)
    expect(result.limit).toBe(100)
    expect(result.offset).toBe(10)
    expect(result.documents).toHaveLength(100)
  })

  test('doc_search returns matching documents', async () => {
    mock.module('../../document-manager', () => ({
      searchDocs: async () => [
        {
          id: 'd1',
          project_id: 'p1',
          workspace_id: 'w1',
          folder_id: null,
          name: 'Design Spec',
          created_by: 'u1',
          created_at: new Date().toISOString(),
          updated_at: new Date().toISOString(),
        },
      ],
      listDocsPage: async () => ({ documents: [], total: 0 }),
      readDocAsText: async () => null,
    }))

    const { createDocumentTools } = await import('../../tools/document-tools')
    const tools = createDocumentTools('p1', 'u1')

    const result = (await tools.doc_search.execute!(
      { query: 'design' },
      { toolCallId: 't3', messages: [], abortSignal: undefined as unknown as AbortSignal },
    )) as any

    expect(result).toMatchObject({
      documents: [{ id: 'd1', name: 'Design Spec', folder_id: null }],
    })
  })
})
