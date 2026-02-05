# AI Session Integration Implementation Plan

## Overview

Integrate AI sessions with the Projects feature. Sessions become project-scoped with project_id FK. When users switch projects, the AI context changes. The AI gains awareness of project documents through either system prompt injection (small projects) or tool-based access (large projects).

This plan builds on top of the [Document Folder Hierarchy Plan](/Users/cgrdavies/Projects/claude-agent-server/thoughts/shared/plans/2026-02-04-document-folder-hierarchy.md), which establishes project-scoped documents and sessions. This plan focuses on:
1. Session behavior on project switching
2. AI awareness of project context
3. Document tool refinements for large projects

## Current State Analysis

**Existing infrastructure:**
- Sessions router at `packages/server/routes/sessions.ts` is workspace-scoped
- Messages router at `packages/server/routes/messages.ts` handles streaming AI responses
- Document tools at `packages/server/tools/document-tools.ts` are workspace-scoped
- System prompt stored on `agent_sessions.system_prompt` (nullable)
- No project scoping on sessions currently

**From the Document Folder Hierarchy Plan (prerequisite):**
- Phase 1-5: Database migration adds `project_id` to `agent_sessions`
- Phase 6: Sessions become project-scoped with routes at `/api/projects/:projectId/sessions`
- Phase 7: Document tools become project-aware

### Key Discoveries:
- Session creation needs project context injection (`packages/server/routes/sessions.ts:28`)
- Message handling loads system prompt from session (`packages/server/routes/messages.ts:76`)
- Document tools accept workspaceId but will change to projectId (`packages/server/tools/document-tools.ts:38`)

## Desired End State

After implementation:

1. **Sessions scoped to projects** - `project_id NOT NULL` on agent_sessions
2. **Project context in system prompt** - Small projects get doc list, large projects get tool instructions
3. **Session isolation on project switch** - Different projects have separate session lists
4. **State preservation** - Returning to a project shows previous sessions
5. **Enhanced document tools** - Pagination for large projects, search capability

### Verification:
- Create project, create session within it, verify session has project context
- Create 5 docs, start session -> doc list in system prompt
- Create 25 docs, start session -> no doc list, tools available
- Switch projects -> different session list
- Return to original project -> previous sessions still there

## What We're NOT Doing

- **Frontend implementation** - API only (frontend handled separately)
- **Cross-project session migration** - Sessions stay in their project
- **Session merging/splitting** - Each session is independent
- **Smart context loading** - No automatic detection of "relevant" docs (user can mention by name)
- **Document embedding/RAG** - Future enhancement, out of scope

## Implementation Approach

This plan assumes the Document Folder Hierarchy Plan phases 1-6 are complete (sessions have project_id, routes are nested). We focus on:

1. System prompt generation with project context
2. Document tools refinement (pagination, search, size limits)
3. Session creation with automatic context injection

---

## Phase 1: Project Context Builder

### Overview
Create a utility that builds the project context portion of the system prompt. For small projects (<=20 docs), include document list. For large projects, include tool usage instructions.

### Changes Required:

#### 1. Create project context module
**File**: `packages/server/lib/project-context.ts`

