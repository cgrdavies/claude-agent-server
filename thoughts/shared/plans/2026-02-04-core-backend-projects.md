# Core Backend: Projects Feature Implementation Plan

## Overview

Implement the backend infrastructure for the Projects feature. This includes adding `project_id` foreign keys to documents and sessions, adding soft delete support to projects, creating a Projects API with CRUD operations, and updating the document manager to be project-scoped.

This plan focuses on the **core backend only** - database schema, API routes, and document manager. It does NOT include:
- Frontend/UI implementation
- Folder hierarchy within projects (covered in separate plan)
- Agent tools updates (covered in separate plan)
- Session route updates for project scoping (covered in separate plan)

## Current State Analysis

**Existing infrastructure:**
- `projects` table exists in Supabase with RLS policies
- Projects have: `id`, `workspace_id`, `name`, `description`, `is_archived`, `remote_url`, `default_branch`, `created_by`, timestamps
- Project RLS policies check workspace membership

**Current limitations:**
- Documents are workspace-scoped (no project association) - `documents` table at `supabase/migrations/20260204141103_add_agent_tables.sql:88-125`
- Sessions are workspace-scoped (no project association) - `agent_sessions` table at same file:9-46
- No projects router or API exists
- Server code doesn't use projects at all - `packages/server/index.ts` mounts only sessions and documents routers

### Key Discoveries:
- Projects table already exists with proper RLS policies (`supabase/migrations/20260128204618_remote_schema.sql:1035-1046`)
- `project_permissions` table exists for project-level access control (`supabase/migrations/20260128204618_remote_schema.sql:1021-1028`)
- No `deleted_at` column on projects - need to add for soft delete
- Document manager uses `workspaceId` throughout (`packages/server/document-manager.ts`)

## Desired End State

After implementation:

1. **Projects API** - Full CRUD operations for projects within a workspace
   - List projects (non-deleted)
   - Get single project
   - Create project
   - Update project (rename, description)
   - Soft delete project (superusers only)
   - Restore project (superusers only)

2. **Documents belong to projects** - `project_id NOT NULL` on documents table

3. **Sessions belong to projects** - `project_id NOT NULL` on agent_sessions table

4. **Soft delete support** - `deleted_at` timestamp on projects table

### Verification:
- Create a project via API
- List projects shows only non-deleted projects
- Soft delete hides project from list
- Restore brings project back
- Documents require project_id
- Sessions require project_id

## What We're NOT Doing

- **Folder hierarchy** - Documents will get `path` column in separate plan
- **Nested API routes** - `/api/projects/:projectId/documents` etc. in separate plan
- **Frontend/UI** - API only in this plan
- **Agent tools updates** - Separate plan
- **Project settings beyond CRUD** - No advanced configuration
- **Git integration** - `remote_url` and `default_branch` columns exist but not used
- **Permanent delete** - Only soft delete for now (permanent delete is a future feature)

## Implementation Approach

1. Database: Add `deleted_at` to projects, add `project_id` FK to documents and sessions
2. Shared types: Add Project type and API types
3. Projects router: CRUD operations with soft delete
4. Document manager: Update to accept projectId instead of workspaceId

---

## Phase 1: Database Migration

### Overview
Add `deleted_at` column to projects for soft delete. Add `project_id` FK to documents and agent_sessions tables. Clear existing dev data (no migration needed).

### Changes Required:

#### 1. New migration file
**File**: `supabase/migrations/[timestamp]_add_project_scoping.sql`

