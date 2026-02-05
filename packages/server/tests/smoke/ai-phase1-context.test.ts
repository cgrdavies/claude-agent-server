import { describe, expect, test, mock, beforeEach } from 'bun:test'

// These smoke tests are unit-level (DB mocked) so they can run in any environment.
// The full integration coverage for Projects + Documents exists in other suites.

describe('AI Phase 1: Project Context Builder', () => {
  beforeEach(() => {
    mock.restore()
  })

  test('small project includes document list', async () => {
    const projectId = 'p-small'
    const userId = 'u1'

    // Mock DB + breadcrumb lookups
    let call = 0
    mock.module('../../lib/db', () => ({
      withRLS: async () => {
        call++
        if (call === 1) return [{ id: projectId, name: 'Small Project' }]
        if (call === 2) return [{ count: 5 }]
        if (call === 3)
          return Array.from({ length: 5 }).map((_, i) => ({
            id: `d${i}`,
            name: `Doc ${i}`,
            folder_id: null,
            updated_at: new Date().toISOString(),
          }))
        throw new Error(`unexpected withRLS call #${call}`)
      },
    }))

    mock.module('../../folder-manager', () => ({
      getBreadcrumb: async () => [],
    }))

    const { buildProjectContext, formatProjectContextPrompt } = await import(
      '../../lib/project-context'
    )

    const context = await buildProjectContext(userId, projectId)
    expect(context).not.toBeNull()
    expect(context!.isLargeProject).toBe(false)
    expect(context!.documentCount).toBe(5)
    expect(context!.documents).toHaveLength(5)

    const prompt = formatProjectContextPrompt(context!)
    expect(prompt).toContain('## Project Context')
    expect(prompt).toContain('Doc 0')
    expect(prompt).toContain('doc_read')
  })

  test('large project does not include document list and mentions tools', async () => {
    const projectId = 'p-large'
    const userId = 'u1'

    let call = 0
    mock.module('../../lib/db', () => ({
      withRLS: async () => {
        call++
        if (call === 1) return [{ id: projectId, name: 'Large Project' }]
        if (call === 2) return [{ count: 25 }]
        throw new Error(`unexpected withRLS call #${call}`)
      },
    }))

    mock.module('../../folder-manager', () => ({
      getBreadcrumb: async () => [],
    }))

    const { buildProjectContext, formatProjectContextPrompt } = await import(
      '../../lib/project-context'
    )

    const context = await buildProjectContext(userId, projectId)
    expect(context).not.toBeNull()
    expect(context!.isLargeProject).toBe(true)
    expect(context!.documentCount).toBe(25)
    expect(context!.documents).toHaveLength(0)

    const prompt = formatProjectContextPrompt(context!)
    expect(prompt).toContain('doc_list')
    expect(prompt).toContain('doc_search')
    expect(prompt).not.toContain('Doc 0')
  })
})