```typescript
import { withRLS } from './db'

/**
 * Document summary for system prompt inclusion (small projects).
 */
export type DocSummary = {
  id: string
  name: string
  path: string
  updated_at: string
}

/**
 * Project context for AI system prompt.
 */
export type ProjectContext = {
  projectId: string
  projectName: string
  documentCount: number
  /** For small projects: list of docs. Empty for large projects. */
  documents: DocSummary[]
  /** True if project has more docs than can fit in prompt */
  isLargeProject: boolean
}

const SMALL_PROJECT_DOC_LIMIT = 20

/**
 * Build project context for AI system prompt injection.
 *
 * Small projects (<=20 docs): Returns full doc list ordered by recent access.
 * Large projects: Returns count only, AI uses tools to query.
 */
export async function buildProjectContext(
  userId: string,
  projectId: string,
): Promise<ProjectContext | null> {
  // Get project info
  const projectRows = await withRLS(userId, (sql) =>
    sql`SELECT id, name FROM projects WHERE id = ${projectId} LIMIT 1`
  )
  const project = projectRows[0] as { id: string; name: string } | undefined
  if (!project) return null

  // Count documents
  const countRows = await withRLS(userId, (sql) =>
    sql`SELECT COUNT(*)::int as count FROM documents WHERE project_id = ${projectId}`
  )
  const documentCount = (countRows[0] as { count: number })?.count ?? 0

  // For small projects, fetch document list
  const isLargeProject = documentCount > SMALL_PROJECT_DOC_LIMIT
  let documents: DocSummary[] = []

  if (!isLargeProject && documentCount > 0) {
    const docRows = await withRLS(userId, (sql) =>
      sql`SELECT id, name, path, updated_at
          FROM documents
          WHERE project_id = ${projectId}
          ORDER BY updated_at DESC
          LIMIT ${SMALL_PROJECT_DOC_LIMIT}`
    )
    documents = docRows as unknown as DocSummary[]
  }

  return {
    projectId: project.id,
    projectName: project.name,
    documentCount,
    documents,
    isLargeProject,
  }
}

/**
 * Format project context as markdown for system prompt injection.
 */
export function formatProjectContextPrompt(context: ProjectContext): string {
  const lines: string[] = [
    `## Project Context`,
    ``,
    `You are working in project "${context.projectName}".`,
    ``,
  ]

  if (context.isLargeProject) {
    lines.push(
      `This project contains ${context.documentCount} documents. Use the document tools to:`,
      `- \`doc_list\` - List documents (supports pagination with \`path\` and \`limit\`/\`offset\`)`,
      `- \`doc_search\` - Search documents by name or content`,
      `- \`doc_read\` - Read a specific document by ID`,
      ``,
      `When the user mentions a document by name, use doc_search to find it first.`,
    )
  } else if (context.documents.length > 0) {
    lines.push(`### Documents in this project:`)
    lines.push(``)
    for (const doc of context.documents) {
      const pathDisplay = doc.path === '/' ? '' : ` (${doc.path})`
      lines.push(`- **${doc.name}**${pathDisplay} - ID: \`${doc.id}\``)
    }
    lines.push(``)
    lines.push(`You can read any document using \`doc_read\` with its ID.`)
  } else {
    lines.push(`This project has no documents yet. Use \`doc_create\` to create one.`)
  }

  return lines.join('\n')
}
```

### Success Criteria:

#### Automated Verification:
- [ ] TypeScript compilation passes: `bun run tsc --noEmit`

#### Smoke Test
Create `packages/server/tests/smoke/ai-phase1-context.test.ts`:
```typescript
import { describe, test, expect, beforeAll } from 'bun:test'
import { buildProjectContext, formatProjectContextPrompt } from '../../lib/project-context'
import { createTestClient } from '../test-utils'

describe('AI Phase 1: Project Context Builder', () => {
  let client: ReturnType<typeof createTestClient>
  let smallProjectId: string
  let largeProjectId: string
  let userId: string

  beforeAll(async () => {
    client = await createTestClient()
    userId = client.userId

    // Create small project with 5 docs
    const small = await client.post('/api/projects', { name: 'Small Project' })
    smallProjectId = (await small.json()).project.id
    for (let i = 0; i < 5; i++) {
      await client.post(`/api/projects/${smallProjectId}/documents`, { name: `Doc ${i}` })
    }

    // Create large project with 25 docs
    const large = await client.post('/api/projects', { name: 'Large Project' })
    largeProjectId = (await large.json()).project.id
    for (let i = 0; i < 25; i++) {
      await client.post(`/api/projects/${largeProjectId}/documents`, { name: `Doc ${i}` })
    }
  })

  test('small project includes document list', async () => {
    const context = await buildProjectContext(userId, smallProjectId)
    expect(context).not.toBeNull()
    expect(context!.isLargeProject).toBe(false)
    expect(context!.documents.length).toBe(5)
    expect(context!.documentCount).toBe(5)
  })

  test('large project does not include document list', async () => {
    const context = await buildProjectContext(userId, largeProjectId)
    expect(context).not.toBeNull()
    expect(context!.isLargeProject).toBe(true)
    expect(context!.documents.length).toBe(0)
    expect(context!.documentCount).toBe(25)
  })

  test('formatProjectContextPrompt includes docs for small project', async () => {
    const context = await buildProjectContext(userId, smallProjectId)
    const prompt = formatProjectContextPrompt(context!)
    expect(prompt).toContain('Doc 0')
    expect(prompt).toContain('doc_read')
  })

  test('formatProjectContextPrompt mentions tools for large project', async () => {
    const context = await buildProjectContext(userId, largeProjectId)
    const prompt = formatProjectContextPrompt(context!)
    expect(prompt).toContain('doc_list')
    expect(prompt).toContain('doc_search')
    expect(prompt).not.toContain('Doc 0')
  })
})
```

Run: `bun test packages/server/tests/smoke/ai-phase1-context.test.ts`

---

## Phase 2: Session Creation with Project Context

### Overview
Update session creation to automatically inject project context into the system prompt. The session stores a combined system prompt (user-provided + project context).

### Changes Required:

#### 1. Update CreateSessionRequest
**File**: `packages/shared/api.ts`

```typescript
export type CreateSessionRequest = {
  title?: string
  model?: string
  provider?: Provider
  system_prompt?: string           // User's custom instructions (optional)
  // Note: project_id comes from URL param, not body
}
```
(No change needed - system_prompt remains the user's custom prompt only)

#### 2. Update session creation route
**File**: `packages/server/routes/sessions.ts`

Add project context injection:

```typescript
import { buildProjectContext, formatProjectContextPrompt } from '../lib/project-context'