```sql
-- ============================================================
-- Add project scoping to documents and agent_sessions
-- Add soft delete support to projects
-- ============================================================

-- 1. Add deleted_at column to projects for soft delete
ALTER TABLE projects
  ADD COLUMN deleted_at TIMESTAMPTZ DEFAULT NULL;

CREATE INDEX idx_projects_deleted_at ON projects(deleted_at);

-- 2. Clear existing data (dev environment - no migration needed)
TRUNCATE TABLE documents CASCADE;
TRUNCATE TABLE agent_sessions CASCADE;
TRUNCATE TABLE messages CASCADE;

-- 3. Add project_id to documents
ALTER TABLE documents
  ADD COLUMN project_id UUID NOT NULL REFERENCES projects(id) ON DELETE CASCADE;

-- 4. Create index for documents by project
CREATE INDEX idx_documents_project ON documents(project_id);

-- 5. Add project_id to agent_sessions
ALTER TABLE agent_sessions
  ADD COLUMN project_id UUID NOT NULL REFERENCES projects(id) ON DELETE CASCADE;

-- 6. Create index for agent_sessions by project
CREATE INDEX idx_agent_sessions_project ON agent_sessions(project_id);

-- 7. Update RLS policies for documents to check project access
DROP POLICY IF EXISTS documents_select ON documents;
DROP POLICY IF EXISTS documents_insert ON documents;
DROP POLICY IF EXISTS documents_update ON documents;
DROP POLICY IF EXISTS documents_delete ON documents;

-- Documents: user must have access to the project's workspace
CREATE POLICY documents_select ON documents FOR SELECT USING (
  project_id IN (
    SELECT p.id FROM projects p
    JOIN workspace_memberships wm ON wm.workspace_id = p.workspace_id
    WHERE wm.user_id = auth.uid()
      AND p.deleted_at IS NULL
  )
);

CREATE POLICY documents_insert ON documents FOR INSERT WITH CHECK (
  created_by = auth.uid()
  AND project_id IN (
    SELECT p.id FROM projects p
    JOIN workspace_memberships wm ON wm.workspace_id = p.workspace_id
    WHERE wm.user_id = auth.uid()
      AND p.deleted_at IS NULL
  )
);

CREATE POLICY documents_update ON documents FOR UPDATE USING (
  project_id IN (
    SELECT p.id FROM projects p
    JOIN workspace_memberships wm ON wm.workspace_id = p.workspace_id
    WHERE wm.user_id = auth.uid()
      AND p.deleted_at IS NULL
  )
);

CREATE POLICY documents_delete ON documents FOR DELETE USING (
  project_id IN (
    SELECT p.id FROM projects p
    JOIN workspace_memberships wm ON wm.workspace_id = p.workspace_id
    WHERE wm.user_id = auth.uid()
      AND p.deleted_at IS NULL
  )
);

-- 8. Update RLS policies for agent_sessions to check project access
DROP POLICY IF EXISTS agent_sessions_select ON agent_sessions;
DROP POLICY IF EXISTS agent_sessions_insert ON agent_sessions;
DROP POLICY IF EXISTS agent_sessions_update ON agent_sessions;

CREATE POLICY agent_sessions_select ON agent_sessions FOR SELECT USING (
  project_id IN (
    SELECT p.id FROM projects p
    JOIN workspace_memberships wm ON wm.workspace_id = p.workspace_id
    WHERE wm.user_id = auth.uid()
      AND p.deleted_at IS NULL
  )
);

CREATE POLICY agent_sessions_insert ON agent_sessions FOR INSERT WITH CHECK (
  created_by = auth.uid()
  AND project_id IN (
    SELECT p.id FROM projects p
    JOIN workspace_memberships wm ON wm.workspace_id = p.workspace_id
    WHERE wm.user_id = auth.uid()
      AND p.deleted_at IS NULL
  )
);

CREATE POLICY agent_sessions_update ON agent_sessions FOR UPDATE USING (
  project_id IN (
    SELECT p.id FROM projects p
    JOIN workspace_memberships wm ON wm.workspace_id = p.workspace_id
    WHERE wm.user_id = auth.uid()
      AND p.deleted_at IS NULL
  )
);
```

### Success Criteria:

#### Automated Verification:
- [x] Migration applies cleanly: `supabase db push` or `supabase migration up`
- [x] Tables have new columns: `SELECT column_name FROM information_schema.columns WHERE table_name = 'documents' AND column_name = 'project_id'`
- [x] `SELECT column_name FROM information_schema.columns WHERE table_name = 'projects' AND column_name = 'deleted_at'`
- [x] Indexes exist: `SELECT indexname FROM pg_indexes WHERE tablename = 'documents' AND indexname = 'idx_documents_project'`
- [x] RLS policies exist: `SELECT policyname FROM pg_policies WHERE tablename = 'documents'`