// POST /api/projects/:projectId/sessions
sessionsRouter.post('/', async (c) => {
  const userId = c.get('userId')
  const projectId = c.req.param('projectId')
  const body = await c.req.json<CreateSessionRequest>()

  // Get workspace_id from project
  const projectRows = await withRLS(userId, (sql) =>
    sql`SELECT workspace_id FROM projects WHERE id = ${projectId} LIMIT 1`
  )
  const workspaceId = (projectRows[0] as { workspace_id: string })?.workspace_id
  if (!workspaceId) return c.json({ error: 'Project not found' }, 404)

  // Build project context
  const projectContext = await buildProjectContext(userId, projectId)
  if (!projectContext) return c.json({ error: 'Project not found' }, 404)

  // Combine user's custom prompt with project context
  const projectPrompt = formatProjectContextPrompt(projectContext)
  const combinedPrompt = body.system_prompt
    ? `${body.system_prompt}\n\n${projectPrompt}`
    : projectPrompt

  const title = body.title ?? 'New Session'
  const model = body.model ?? DEFAULT_MODEL
  const provider = body.provider ?? DEFAULT_PROVIDER

  const rows = await withRLS(userId, (sql) =>
    sql`INSERT INTO agent_sessions (project_id, workspace_id, title, model, provider, system_prompt, created_by)
        VALUES (${projectId}, ${workspaceId}, ${title}, ${model}, ${provider}, ${combinedPrompt}, ${userId})
        RETURNING *`
  )
  const session = rows[0]

  return c.json({ session } satisfies CreateSessionResponse, 201)
})
```

### Success Criteria:

#### Automated Verification:
- [ ] TypeScript compilation passes: `bun run tsc --noEmit`

#### Smoke Test
Create `packages/server/tests/smoke/ai-phase2-session.test.ts`:
```typescript
import { describe, test, expect, beforeAll } from 'bun:test'
import { createTestClient } from '../test-utils'

describe('AI Phase 2: Session Creation with Project Context', () => {
  let client: ReturnType<typeof createTestClient>
  let smallProjectId: string
  let largeProjectId: string

  beforeAll(async () => {
    client = await createTestClient()

    // Create small project with 5 docs
    const small = await client.post('/api/projects', { name: 'Session Small' })
    smallProjectId = (await small.json()).project.id
    for (let i = 0; i < 5; i++) {
      await client.post(`/api/projects/${smallProjectId}/documents`, { name: `Doc ${i}` })
    }

    // Create large project with 25 docs
    const large = await client.post('/api/projects', { name: 'Session Large' })
    largeProjectId = (await large.json()).project.id
    for (let i = 0; i < 25; i++) {
      await client.post(`/api/projects/${largeProjectId}/documents`, { name: `Doc ${i}` })
    }
  })

  test('small project session includes doc list in system_prompt', async () => {
    const res = await client.post(`/api/projects/${smallProjectId}/sessions`, {
      title: 'Test Session'
    })
    expect(res.status).toBe(201)
    const body = await res.json()
    expect(body.session.system_prompt).toContain('Doc 0')
    expect(body.session.system_prompt).toContain('Project Context')
  })

  test('large project session includes tool instructions', async () => {
    const res = await client.post(`/api/projects/${largeProjectId}/sessions`, {
      title: 'Test Session'
    })
    expect(res.status).toBe(201)
    const body = await res.json()
    expect(body.session.system_prompt).toContain('doc_list')
    expect(body.session.system_prompt).toContain('doc_search')
    expect(body.session.system_prompt).not.toContain('Doc 0')
  })

  test('custom prompt is preserved alongside project context', async () => {
    const customPrompt = 'You are a code reviewer.'
    const res = await client.post(`/api/projects/${smallProjectId}/sessions`, {
      title: 'Custom Session',
      system_prompt: customPrompt
    })
    const body = await res.json()
    expect(body.session.system_prompt).toContain(customPrompt)
    expect(body.session.system_prompt).toContain('Project Context')
  })
})
```

Run: `bun test packages/server/tests/smoke/ai-phase2-session.test.ts`

---

## Phase 3: Document Tools Enhancement

### Overview
Enhance document tools for better large-project support: pagination for doc_list, doc_search for finding documents by name, and content size limits.

### Changes Required:

#### 1. Add pagination to listDocs
**File**: `packages/server/document-manager.ts`

Update `listDocs` signature and add search:

```typescript
export type ListDocsOptions = {
  path?: string
  limit?: number
  offset?: number
}

export async function listDocs(
  userId: string,
  projectId: string,
  options: ListDocsOptions = {},
): Promise<{ documents: DocumentInfo[]; folders: FolderEntry[]; total: number }> {
  const { path, limit = 50, offset = 0 } = options

  // Get total count
  const countRows = await withRLS(userId, (sql) =>
    path
      ? sql`SELECT COUNT(*)::int as count FROM documents WHERE project_id = ${projectId} AND path = ${path}`
      : sql`SELECT COUNT(*)::int as count FROM documents WHERE project_id = ${projectId}`
  )
  const total = (countRows[0] as { count: number })?.count ?? 0

  if (!path) {
    // Flat list of all documents in project (paginated)
    const rows = await withRLS(userId, (sql) =>
      sql`SELECT id, project_id, workspace_id, name, path, created_by, created_at, updated_at
          FROM documents
          WHERE project_id = ${projectId}
          ORDER BY updated_at DESC
          LIMIT ${limit} OFFSET ${offset}`
    )
    return { documents: rows as unknown as DocumentInfo[], folders: [], total }
  }

  const normalizedPath = normalizePath(path)

  // Documents at this exact path level (paginated)
  const docRows = await withRLS(userId, (sql) =>
    sql`SELECT id, project_id, workspace_id, name, path, created_by, created_at, updated_at
        FROM documents
        WHERE project_id = ${projectId} AND path = ${normalizedPath}
        ORDER BY name ASC
        LIMIT ${limit} OFFSET ${offset}`
  )

  // Find immediate subfolders (always return all folders, no pagination)
  const folderRows = await withRLS(userId, (sql) =>
    sql`SELECT DISTINCT
        split_part(substring(path FROM ${normalizedPath.length + 1}), '/', 1) AS folder_name
      FROM documents
      WHERE project_id = ${projectId}
        AND path LIKE ${normalizedPath + '%'}
        AND path != ${normalizedPath}`
  )

  const folders: FolderEntry[] = (folderRows as unknown as { folder_name: string }[])
    .filter(r => r.folder_name)
    .map(r => ({
      name: r.folder_name,
      path: normalizedPath + r.folder_name + '/',
    }))

  return {
    documents: docRows as unknown as DocumentInfo[],
    folders,
    total,
  }
}

/**
 * Search documents by name within a project.
 */
export async function searchDocs(
  userId: string,
  projectId: string,
  query: string,
  limit: number = 20,
): Promise<DocumentInfo[]> {
  // Use ILIKE for case-insensitive search
  const pattern = `%${query.replace(/[%_]/g, '\\$&')}%`

  const rows = await withRLS(userId, (sql) =>
    sql`SELECT id, project_id, workspace_id, name, path, created_by, created_at, updated_at
        FROM documents
        WHERE project_id = ${projectId}
          AND name ILIKE ${pattern}
        ORDER BY
          CASE WHEN name ILIKE ${query} THEN 0 ELSE 1 END,
          updated_at DESC
        LIMIT ${limit}`
  )
  return rows as unknown as DocumentInfo[]
}
```

#### 2. Update document tools
**File**: `packages/server/tools/document-tools.ts`

Add pagination, search, and content size limits:

```typescript
const MAX_CONTENT_LENGTH = 50_000 // ~50KB, roughly 12k tokens