#### Smoke Test
Create `packages/server/tests/smoke/phase1-schema.test.ts`:
```typescript
import { describe, test, expect } from 'bun:test'
import { sql } from '../test-utils'

describe('Phase 1: Database Schema', () => {
  test('projects table has deleted_at column', async () => {
    const result = await sql`SELECT column_name FROM information_schema.columns
      WHERE table_name = 'projects' AND column_name = 'deleted_at'`
    expect(result.length).toBe(1)
  })

  test('documents table has project_id column', async () => {
    const result = await sql`SELECT column_name FROM information_schema.columns
      WHERE table_name = 'documents' AND column_name = 'project_id'`
    expect(result.length).toBe(1)
  })

  test('agent_sessions table has project_id column', async () => {
    const result = await sql`SELECT column_name FROM information_schema.columns
      WHERE table_name = 'agent_sessions' AND column_name = 'project_id'`
    expect(result.length).toBe(1)
  })

  test('indexes exist', async () => {
    const result = await sql`SELECT indexname FROM pg_indexes
      WHERE tablename IN ('documents', 'agent_sessions', 'projects')
      AND indexname LIKE 'idx_%'`
    expect(result.length).toBeGreaterThanOrEqual(3)
  })
})
```

Run: `bun test packages/server/tests/smoke/phase1-schema.test.ts`

---

## Phase 2: Shared Types & API Contract

### Overview
Add Project type and API types for project CRUD operations.

### Changes Required:

#### 1. Add Project type
**File**: `packages/shared/types.ts`

Add after existing types:

```typescript
export type Project = {
  id: string
  workspace_id: string
  name: string
  description: string | null
  is_archived: boolean
  deleted_at: string | null
  created_by: string
  created_at: string
  updated_at: string
}
```

#### 2. Update Document type
**File**: `packages/shared/types.ts`

Update the existing `Document` type:

```typescript
export type Document = {
  id: string
  project_id: string                     // NEW: documents belong to projects
  workspace_id: string                   // kept for convenience
  name: string
  created_by: string
  created_at: string
  updated_at: string
}
```

#### 3. Update AgentSession type
**File**: `packages/shared/types.ts`

Update the existing `AgentSession` type to include `project_id`:

```typescript
export type AgentSession = {
  id: string
  project_id: string                     // NEW: sessions belong to projects
  workspace_id: string                   // kept for convenience
  title: string
  model: string
  provider: Provider
  system_prompt: string | null
  created_by: string
  created_at: string
  updated_at: string
  last_message_at: string | null
  archived: boolean
}
```

#### 4. Add Project API types
**File**: `packages/shared/api.ts`

Add after existing types:

```typescript
// ============================================================
// Projects
// ============================================================

export type CreateProjectRequest = {
  name: string
  description?: string
}

export type CreateProjectResponse = {
  project: Project
}

export type ListProjectsResponse = {
  projects: Project[]
}

export type GetProjectResponse = {
  project: Project
}

export type UpdateProjectRequest = {
  name?: string
  description?: string
}

export type UpdateProjectResponse = {
  project: Project
}

export type DeleteProjectResponse = {
  success: boolean
}

export type RestoreProjectResponse = {
  project: Project
}
```

Don't forget to add the import for `Project` at the top of the file.

### Success Criteria:

#### Automated Verification:
- [x] TypeScript compilation passes in shared package: `cd packages/shared && bun run build` (or tsc check)
- [x] Types are exported correctly: `bun run tsc --noEmit` in packages/shared

#### Smoke Test
Run type check to verify exports:
```bash
cd packages/shared && bun run tsc --noEmit
```

Verify types are importable from server package:
```bash
cd packages/server && bun run tsc --noEmit
```

---

## Phase 3: Projects Router

### Overview
Create a new projects router with CRUD operations including soft delete and restore.

### Changes Required:

#### 1. Create projects router
**File**: `packages/server/routes/projects.ts`

```typescript
import { Hono } from 'hono'
import type {
  CreateProjectRequest,
  CreateProjectResponse,
  DeleteProjectResponse,
  GetProjectResponse,
  ListProjectsResponse,
  RestoreProjectResponse,
  UpdateProjectRequest,
  UpdateProjectResponse,
} from '@claude-agent/shared'
import { withRLS } from '../lib/db'

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
```

#### 2. Update auth middleware to extract isSuperuser
**File**: `packages/server/middleware/auth.ts`

The JWT already includes `is_superuser` claim (added by `custom_access_token_hook` in `supabase/migrations/20260131110000_add_superuser_claim.sql`). The auth middleware needs to extract this claim and expose it.

Update the `AuthVariables` type:

```typescript
type AuthVariables = {
  userId: string
  workspaceId: string
  isSuperuser: boolean
}
```

After extracting workspace membership, add:

```typescript
// Extract superuser status from JWT claims
const isSuperuser = claims.is_superuser === true
c.set('isSuperuser', isSuperuser)
```

The full middleware change (after line 83 `c.set('workspaceId', workspaceId)`):

```typescript
c.set('userId', user.id)
c.set('workspaceId', workspaceId)
c.set('isSuperuser', claims.is_superuser === true)
```

#### 3. Mount projects router
**File**: `packages/server/index.ts`

Add import and mount:

```typescript
import { projectsRouter } from './routes/projects'

// ... in the api section, after existing routes:
api.route('/projects', projectsRouter)
```

### Success Criteria:

#### Automated Verification:
- [x] TypeScript compilation passes: `cd packages/server && bun run build` (or tsc check)
- [x] Server starts without errors: `cd packages/server && bun run dev`

#### Smoke Test
Create `packages/server/tests/smoke/phase3-projects-api.test.ts`:
```typescript
import { describe, test, expect, beforeAll } from 'bun:test'
import { createTestClient, getTestAuth } from '../test-utils'

describe('Phase 3: Projects API', () => {
  let client: ReturnType<typeof createTestClient>
  let projectId: string

  beforeAll(async () => {
    client = await createTestClient()
  })

  test('POST /api/projects creates a project', async () => {
    const res = await client.post('/api/projects', {
      name: 'Test Project',
      description: 'Created by smoke test'
    })
    expect(res.status).toBe(201)
    const body = await res.json()
    expect(body.project.name).toBe('Test Project')
    projectId = body.project.id
  })

  test('GET /api/projects lists non-deleted projects', async () => {
    const res = await client.get('/api/projects')
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.projects.some((p: any) => p.id === projectId)).toBe(true)
  })

  test('GET /api/projects/:id returns project details', async () => {
    const res = await client.get(`/api/projects/${projectId}`)
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.project.id).toBe(projectId)
  })

  test('PATCH /api/projects/:id updates project', async () => {
    const res = await client.patch(`/api/projects/${projectId}`, {
      name: 'Updated Name'
    })
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.project.name).toBe('Updated Name')
  })

  test('DELETE /api/projects/:id requires superuser', async () => {
    // With non-superuser token
    const res = await client.delete(`/api/projects/${projectId}`)
    expect(res.status).toBe(403)
  })

  // Note: superuser tests require a superuser token in test setup
})
```

Run: `bun test packages/server/tests/smoke/phase3-projects-api.test.ts`

---

## Phase 4: Document Manager Updates

### Overview
Update document manager to accept `projectId` instead of `workspaceId`. This is a significant refactor since all document operations need to be project-scoped.

### Changes Required:

#### 1. Update DocumentInfo type
**File**: `packages/server/document-manager.ts`

```typescript
export type DocumentInfo = {
  id: string
  project_id: string
  workspace_id: string
  name: string
  created_by: string
  created_at: string
  updated_at: string
}
```

#### 2. Update getDoc function
**File**: `packages/server/document-manager.ts`

Change signature and query:

```typescript
/**
 * Get or load a Y.Doc from cache/database.
 * Returns null if document doesn't exist or user doesn't have access.
 */
export async function getDoc(
  userId: string,
  projectId: string,
  id: string,
): Promise<Y.Doc | null> {
  if (docs.has(id)) return docs.get(id)!

  const rows = await withRLS(
    userId,
    sql =>
      sql`SELECT yjs_state FROM documents
        WHERE id = ${id} AND project_id = ${projectId}
        LIMIT 1`,
  )
  const row = rows[0] as { yjs_state: Buffer | Uint8Array } | undefined
  if (!row) return null

  const doc = new Y.Doc()
  const state =
    row.yjs_state instanceof Buffer
      ? new Uint8Array(row.yjs_state)
      : new Uint8Array(row.yjs_state)
  Y.applyUpdate(doc, state)

  // Listen for updates and persist (debounced)
  doc.on('update', () => debouncedPersist(userId, id, doc))

  docs.set(id, doc)
  return doc
}
```

#### 3. Update createDoc function
**File**: `packages/server/document-manager.ts`

```typescript
/**
 * Create a new document with optional initial markdown content.
 * Returns the document info including generated ID.
 */
export async function createDoc(
  userId: string,
  projectId: string,
  name: string,
  content?: string,
): Promise<DocumentInfo> {
  const doc = new Y.Doc()
  const fragment = doc.getXmlFragment('default')

  if (content) {
    populateFragment(fragment, content)
  } else {
    prosemirrorJSONToYXmlFragment(schema, EMPTY_DOC_JSON, fragment)
  }

  const state = Buffer.from(Y.encodeStateAsUpdate(doc))
  const id = crypto.randomUUID()

  // Get workspace_id from project
  const projectRows = await withRLS(
    userId,
    sql => sql`SELECT workspace_id FROM projects WHERE id = ${projectId} AND deleted_at IS NULL LIMIT 1`
  )
  const workspaceId = (projectRows[0] as { workspace_id: string })?.workspace_id
  if (!workspaceId) throw new Error('Project not found')

  const rows = await withRLS(
    userId,
    sql =>
      sql`INSERT INTO documents (id, project_id, workspace_id, name, yjs_state, created_by)
        VALUES (${id}, ${projectId}, ${workspaceId}, ${name}, ${state}, ${userId})
        RETURNING id, project_id, workspace_id, name, created_by, created_at, updated_at`,
  )
  const info = rows[0] as DocumentInfo

  doc.on('update', () => debouncedPersist(userId, id, doc))
  docs.set(id, doc)

  return info
}
```

#### 4. Update deleteDoc function
**File**: `packages/server/document-manager.ts`

```typescript
/**
 * Delete a document.
 */
export async function deleteDoc(
  userId: string,
  projectId: string,
  id: string,
): Promise<boolean> {
  const doc = docs.get(id)
  if (doc) {
    doc.destroy()
    docs.delete(id)
  }

  // Cancel any pending persist
  cancelPendingPersist(id)

  const result = await withRLS(
    userId,
    sql =>
      sql`DELETE FROM documents WHERE id = ${id} AND project_id = ${projectId} RETURNING id`,
  )
  return result.length > 0
}
```

#### 5. Update listDocs function
**File**: `packages/server/document-manager.ts`

```typescript
/**
 * List all documents in a project.
 */
export async function listDocs(
  userId: string,
  projectId: string,
): Promise<DocumentInfo[]> {
  const rows = await withRLS(
    userId,
    sql =>
      sql`SELECT id, project_id, workspace_id, name, created_by, created_at, updated_at
        FROM documents
        WHERE project_id = ${projectId}
        ORDER BY updated_at DESC`,
  )
  return rows as unknown as DocumentInfo[]
}
```

#### 6. Update readDocAsText function
**File**: `packages/server/document-manager.ts`