export function createDocumentTools(projectId: string, userId: string) {
  return {
    doc_create: tool({
      description: 'Create a new markdown document. Optionally specify a folder path.',
      inputSchema: z.object({
        name: z.string().describe('Document name/title'),
        content: z.string().optional().describe('Initial markdown content'),
        path: z.string().optional().describe('Folder path, e.g., "/Design/". Defaults to root "/"'),
      }),
      execute: async ({ name, content, path }) => {
        const info = await docManager.createDoc(userId, projectId, name, content, path)
        return { id: info.id, name: info.name, path: info.path }
      },
    }),

    doc_read: tool({
      description: 'Read a document as markdown. For large documents, content may be truncated.',
      inputSchema: z.object({
        id: z.string().describe('Document ID'),
      }),
      execute: async ({ id }) => {
        const result = await docManager.readDocAsText(userId, projectId, id)
        if (!result) return { error: 'Document not found' }

        // Guard against large documents crowding context
        let content = result.content
        let truncated = false
        if (content.length > MAX_CONTENT_LENGTH) {
          content = content.slice(0, MAX_CONTENT_LENGTH)
          truncated = true
        }

        return {
          id,
          name: result.name,
          content,
          truncated,
          ...(truncated && { note: `Content truncated at ${MAX_CONTENT_LENGTH} characters. Document is ${result.content.length} characters total.` }),
        }
      },
    }),

    doc_list: tool({
      description: 'List documents in the project. Supports pagination for large projects.',
      inputSchema: z.object({
        path: z.string().optional().describe('Folder path to list, e.g., "/Design/". Omit for all documents.'),
        limit: z.number().optional().describe('Max documents to return (default 50, max 100)'),
        offset: z.number().optional().describe('Skip this many documents (for pagination)'),
      }),
      execute: async ({ path, limit, offset }) => {
        const safeLimit = Math.min(limit ?? 50, 100)
        const result = await docManager.listDocs(userId, projectId, {
          path,
          limit: safeLimit,
          offset: offset ?? 0,
        })
        return {
          documents: result.documents.map(d => ({
            id: d.id,
            name: d.name,
            path: d.path,
            updated_at: d.updated_at,
          })),
          folders: result.folders,
          total: result.total,
          hasMore: (offset ?? 0) + result.documents.length < result.total,
        }
      },
    }),

    doc_search: tool({
      description: 'Search for documents by name. Useful when the user mentions a document but you need its ID.',
      inputSchema: z.object({
        query: z.string().describe('Search query (matches document names)'),
        limit: z.number().optional().describe('Max results (default 20)'),
      }),
      execute: async ({ query, limit }) => {
        const docs = await docManager.searchDocs(userId, projectId, query, limit ?? 20)
        return {
          documents: docs.map(d => ({
            id: d.id,
            name: d.name,
            path: d.path,
          })),
        }
      },
    }),

    doc_edit: tool({
      description: 'Find and replace text in a document. The old_text must match exactly.',
      inputSchema: z.object({
        id: z.string().describe('Document ID'),
        old_text: z.string().describe('Text to find (must match exactly)'),
        new_text: z.string().describe('Text to replace it with'),
      }),
      execute: async ({ id, old_text, new_text }) => {
        try {
          const newText = unquote(new_text)
          const candidates = oldTextCandidates(old_text)
          let success = false

          for (const candidate of candidates) {
            success = await docManager.editDoc(userId, projectId, id, candidate, newText)
            if (success) break
          }

          if (!success) return { success: false, error: 'old_text not found in document' }
          return { success: true }
        } catch (err) {
          return { success: false, error: String(err) }
        }
      },
    }),

    doc_append: tool({
      description: 'Append markdown content to the end of a document.',
      inputSchema: z.object({
        id: z.string().describe('Document ID'),
        content: z.string().describe('Markdown content to append'),
      }),
      execute: async ({ id, content }) => {
        try {
          await docManager.appendDoc(userId, projectId, id, content)
          return { success: true }
        } catch (err) {
          return { success: false, error: String(err) }
        }
      },
    }),

    doc_move: tool({
      description: 'Move a document to a different folder.',
      inputSchema: z.object({
        id: z.string().describe('Document ID'),
        path: z.string().describe('New folder path, e.g., "/Archive/" or "/"'),
      }),
      execute: async ({ id, path }) => {
        try {
          await docManager.moveDoc(userId, projectId, id, path)
          return { success: true }
        } catch (err) {
          return { success: false, error: String(err) }
        }
      },
    }),

    doc_delete: tool({
      description: 'Delete a document permanently. This cannot be undone.',
      inputSchema: z.object({
        id: z.string().describe('Document ID'),
      }),
      execute: async ({ id }) => {
        await docManager.deleteDoc(userId, projectId, id)
        return { success: true }
      },
    }),
  }
}
```

### Success Criteria:

#### Automated Verification:
- [ ] TypeScript compilation passes: `bun run tsc --noEmit`

#### Smoke Test
Create `packages/server/tests/smoke/ai-phase3-tools.test.ts`:
```typescript
import { describe, test, expect, beforeAll } from 'bun:test'
import { createTestClient } from '../test-utils'
import * as docManager from '../../document-manager'

describe('AI Phase 3: Document Tools Enhancement', () => {
  let client: ReturnType<typeof createTestClient>
  let projectId: string
  let userId: string

  beforeAll(async () => {
    client = await createTestClient()
    userId = client.userId

    const p = await client.post('/api/projects', { name: 'Tools Test' })
    projectId = (await p.json()).project.id

    // Create 30 docs for pagination testing
    for (let i = 0; i < 30; i++) {
      await docManager.createDoc(userId, projectId, `Document ${i.toString().padStart(2, '0')}`)
    }
  })

  test('listDocs with limit/offset paginates correctly', async () => {
    const page1 = await docManager.listDocs(userId, projectId, { limit: 10, offset: 0 })
    expect(page1.documents.length).toBe(10)
    expect(page1.total).toBe(30)

    const page2 = await docManager.listDocs(userId, projectId, { limit: 10, offset: 10 })
    expect(page2.documents.length).toBe(10)

    // Pages should have different documents
    const ids1 = page1.documents.map(d => d.id)
    const ids2 = page2.documents.map(d => d.id)
    expect(ids1.some(id => ids2.includes(id))).toBe(false)
  })

  test('searchDocs finds documents by partial name', async () => {
    const results = await docManager.searchDocs(userId, projectId, 'Document 0')
    expect(results.length).toBeGreaterThan(0)
    expect(results.every(d => d.name.includes('Document 0'))).toBe(true)
  })

  test('searchDocs is case-insensitive', async () => {
    const results = await docManager.searchDocs(userId, projectId, 'DOCUMENT')
    expect(results.length).toBeGreaterThan(0)
  })

  test('readDocAsText truncates large content', async () => {
    // Create a doc with large content
    const largeContent = 'x'.repeat(60000)
    const info = await docManager.createDoc(userId, projectId, 'Large Doc', largeContent)

    const result = await docManager.readDocAsText(userId, projectId, info.id)
    expect(result).not.toBeNull()
    expect(result!.content.length).toBeLessThan(60000)
  })
})
```

Run: `bun test packages/server/tests/smoke/ai-phase3-tools.test.ts`

---

## Phase 4: Session List Ordering

### Overview
Ensure sessions are ordered by most recently accessed (last_message_at) when listing, matching the user story requirement.

### Changes Required:

#### 1. Update session list query
**File**: `packages/server/routes/sessions.ts`

Change ordering from `created_at` to `last_message_at NULLS LAST, created_at`:

```typescript
// GET /api/projects/:projectId/sessions
sessionsRouter.get('/', async (c) => {
  const userId = c.get('userId')
  const projectId = c.req.param('projectId')
  const cursor = c.req.query('cursor')
  const limit = Math.min(Number(c.req.query('limit') ?? 50), 100)

  // Order by most recently used (last_message_at), with new sessions at top
  const sessions = await withRLS(userId, (sql) =>
    cursor
      ? sql`SELECT * FROM agent_sessions
            WHERE project_id = ${projectId}
              AND archived = false
              AND COALESCE(last_message_at, created_at) < ${cursor}
            ORDER BY COALESCE(last_message_at, created_at) DESC
            LIMIT ${limit + 1}`
      : sql`SELECT * FROM agent_sessions
            WHERE project_id = ${projectId}
              AND archived = false
            ORDER BY COALESCE(last_message_at, created_at) DESC
            LIMIT ${limit + 1}`
  )

  const hasMore = sessions.length > limit
  const page = hasMore ? sessions.slice(0, limit) : sessions
  const nextCursor = hasMore
    ? (page[page.length - 1] as Record<string, unknown>)?.last_message_at ??
      (page[page.length - 1] as Record<string, unknown>)?.created_at
    : null

  return c.json({
    data: page,
    cursor: nextCursor,
  } satisfies ListSessionsResponse)
})
```

### Success Criteria:

#### Automated Verification:
- [ ] TypeScript compilation passes: `bun run tsc --noEmit`

#### Smoke Test
Create `packages/server/tests/smoke/ai-phase4-ordering.test.ts`:
```typescript
import { describe, test, expect, beforeAll } from 'bun:test'
import { createTestClient } from '../test-utils'