```typescript
/**
 * Read document content as markdown string.
 */
export async function readDocAsText(
  userId: string,
  projectId: string,
  id: string,
): Promise<{ name: string; content: string } | null> {
  const doc = await getDoc(userId, projectId, id)
  if (!doc) return null

  // Get the name from DB
  const rows = await withRLS(
    userId,
    sql =>
      sql`SELECT name FROM documents WHERE id = ${id} AND project_id = ${projectId} LIMIT 1`,
  )
  const row = rows[0] as { name: string } | undefined
  if (!row) return null

  const fragment = doc.getXmlFragment('default')
  return { name: row.name, content: fragmentToMarkdown(fragment) }
}
```

#### 7. Update editDoc function
**File**: `packages/server/document-manager.ts`

```typescript
export async function editDoc(
  userId: string,
  projectId: string,
  id: string,
  oldText: string,
  newText: string,
): Promise<boolean> {
  const doc = await getDoc(userId, projectId, id)
  if (!doc) throw new Error(`Document ${id} not found`)

  const fragment = doc.getXmlFragment('default')
  const content = fragmentToMarkdown(fragment)
  const match = findNormalizedMatch(content, oldText)
  if (!match) return false

  const edited =
    content.slice(0, match.start) + newText + content.slice(match.end)

  doc.transact(() => {
    while (fragment.length > 0) {
      fragment.delete(0, 1)
    }
    populateFragment(fragment, edited)
  })

  cancelPendingPersist(id)
  await persistDoc(userId, id, doc)

  return true
}
```

#### 8. Update appendDoc function
**File**: `packages/server/document-manager.ts`

```typescript
export async function appendDoc(
  userId: string,
  projectId: string,
  id: string,
  content: string,
): Promise<void> {
  const doc = await getDoc(userId, projectId, id)
  if (!doc) throw new Error(`Document ${id} not found`)

  const fragment = doc.getXmlFragment('default')
  const current = fragmentToMarkdown(fragment)
  const separator = current.endsWith('\n\n') ? '' : current.endsWith('\n') ? '\n' : '\n\n'
  const combined = current + separator + content

  doc.transact(() => {
    while (fragment.length > 0) {
      fragment.delete(0, 1)
    }
    populateFragment(fragment, combined)
  })

  cancelPendingPersist(id)
  await persistDoc(userId, id, doc)
}
```

#### 9. Update replaceDocContent function
**File**: `packages/server/document-manager.ts`

```typescript
export async function replaceDocContent(
  userId: string,
  projectId: string,
  id: string,
  markdown: string,
): Promise<void> {
  const doc = await getDoc(userId, projectId, id)
  if (!doc) throw new Error(`Document ${id} not found`)

  const fragment = doc.getXmlFragment('default')

  doc.transact(() => {
    while (fragment.length > 0) {
      fragment.delete(0, 1)
    }
    populateFragment(fragment, markdown)
  })

  cancelPendingPersist(id)
  await persistDoc(userId, id, doc)
}
```

#### 10. Update renameDoc function
**File**: `packages/server/document-manager.ts`

```typescript
export async function renameDoc(
  userId: string,
  projectId: string,
  id: string,
  name: string,
): Promise<void> {
  await withRLS(
    userId,
    sql =>
      sql`UPDATE documents SET name = ${name}, updated_at = now()
        WHERE id = ${id} AND project_id = ${projectId}`,
  )
}
```

#### 11. Update getDocInfo function
**File**: `packages/server/document-manager.ts`

```typescript
export async function getDocInfo(
  userId: string,
  projectId: string,
  id: string,
): Promise<DocumentInfo | null> {
  const rows = await withRLS(
    userId,
    sql =>
      sql`SELECT id, project_id, workspace_id, name, created_by, created_at, updated_at
        FROM documents
        WHERE id = ${id} AND project_id = ${projectId}
        LIMIT 1`,
  )
  return (rows[0] as DocumentInfo | undefined) ?? null
}
```

### Success Criteria:

#### Automated Verification:
- [x] TypeScript compilation passes: `cd packages/server && bun run build`
- [ ] Existing tests still pass (after updating test fixtures): `cd packages/server && bun test`