describe('AI Phase 4: Session List Ordering', () => {
  let client: ReturnType<typeof createTestClient>
  let projectId: string
  let session1Id: string
  let session2Id: string
  let session3Id: string

  beforeAll(async () => {
    client = await createTestClient()
    const p = await client.post('/api/projects', { name: 'Ordering Test' })
    projectId = (await p.json()).project.id

    // Create sessions in order
    const s1 = await client.post(`/api/projects/${projectId}/sessions`, { title: 'Session 1' })
    session1Id = (await s1.json()).session.id

    const s2 = await client.post(`/api/projects/${projectId}/sessions`, { title: 'Session 2' })
    session2Id = (await s2.json()).session.id

    const s3 = await client.post(`/api/projects/${projectId}/sessions`, { title: 'Session 3' })
    session3Id = (await s3.json()).session.id

    // Add message to session1 to make it most recent
    await client.post(`/api/projects/${projectId}/sessions/${session1Id}/messages`, {
      content: 'Hello'
    })
  })

  test('sessions ordered by last_message_at', async () => {
    const res = await client.get(`/api/projects/${projectId}/sessions`)
    const body = await res.json()

    // Session 1 should be first (has recent message)
    expect(body.data[0].id).toBe(session1Id)
  })

  test('new sessions without messages appear correctly', async () => {
    const res = await client.get(`/api/projects/${projectId}/sessions`)
    const body = await res.json()

    // Session 3 was created last (but no messages), should be after session 1
    const s3Index = body.data.findIndex((s: any) => s.id === session3Id)
    const s1Index = body.data.findIndex((s: any) => s.id === session1Id)
    expect(s1Index).toBeLessThan(s3Index) // session1 has message so comes first
  })

  test('pagination cursor works with ordering', async () => {
    const res = await client.get(`/api/projects/${projectId}/sessions?limit=2`)
    const body = await res.json()
    expect(body.data.length).toBe(2)

    if (body.cursor) {
      const res2 = await client.get(`/api/projects/${projectId}/sessions?limit=2&cursor=${body.cursor}`)
      const body2 = await res2.json()
      expect(body2.data.length).toBeGreaterThan(0)

      // Should not overlap
      const ids1 = body.data.map((s: any) => s.id)
      const ids2 = body2.data.map((s: any) => s.id)
      expect(ids1.some((id: string) => ids2.includes(id))).toBe(false)
    }
  })
})
```

Run: `bun test packages/server/tests/smoke/ai-phase4-ordering.test.ts`

---

## Phase 5: Integration Testing

### Overview
Add integration tests verifying the complete AI session integration flow.

### Changes Required:

#### 1. Add session context tests
**File**: `packages/server/tests/sessions-context.test.ts`

```typescript
import { describe, test, expect, beforeAll, afterAll } from 'bun:test'
import { createTestContext, cleanupTestContext, type TestContext } from './helpers'