#### Smoke Test
Create `packages/server/tests/smoke/phase4-document-manager.test.ts`:
```typescript
import { describe, test, expect, beforeAll } from 'bun:test'
import { createTestClient } from '../test-utils'
import * as docManager from '../../document-manager'

describe('Phase 4: Document Manager', () => {
  let client: ReturnType<typeof createTestClient>
  let projectId: string
  let userId: string

  beforeAll(async () => {
    client = await createTestClient()
    // Create a test project first
    const res = await client.post('/api/projects', { name: 'DocManager Test' })
    const body = await res.json()
    projectId = body.project.id
    userId = client.userId
  })

  test('createDoc creates document with projectId', async () => {
    const info = await docManager.createDoc(userId, projectId, 'Test Doc', '# Hello')
    expect(info.id).toBeDefined()
    expect(info.project_id).toBe(projectId)
    expect(info.name).toBe('Test Doc')
  })

  test('listDocs returns documents for project', async () => {
    const docs = await docManager.listDocs(userId, projectId)
    expect(docs.length).toBeGreaterThan(0)
    expect(docs.every(d => d.project_id === projectId)).toBe(true)
  })

  test('readDocAsText returns document content', async () => {
    const docs = await docManager.listDocs(userId, projectId)
    const result = await docManager.readDocAsText(userId, projectId, docs[0].id)
    expect(result).not.toBeNull()
    expect(result!.content).toContain('Hello')
  })
})
```

Run: `bun test packages/server/tests/smoke/phase4-document-manager.test.ts`

---

## Phase 5: Document Routes Updates

### Overview
Update document routes to use projectId from URL or request body. For now, documents will still be at `/api/documents` but require projectId in the request.

**Note**: Moving routes to `/api/projects/:projectId/documents` is out of scope for this plan - that's a separate "nested routes" change.

### Changes Required:

#### 1. Update documents router
**File**: `packages/server/routes/documents.ts`

The documents router needs to accept `projectId` in requests. For now, we'll add it as a required field in the request body/query params:

```typescript
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

// Extend request types to include projectId
type CreateDocumentRequestWithProject = CreateDocumentRequest & { project_id: string }
type UpdateDocumentRequestWithProject = UpdateDocumentRequest & { project_id?: string }

export const documentsRouter = new Hono<Env>()

// POST /api/documents
documentsRouter.post('/', async (c) => {
  const userId = c.get('userId')
  const body = await c.req.json<CreateDocumentRequestWithProject>()

  if (!body.project_id) {
    return c.json({ error: 'project_id is required' }, 400)
  }

  const info = await docManager.createDoc(userId, body.project_id, body.name, body.content)

  return c.json({
    document: {
      id: info.id,
      project_id: info.project_id,
      workspace_id: info.workspace_id,
      name: info.name,
      created_by: info.created_by,
      created_at: info.created_at,
      updated_at: info.updated_at,
    },
  } satisfies CreateDocumentResponse, 201)
})

// GET /api/documents?project_id=xxx
documentsRouter.get('/', async (c) => {
  const userId = c.get('userId')
  const projectId = c.req.query('project_id')

  if (!projectId) {
    return c.json({ error: 'project_id query parameter is required' }, 400)
  }

  const documents = await docManager.listDocs(userId, projectId)

  return c.json({
    documents: documents.map((d) => ({
      id: d.id,
      project_id: d.project_id,
      workspace_id: d.workspace_id,
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

  return c.json({
    document: {
      id: info.id,
      project_id: info.project_id,
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
  const docId = c.req.param('id')
  const body = await c.req.json<UpdateDocumentRequestWithProject>()

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

  const updated = await docManager.getDocInfo(userId, body.project_id, docId)
  if (!updated) return c.json({ error: 'Document not found' }, 404)

  return c.json({
    document: {
      id: updated.id,
      project_id: updated.project_id,
      workspace_id: updated.workspace_id,
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
```

#### 2. Update shared API types
**File**: `packages/shared/api.ts`

Update request types to include project_id:

```typescript
export type CreateDocumentRequest = {
  name: string
  content?: string
  project_id: string                     // NEW: required
}

export type UpdateDocumentRequest = {
  name?: string
  content?: string
  project_id: string                     // NEW: required
}
```

### Success Criteria:

#### Automated Verification:
- [x] TypeScript compilation passes: `bun run tsc --noEmit`
- [x] Server starts without errors: `bun run dev`
- [x] Phase 5 smoke tests pass: `bun test packages/server/tests/smoke/phase5-documents-api.test.ts`

#### Smoke Test
Create `packages/server/tests/smoke/phase5-documents-api.test.ts`:
```typescript
import { describe, test, expect, beforeAll } from 'bun:test'
import { createTestClient } from '../test-utils'

describe('Phase 5: Documents API with Project Scoping', () => {
  let client: ReturnType<typeof createTestClient>
  let projectId: string
  let docId: string

  beforeAll(async () => {
    client = await createTestClient()
    const res = await client.post('/api/projects', { name: 'DocRoutes Test' })
    projectId = (await res.json()).project.id
  })

  test('POST /api/documents with project_id creates document', async () => {
    const res = await client.post('/api/documents', {
      name: 'Test Doc',
      project_id: projectId,
      content: '# Test'
    })
    expect(res.status).toBe(201)
    const body = await res.json()
    expect(body.document.project_id).toBe(projectId)
    docId = body.document.id
  })

  test('GET /api/documents?project_id lists documents', async () => {
    const res = await client.get(`/api/documents?project_id=${projectId}`)
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.documents.length).toBeGreaterThan(0)
  })

  test('GET /api/documents/:id?project_id returns document', async () => {
    const res = await client.get(`/api/documents/${docId}?project_id=${projectId}`)
    expect(res.status).toBe(200)
  })

  test('requests without project_id return 400', async () => {
    const res = await client.get('/api/documents')
    expect(res.status).toBe(400)
  })
})
```

Run: `bun test packages/server/tests/smoke/phase5-documents-api.test.ts`

---

## Testing Strategy

### Unit Tests:
- Project router: create, list, get, update, delete, restore
- Superuser-only delete/restore permissions
- Document manager functions with project scoping
- Validation (name length, required fields)

### Integration Tests:
- Create project, then create documents in it
- Soft delete project, verify documents become inaccessible
- Restore project, verify documents accessible again
- RLS enforcement for project access

### Manual Testing Steps:
1. Create project: `POST /api/projects {"name": "My Project", "description": "Test"}`
2. List projects: `GET /api/projects` - should see new project
3. Get project: `GET /api/projects/:id`
4. Update project: `PATCH /api/projects/:id {"name": "Renamed"}`
5. Create document: `POST /api/documents {"name": "Test Doc", "project_id": ":id"}`
6. List documents: `GET /api/documents?project_id=:id`
7. Delete project (as superuser): `DELETE /api/projects/:id`
8. List projects: `GET /api/projects` - should NOT see deleted project
9. Restore project: `POST /api/projects/:id/restore`
10. List projects: `GET /api/projects` - should see restored project

## Performance Considerations

- `deleted_at` index on projects covers soft delete queries
- `project_id` index on documents/sessions covers scoped queries
- RLS joins to workspace_memberships are already indexed
- No significant performance impact expected

## Migration Notes

- This is a **breaking change** - existing documents and sessions are deleted
- All document API calls now require `project_id`
- Projects table gets new `deleted_at` column
- Soft delete is the default; no permanent delete endpoint yet

## References

- Projects table: `supabase/migrations/20260128204618_remote_schema.sql:1035-1046`
- Current document manager: `packages/server/document-manager.ts`
- Current document routes: `packages/server/routes/documents.ts`
- Session routes: `packages/server/routes/sessions.ts`
- Shared types: `packages/shared/types.ts`, `packages/shared/api.ts`
- Existing plan (folder hierarchy): `thoughts/shared/plans/2026-02-04-document-folder-hierarchy.md`

## Related User Stories

From the web-projects epic:
- **create-project** (P1): Create project with name and description
- **rename-project** (P2): Update project name via modal
- **delete-project** (P3): Soft delete, superusers only
- **view-all-projects** (P4): List projects with metadata
- **switch-projects** (P5): Navigate between projects (frontend only)