describe('AI Session Context Integration', () => {
  let ctx: TestContext
  let projectId: string

  beforeAll(async () => {
    ctx = await createTestContext()
    // Create a test project
    const project = await ctx.api.createProject({ name: 'Test Project' })
    projectId = project.id
  })

  afterAll(async () => {
    await cleanupTestContext(ctx)
  })

  test('small project: session includes document list in system prompt', async () => {
    // Create a few documents
    await ctx.api.createDocument(projectId, { name: 'Requirements' })
    await ctx.api.createDocument(projectId, { name: 'Design Spec' })
    await ctx.api.createDocument(projectId, { name: 'API Reference' })

    // Create session
    const session = await ctx.api.createSession(projectId, {
      title: 'Test Session',
    })

    // Verify system prompt contains document list
    expect(session.system_prompt).toContain('Requirements')
    expect(session.system_prompt).toContain('Design Spec')
    expect(session.system_prompt).toContain('API Reference')
    expect(session.system_prompt).toContain('Project Context')
  })

  test('large project: session includes tool instructions instead of doc list', async () => {
    // Create 25 documents
    for (let i = 0; i < 25; i++) {
      await ctx.api.createDocument(projectId, { name: `Document ${i}` })
    }

    const session = await ctx.api.createSession(projectId, {
      title: 'Large Project Session',
    })

    // Should mention tool usage, not list all docs
    expect(session.system_prompt).toContain('doc_list')
    expect(session.system_prompt).toContain('doc_search')
    expect(session.system_prompt).not.toContain('Document 0')
  })

  test('session preserves user custom prompt alongside project context', async () => {
    const customPrompt = 'You are a helpful assistant specializing in code review.'

    const session = await ctx.api.createSession(projectId, {
      title: 'Custom Prompt Session',
      system_prompt: customPrompt,
    })

    expect(session.system_prompt).toContain(customPrompt)
    expect(session.system_prompt).toContain('Project Context')
  })

  test('sessions are ordered by most recently accessed', async () => {
    // Create sessions
    const session1 = await ctx.api.createSession(projectId, { title: 'Session 1' })
    const session2 = await ctx.api.createSession(projectId, { title: 'Session 2' })
    const session3 = await ctx.api.createSession(projectId, { title: 'Session 3' })

    // Send a message to session1 (makes it most recent)
    await ctx.api.sendMessage(projectId, session1.id, { content: 'Hello' })

    // List sessions
    const list = await ctx.api.listSessions(projectId)

    // Session1 should be first (most recently used)
    expect(list.data[0].id).toBe(session1.id)
  })
})
```

### Success Criteria:

#### Automated Verification:
- [ ] All integration tests pass: `bun test packages/server/tests/sessions-context.test.ts`
- [ ] All phase smoke tests pass: `bun test packages/server/tests/smoke/ai-*.test.ts`

Run the complete test suite for this plan:
```bash
bun test packages/server/tests/smoke/ai-phase1-context.test.ts
bun test packages/server/tests/smoke/ai-phase2-session.test.ts
bun test packages/server/tests/smoke/ai-phase3-tools.test.ts
bun test packages/server/tests/smoke/ai-phase4-ordering.test.ts
bun test packages/server/tests/sessions-context.test.ts
```

---

## Testing Strategy

### Unit Tests:
- `buildProjectContext` with various document counts
- `formatProjectContextPrompt` output formatting
- `searchDocs` with various query patterns
- `listDocs` pagination edge cases

### Integration Tests:
- Session creation with project context injection
- Small vs large project detection
- Document tools with pagination
- Session ordering by last_message_at

### Manual Testing Steps:
1. Create project with 5 documents
2. Create session -> verify system prompt shows doc list
3. Add 20 more documents (total 25)
4. Create new session -> verify system prompt shows tool instructions
5. Use doc_search tool -> verify finds documents by name
6. Use doc_list with pagination -> verify offset/limit work
7. Send messages to older session -> verify it moves to top of list

## Performance Considerations

- `buildProjectContext` does 2 queries (project + docs) - could optimize to single query
- `searchDocs` uses ILIKE which may need index for large projects
- Consider adding index: `CREATE INDEX idx_documents_name_trgm ON documents USING gin(name gin_trgm_ops)`
- Document content truncation prevents context window exhaustion

## Migration Notes

- No data migration needed - this builds on project-scoped sessions
- Existing sessions (if any) will lack project context in system prompt
- New sessions automatically get project context

## References

- Prerequisite plan: `thoughts/shared/plans/2026-02-04-document-folder-hierarchy.md`
- User stories: A1, A2, A3, A4 from web-ai-assistant epic
- Current session routes: `packages/server/routes/sessions.ts`
- Current message handling: `packages/server/routes/messages.ts`
- Document tools: `packages/server/tools/document-tools.ts`
