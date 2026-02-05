# Projects, Documents & Folder Hierarchy Implementation Plan

## Overview

Introduce projects as a first-class organizational layer. Documents and sessions become project-scoped rather than workspace-scoped. Documents gain a `path` column for folder hierarchy within each project. The API is restructured to nest resources under projects.

**New hierarchy:**
```
Workspace → Projects → Documents (with path-based folders)
                    → Sessions
```

## Current State Analysis

**Existing infrastructure:**
- `projects` table exists in Supabase with RLS policies (`supabase/migrations/20260128204618_remote_schema.sql:1035-1046`)
- Projects have: `id`, `workspace_id`, `name`, `description`, `is_archived`, `remote_url`, `default_branch`, timestamps
- Project RLS policies check workspace membership and project permissions

**Current document system:**
- Documents are workspace-scoped (no project association)
- Flat structure, no folders (`packages/server/document-manager.ts`)
- Routes at `/api/documents` (`packages/server/routes/documents.ts`)

**Current session system:**
- `agent_sessions` table is workspace-scoped (no project association)
- Routes at `/api/sessions` (`packages/server/routes/sessions.ts`)

**Auth middleware:**
- Extracts `userId` and `workspaceId` from JWT (`packages/server/middleware/auth.ts`)

### Key Discoveries:
- Projects table already exists with proper RLS policies
- `project_permissions` table exists for project-level access control
- The server code doesn't currently use projects at all
- Agent tools are workspace-scoped, unaware of projects

## Desired End State

After implementation:

1. **Projects API** - CRUD operations for projects within a workspace
2. **Documents belong to projects** - `project_id NOT NULL` on documents table
3. **Sessions belong to projects** - `project_id NOT NULL` on agent_sessions table
4. **Folder hierarchy** - Documents have `path` for organization within a project
5. **Nested API routes** - `/api/projects/:projectId/documents`, `/api/projects/:projectId/sessions`
6. **Agent tools** - Project-aware with folder support

### Verification:
- Create a project, add documents with paths, list by folder
- Create sessions within a project
- Verify RLS enforces project-level access
- Agent can work with documents in a project context

## What We're NOT Doing

- **Project settings/configuration** - Beyond basic CRUD, no advanced settings
- **Project-level permissions UI** - Using existing RLS, no custom permission management
- **Git integration** - `remote_url` and `default_branch` columns exist but not implemented
- **Cross-project operations** - No moving documents between projects
- **Frontend/UI** - API only
- **Migrating existing data** - Existing documents/sessions can be deleted (dev only)

## Implementation Approach

1. Add `project_id` FK to `documents` and `agent_sessions` tables
2. Add `path` column to `documents` for folder hierarchy
3. Create projects router with CRUD operations
4. Restructure document/session routes under projects
5. Update auth middleware to optionally extract `projectId`
6. Update agent tools to be project-aware

---

## Phase 1: Database Migration

### Overview
Add `project_id` to documents and agent_sessions tables. Add `path` to documents. Drop any existing data (dev environment only).

### Changes Required:

#### 1. New migration file
**File**: `supabase/migrations/[timestamp]_add_project_scoping.sql`

```sql
-- ============================================================
-- Add project scoping to documents and agent_sessions
-- ============================================================

-- 1. Clear existing data (dev environment - no migration needed)
TRUNCATE TABLE documents CASCADE;
TRUNCATE TABLE agent_sessions CASCADE;
TRUNCATE TABLE messages CASCADE;

-- 2. Add project_id to documents
ALTER TABLE documents
  ADD COLUMN project_id UUID NOT NULL REFERENCES projects(id) ON DELETE CASCADE;

-- 3. Add path column to documents for folder hierarchy
-- Paths always start and end with '/', e.g., '/' for root, '/Design/Mockups/'
ALTER TABLE documents
  ADD COLUMN path TEXT NOT NULL DEFAULT '/';

-- 4. Update documents index to include project_id and path
DROP INDEX IF EXISTS idx_documents_workspace;
CREATE INDEX idx_documents_project ON documents(project_id);
CREATE INDEX idx_documents_project_path ON documents(project_id, path);

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
  )
);

CREATE POLICY documents_insert ON documents FOR INSERT WITH CHECK (
  created_by = auth.uid()
  AND project_id IN (
    SELECT p.id FROM projects p
    JOIN workspace_memberships wm ON wm.workspace_id = p.workspace_id
    WHERE wm.user_id = auth.uid()
  )
);

CREATE POLICY documents_update ON documents FOR UPDATE USING (
  project_id IN (
    SELECT p.id FROM projects p
    JOIN workspace_memberships wm ON wm.workspace_id = p.workspace_id
    WHERE wm.user_id = auth.uid()
  )
);

CREATE POLICY documents_delete ON documents FOR DELETE USING (
  project_id IN (
    SELECT p.id FROM projects p
    JOIN workspace_memberships wm ON wm.workspace_id = p.workspace_id
    WHERE wm.user_id = auth.uid()
  )
);

-- 8. Update RLS policies for agent_sessions to check project access
DROP POLICY IF EXISTS agent_sessions_select ON agent_sessions;
DROP POLICY IF EXISTS agent_sessions_insert ON agent_sessions;
DROP POLICY IF EXISTS agent_sessions_update ON agent_sessions;
DROP POLICY IF EXISTS agent_sessions_delete ON agent_sessions;

CREATE POLICY agent_sessions_select ON agent_sessions FOR SELECT USING (
  project_id IN (
    SELECT p.id FROM projects p
    JOIN workspace_memberships wm ON wm.workspace_id = p.workspace_id
    WHERE wm.user_id = auth.uid()
  )
);

CREATE POLICY agent_sessions_insert ON agent_sessions FOR INSERT WITH CHECK (
  created_by = auth.uid()
  AND project_id IN (
    SELECT p.id FROM projects p
    JOIN workspace_memberships wm ON wm.workspace_id = p.workspace_id
    WHERE wm.user_id = auth.uid()
  )
);

CREATE POLICY agent_sessions_update ON agent_sessions FOR UPDATE USING (
  project_id IN (
    SELECT p.id FROM projects p
    JOIN workspace_memberships wm ON wm.workspace_id = p.workspace_id
    WHERE wm.user_id = auth.uid()
  )
);

CREATE POLICY agent_sessions_delete ON agent_sessions FOR DELETE USING (
  project_id IN (
    SELECT p.id FROM projects p
    JOIN workspace_memberships wm ON wm.workspace_id = p.workspace_id
    WHERE wm.user_id = auth.uid()
  )
);
```

### Success Criteria:

#### Automated Verification:
- [ ] Migration applies cleanly: `supabase db push` or `supabase migration up`
- [ ] Tables have new columns: `SELECT column_name FROM information_schema.columns WHERE table_name = 'documents'`
- [ ] Indexes exist: `SELECT indexname FROM pg_indexes WHERE tablename = 'documents'`
- [ ] RLS policies exist: `SELECT policyname FROM pg_policies WHERE tablename = 'documents'`

#### Manual Verification:
- [ ] Verify in Supabase dashboard that columns, indexes, and policies exist

**Implementation Note**: After completing this phase, pause for manual confirmation before proceeding.

---

## Phase 2: Shared Types & API Contract Updates

### Overview
Update type definitions to include `project_id` and `path`. Define new API types for projects and nested resources.

### Changes Required:

#### 1. Add Project type
**File**: `packages/shared/types.ts`

```typescript
export type Project = {
  id: string
  workspace_id: string
  name: string
  description: string | null
  is_archived: boolean
  remote_url: string | null
  default_branch: string | null
  created_by: string
  created_at: string
  updated_at: string
}
```

#### 2. Update Document type
**File**: `packages/shared/types.ts`

```typescript
export type Document = {
  id: string
  project_id: string                     // NEW: documents belong to projects
  workspace_id: string                   // kept for convenience
  name: string
  path: string                           // NEW: folder path, e.g., '/' or '/Design/'
  created_by: string
  created_at: string
  updated_at: string
}
```

#### 3. Update AgentSession type
**File**: `packages/shared/types.ts`

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
  is_archived?: boolean
}

export type UpdateProjectResponse = {
  project: Project
}
```

#### 5. Update Document API types
**File**: `packages/shared/api.ts`

```typescript
export type CreateDocumentRequest = {
  name: string
  content?: string                       // initial markdown
  path?: string                          // folder path, defaults to '/'
}

export type FolderEntry = {
  name: string                           // folder name (not full path)
  path: string                           // full path including this folder
}

export type ListDocumentsResponse = {
  documents: Document[]
  folders?: FolderEntry[]                // present when listing a specific path
}
```

#### 6. Update route definitions
**File**: `packages/shared/routes.ts`

```typescript
export const API_ROUTES = {
  // Health
  health: 'GET /health',

  // Projects
  createProject:  'POST   /api/projects',
  listProjects:   'GET    /api/projects',
  getProject:     'GET    /api/projects/:projectId',
  updateProject:  'PATCH  /api/projects/:projectId',
  deleteProject:  'DELETE /api/projects/:projectId',

  // Sessions (nested under projects)
  createSession:  'POST   /api/projects/:projectId/sessions',
  listSessions:   'GET    /api/projects/:projectId/sessions',
  getSession:     'GET    /api/projects/:projectId/sessions/:id',
  updateSession:  'PATCH  /api/projects/:projectId/sessions/:id',

  // Messages (streaming)
  sendMessage:    'POST   /api/projects/:projectId/sessions/:id/messages',

  // Documents (nested under projects)
  createDocument: 'POST   /api/projects/:projectId/documents',
  listDocuments:  'GET    /api/projects/:projectId/documents',
  getDocument:    'GET    /api/projects/:projectId/documents/:id',
  updateDocument: 'PATCH  /api/projects/:projectId/documents/:id',
  deleteDocument: 'DELETE /api/projects/:projectId/documents/:id',

  // Yjs WebSocket (upgrade)
  documentSync:   'GET    /ws/documents/:id',
} as const
```

### Success Criteria:

#### Automated Verification:
- [ ] TypeScript compilation passes in shared package
- [ ] No type errors in dependent packages (may have errors until routes updated)

#### Manual Verification:
- [ ] Types are consistent and make sense

**Implementation Note**: After completing this phase, pause for manual confirmation before proceeding.

---

## Phase 3: Projects Router

### Overview
Create a new projects router with CRUD operations for projects.

### Changes Required:

#### 1. Create projects router
**File**: `packages/server/routes/projects.ts`

```typescript
import { Hono } from 'hono'
import type {
  CreateProjectRequest,
  CreateProjectResponse,
  GetProjectResponse,
  ListProjectsResponse,
  UpdateProjectRequest,
  UpdateProjectResponse,
} from '@claude-agent/shared'
import { withRLS } from '../lib/db'

type Env = { Variables: { userId: string; workspaceId: string } }

export const projectsRouter = new Hono<Env>()

// POST /api/projects
projectsRouter.post('/', async (c) => {
  const userId = c.get('userId')
  const workspaceId = c.get('workspaceId')
  const body = await c.req.json<CreateProjectRequest>()

  const rows = await withRLS(userId, (sql) =>
    sql`INSERT INTO projects (workspace_id, name, description, created_by)
        VALUES (${workspaceId}, ${body.name}, ${body.description ?? null}, ${userId})
        RETURNING *`
  )
  const project = rows[0]

  return c.json({ project } satisfies CreateProjectResponse, 201)
})

// GET /api/projects
projectsRouter.get('/', async (c) => {
  const userId = c.get('userId')
  const workspaceId = c.get('workspaceId')

  const projects = await withRLS(userId, (sql) =>
    sql`SELECT * FROM projects
        WHERE workspace_id = ${workspaceId}
          AND is_archived = false
        ORDER BY updated_at DESC`
  )

  return c.json({ projects } satisfies ListProjectsResponse)
})

// GET /api/projects/:projectId
projectsRouter.get('/:projectId', async (c) => {
  const userId = c.get('userId')
  const projectId = c.req.param('projectId')

  const rows = await withRLS(userId, (sql) =>
    sql`SELECT * FROM projects WHERE id = ${projectId} LIMIT 1`
  )
  const project = rows[0]
  if (!project) return c.json({ error: 'Project not found' }, 404)

  return c.json({ project } satisfies GetProjectResponse)
})

// PATCH /api/projects/:projectId
projectsRouter.patch('/:projectId', async (c) => {
  const userId = c.get('userId')
  const projectId = c.req.param('projectId')
  const body = await c.req.json<UpdateProjectRequest>()

  // Build dynamic update
  const updates: string[] = []
  const values: unknown[] = []

  if (body.name !== undefined) {
    updates.push('name')
    values.push(body.name)
  }
  if (body.description !== undefined) {
    updates.push('description')
    values.push(body.description)
  }
  if (body.is_archived !== undefined) {
    updates.push('is_archived')
    values.push(body.is_archived)
  }

  if (updates.length === 0) {
    const rows = await withRLS(userId, (sql) =>
      sql`SELECT * FROM projects WHERE id = ${projectId} LIMIT 1`
    )
    const project = rows[0]
    if (!project) return c.json({ error: 'Project not found' }, 404)
    return c.json({ project } satisfies UpdateProjectResponse)
  }

  const rows = await withRLS(userId, (sql) =>
    sql`UPDATE projects
        SET name = COALESCE(${body.name}, name),
            description = COALESCE(${body.description}, description),
            is_archived = COALESCE(${body.is_archived}, is_archived),
            updated_at = now()
        WHERE id = ${projectId}
        RETURNING *`
  )
  const project = rows[0]
  if (!project) return c.json({ error: 'Project not found' }, 404)

  return c.json({ project } satisfies UpdateProjectResponse)
})

// DELETE /api/projects/:projectId
projectsRouter.delete('/:projectId', async (c) => {
  const userId = c.get('userId')
  const projectId = c.req.param('projectId')

  const result = await withRLS(userId, (sql) =>
    sql`DELETE FROM projects WHERE id = ${projectId} RETURNING id`
  )
  if (result.length === 0) return c.json({ error: 'Project not found' }, 404)

  return c.json({ success: true })
})
```

#### 2. Mount projects router
**File**: `packages/server/index.ts`

Add import and mount:

```typescript
import { projectsRouter } from './routes/projects'

// ... in the api section:
api.route('/projects', projectsRouter)
```

### Success Criteria:

#### Automated Verification:
- [ ] TypeScript compilation passes
- [ ] Server starts without errors

#### Manual Verification:
- [ ] `POST /api/projects` creates a project
- [ ] `GET /api/projects` lists projects
- [ ] `GET /api/projects/:id` returns project details
- [ ] `PATCH /api/projects/:id` updates project
- [ ] `DELETE /api/projects/:id` deletes project

**Implementation Note**: After completing this phase, pause for manual confirmation before proceeding.

---

## Phase 4: Document Manager Updates

### Overview
Update document manager to be project-scoped with path support.

### Changes Required:

#### 1. Update DocumentInfo type
**File**: `packages/server/document-manager.ts`

```typescript
export type DocumentInfo = {
  id: string
  project_id: string
  workspace_id: string
  name: string
  path: string
  created_by: string
  created_at: string
  updated_at: string
}
```

#### 2. Add path normalization helper
**File**: `packages/server/document-manager.ts`

```typescript
/**
 * Normalize a folder path to ensure it starts and ends with '/'.
 */
function normalizePath(path?: string): string {
  if (!path || path === '/') return '/'
  let p = path.trim()
  if (!p.startsWith('/')) p = '/' + p
  if (!p.endsWith('/')) p = p + '/'
  return p.replace(/\/+/g, '/')
}
```

#### 3. Update createDoc
**File**: `packages/server/document-manager.ts`

Change signature to accept `projectId` instead of `workspaceId`, plus `path`:

```typescript
export async function createDoc(
  userId: string,
  projectId: string,
  name: string,
  content?: string,
  path?: string,
): Promise<DocumentInfo> {
  const normalizedPath = normalizePath(path)
  const doc = new Y.Doc()
  const fragment = doc.getXmlFragment('default')

  if (content) {
    populateFragment(fragment, content)
  } else {
    prosemirrorJSONToYXmlFragment(schema, EMPTY_DOC_JSON, fragment)
  }

  const state = Buffer.from(Y.encodeStateAsUpdate(doc))
  const id = crypto.randomUUID()

  const rows = await withRLS(
    userId,
    sql =>
      sql`INSERT INTO documents (id, project_id, name, path, yjs_state, created_by)
        VALUES (${id}, ${projectId}, ${name}, ${normalizedPath}, ${state}, ${userId})
        RETURNING id, project_id, workspace_id, name, path, created_by, created_at, updated_at`,
  )
  const info = rows[0] as DocumentInfo

  doc.on('update', () => debouncedPersist(userId, id, doc))
  docs.set(id, doc)

  return info
}
```

Note: The `workspace_id` will come from a JOIN in the SELECT - we need to update the INSERT to either:
- Include workspace_id computed from project, OR
- Rely on a DB trigger, OR
- Remove workspace_id from documents (it's redundant since project has workspace_id)

For simplicity, let's remove `workspace_id` from the documents table in the migration and derive it via JOIN when needed.

**Actually, let me revise** - keeping `workspace_id` on documents is useful for simpler RLS. Let's keep it and populate it from the project:

```sql
-- In migration, we can add a trigger or handle in app code
```

In app code:
```typescript
// First get workspace_id from project
const projectRows = await withRLS(
  userId,
  sql => sql`SELECT workspace_id FROM projects WHERE id = ${projectId} LIMIT 1`
)
const workspaceId = (projectRows[0] as { workspace_id: string })?.workspace_id
if (!workspaceId) throw new Error('Project not found')

const rows = await withRLS(
  userId,
  sql =>
    sql`INSERT INTO documents (id, project_id, workspace_id, name, path, yjs_state, created_by)
      VALUES (${id}, ${projectId}, ${workspaceId}, ${name}, ${normalizedPath}, ${state}, ${userId})
      RETURNING *`,
)
```

#### 4. Update listDocs with folder support
**File**: `packages/server/document-manager.ts`

```typescript
export type FolderEntry = {
  name: string
  path: string
}

export async function listDocs(
  userId: string,
  projectId: string,
  path?: string,
): Promise<{ documents: DocumentInfo[]; folders: FolderEntry[] }> {
  if (!path) {
    // Flat list of all documents in project
    const rows = await withRLS(
      userId,
      sql =>
        sql`SELECT id, project_id, workspace_id, name, path, created_by, created_at, updated_at
          FROM documents
          WHERE project_id = ${projectId}
          ORDER BY updated_at DESC`,
    )
    return { documents: rows as unknown as DocumentInfo[], folders: [] }
  }

  const normalizedPath = normalizePath(path)

  // Documents at this exact path level
  const docRows = await withRLS(
    userId,
    sql =>
      sql`SELECT id, project_id, workspace_id, name, path, created_by, created_at, updated_at
        FROM documents
        WHERE project_id = ${projectId} AND path = ${normalizedPath}
        ORDER BY name ASC`,
  )

  // Find immediate subfolders
  const folderRows = await withRLS(
    userId,
    sql =>
      sql`SELECT DISTINCT
          split_part(substring(path FROM ${normalizedPath.length + 1}), '/', 1) AS folder_name
        FROM documents
        WHERE project_id = ${projectId}
          AND path LIKE ${normalizedPath + '%'}
          AND path != ${normalizedPath}`,
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
  }
}
```

#### 5. Update other functions
Update `getDoc`, `readDocAsText`, `editDoc`, `appendDoc`, `replaceDocContent`, `deleteDoc`, `renameDoc`, `getDocInfo` to use `projectId` instead of `workspaceId`. The pattern is the same - replace `workspace_id = ${workspaceId}` with `project_id = ${projectId}` in WHERE clauses.

#### 6. Add moveDoc function
**File**: `packages/server/document-manager.ts`

```typescript
export async function moveDoc(
  userId: string,
  projectId: string,
  id: string,
  newPath: string,
): Promise<void> {
  const normalizedPath = normalizePath(newPath)
  await withRLS(
    userId,
    sql =>
      sql`UPDATE documents SET path = ${normalizedPath}, updated_at = now()
        WHERE id = ${id} AND project_id = ${projectId}`,
  )
}
```

### Success Criteria:

#### Automated Verification:
- [ ] TypeScript compilation passes
- [ ] `normalizePath` tests pass (add unit tests)

#### Manual Verification:
- [ ] Documents can be created with project_id and path

**Implementation Note**: After completing this phase, pause for manual confirmation before proceeding.

---

## Phase 5: Document Routes (Project-Scoped)

### Overview
Restructure document routes to be nested under projects.

### Changes Required:

#### 1. Update documents router
**File**: `packages/server/routes/documents.ts`

Change to accept `projectId` from URL param:

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

export const documentsRouter = new Hono<Env>()

// POST /api/projects/:projectId/documents
documentsRouter.post('/', async (c) => {
  const userId = c.get('userId')
  const projectId = c.req.param('projectId')
  const body = await c.req.json<CreateDocumentRequest>()

  const info = await docManager.createDoc(userId, projectId, body.name, body.content, body.path)

  return c.json({
    document: {
      id: info.id,
      project_id: info.project_id,
      workspace_id: info.workspace_id,
      name: info.name,
      path: info.path,
      created_by: info.created_by,
      created_at: info.created_at,
      updated_at: info.updated_at,
    },
  } satisfies CreateDocumentResponse, 201)
})

// GET /api/projects/:projectId/documents
documentsRouter.get('/', async (c) => {
  const userId = c.get('userId')
  const projectId = c.req.param('projectId')
  const path = c.req.query('path')

  const result = await docManager.listDocs(userId, projectId, path || undefined)

  return c.json({
    documents: result.documents.map((d) => ({
      id: d.id,
      project_id: d.project_id,
      workspace_id: d.workspace_id,
      name: d.name,
      path: d.path,
      created_by: d.created_by,
      created_at: d.created_at,
      updated_at: d.updated_at,
    })),
    ...(path ? { folders: result.folders } : {}),
  } satisfies ListDocumentsResponse)
})

// GET /api/projects/:projectId/documents/:id
documentsRouter.get('/:id', async (c) => {
  const userId = c.get('userId')
  const projectId = c.req.param('projectId')
  const docId = c.req.param('id')

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
      path: info.path,
      created_by: info.created_by,
      created_at: info.created_at,
      updated_at: info.updated_at,
      content: result.content,
    },
  } satisfies GetDocumentResponse)
})

// PATCH /api/projects/:projectId/documents/:id
documentsRouter.patch('/:id', async (c) => {
  const userId = c.get('userId')
  const projectId = c.req.param('projectId')
  const docId = c.req.param('id')
  const body = await c.req.json<UpdateDocumentRequest>()

  const existing = await docManager.getDocInfo(userId, projectId, docId)
  if (!existing) return c.json({ error: 'Document not found' }, 404)

  if (body.content !== undefined) {
    await docManager.replaceDocContent(userId, projectId, docId, body.content)
  }
  if (body.name !== undefined) {
    await docManager.renameDoc(userId, projectId, docId, body.name)
  }
  if (body.path !== undefined) {
    await docManager.moveDoc(userId, projectId, docId, body.path)
  }

  const updated = await docManager.getDocInfo(userId, projectId, docId)
  if (!updated) return c.json({ error: 'Document not found' }, 404)

  return c.json({
    document: {
      id: updated.id,
      project_id: updated.project_id,
      workspace_id: updated.workspace_id,
      name: updated.name,
      path: updated.path,
      created_by: updated.created_by,
      created_at: updated.created_at,
      updated_at: updated.updated_at,
    },
  } satisfies UpdateDocumentResponse)
})

// DELETE /api/projects/:projectId/documents/:id
documentsRouter.delete('/:id', async (c) => {
  const userId = c.get('userId')
  const projectId = c.req.param('projectId')
  const docId = c.req.param('id')

  const deleted = await docManager.deleteDoc(userId, projectId, docId)
  if (!deleted) return c.json({ error: 'Document not found' }, 404)

  return c.json({ success: true })
})
```

#### 2. Mount documents under projects
**File**: `packages/server/index.ts`

```typescript
// Nest documents and sessions under projects
projectsRouter.route('/:projectId/documents', documentsRouter)
projectsRouter.route('/:projectId/sessions', sessionsRouter)
projectsRouter.route('/:projectId/sessions', messagesRouter)

// Remove old top-level routes
// api.route('/sessions', sessionsRouter)  -- REMOVE
// api.route('/documents', documentsRouter)  -- REMOVE
```

### Success Criteria:

#### Automated Verification:
- [ ] TypeScript compilation passes
- [ ] Server starts without errors

#### Manual Verification:
- [ ] `POST /api/projects/:projectId/documents` creates document
- [ ] `GET /api/projects/:projectId/documents` lists documents
- [ ] `GET /api/projects/:projectId/documents?path=/` lists root items + folders
- [ ] Move document via PATCH with `path` field

**Implementation Note**: After completing this phase, pause for manual confirmation before proceeding.

---

## Phase 6: Session Routes (Project-Scoped)

### Overview
Update sessions to be project-scoped.

### Changes Required:

#### 1. Update sessions router
**File**: `packages/server/routes/sessions.ts`

Change to use `projectId` from URL param:

```typescript
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

  const title = body.title ?? 'New Session'
  const model = body.model ?? DEFAULT_MODEL
  const provider = body.provider ?? DEFAULT_PROVIDER
  const systemPrompt = body.system_prompt ?? null

  const rows = await withRLS(userId, (sql) =>
    sql`INSERT INTO agent_sessions (project_id, workspace_id, title, model, provider, system_prompt, created_by)
        VALUES (${projectId}, ${workspaceId}, ${title}, ${model}, ${provider}, ${systemPrompt}, ${userId})
        RETURNING *`
  )
  const session = rows[0]

  return c.json({ session } satisfies CreateSessionResponse, 201)
})

// GET /api/projects/:projectId/sessions
sessionsRouter.get('/', async (c) => {
  const userId = c.get('userId')
  const projectId = c.req.param('projectId')
  const cursor = c.req.query('cursor')
  const limit = Math.min(Number(c.req.query('limit') ?? 50), 100)

  const sessions = await withRLS(userId, (sql) =>
    cursor
      ? sql`SELECT * FROM agent_sessions
            WHERE project_id = ${projectId}
              AND archived = false
              AND created_at < ${cursor}
            ORDER BY created_at DESC
            LIMIT ${limit + 1}`
      : sql`SELECT * FROM agent_sessions
            WHERE project_id = ${projectId}
              AND archived = false
            ORDER BY created_at DESC
            LIMIT ${limit + 1}`
  )

  const hasMore = sessions.length > limit
  const page = hasMore ? sessions.slice(0, limit) : sessions
  const nextCursor = hasMore
    ? (page[page.length - 1] as Record<string, unknown>)?.created_at as string
    : null

  return c.json({
    data: page,
    cursor: nextCursor,
  } satisfies ListSessionsResponse)
})

// GET/PATCH for :id routes also need projectId in WHERE clause
```

#### 2. Update messages router
**File**: `packages/server/routes/messages.ts`

The messages router uses `sessionId` which can remain the same since session IDs are globally unique. However, for consistency and security, we should verify the session belongs to the project.

### Success Criteria:

#### Automated Verification:
- [ ] TypeScript compilation passes
- [ ] Server starts without errors

#### Manual Verification:
- [ ] `POST /api/projects/:projectId/sessions` creates session
- [ ] `GET /api/projects/:projectId/sessions` lists sessions
- [ ] Messages work within project-scoped sessions

**Implementation Note**: After completing this phase, pause for manual confirmation before proceeding.

---

## Phase 7: Agent Tools Update

### Overview
Update document tools to be project-aware with folder support.

### Changes Required:

#### 1. Update createDocumentTools signature
**File**: `packages/server/tools/document-tools.ts`

```typescript
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
      description: 'Read a document as markdown.',
      inputSchema: z.object({
        id: z.string().describe('Document ID'),
      }),
      execute: async ({ id }) => {
        const result = await docManager.readDocAsText(userId, projectId, id)
        if (!result) return { error: 'Document not found' }
        return { id, name: result.name, content: result.content }
      },
    }),

    doc_list: tool({
      description: 'List documents. Optionally filter by folder path.',
      inputSchema: z.object({
        path: z.string().optional().describe('Folder path to list, e.g., "/Design/". Omit for all documents.'),
      }),
      execute: async ({ path }) => {
        const result = await docManager.listDocs(userId, projectId, path)
        return { documents: result.documents, folders: result.folders }
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

    // ... doc_edit, doc_append, doc_delete updated similarly
  }
}
```

#### 2. Update tool creation in messages route
**File**: `packages/server/routes/messages.ts`

Pass `projectId` instead of `workspaceId`:

```typescript
const projectId = c.req.param('projectId')
const tools = createDocumentTools(projectId, userId)
```

### Success Criteria:

#### Automated Verification:
- [ ] TypeScript compilation passes
- [ ] All tests pass

#### Manual Verification:
- [ ] Agent can create documents at paths
- [ ] Agent can list folders
- [ ] Agent can move documents

**Implementation Note**: After completing this phase, pause for manual confirmation before proceeding.

---

## Phase 8: Client SDK Updates

### Overview
Update client SDK to support project-scoped operations.

### Changes Required:

#### 1. Update client methods
**File**: `packages/client/src/index.ts`

All document/session methods need `projectId` parameter and updated URLs:

```typescript
async createDocument(
  projectId: string,
  name: string,
  content?: string,
  path?: string,
): Promise<{ id: string; name: string; path: string }> {
  const url = `${this.baseUrl}/api/projects/${projectId}/documents`
  const response = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name, content, path }),
  })
  if (!response.ok) {
    throw new Error(`Failed to create document: ${await response.text()}`)
  }
  const data = await response.json() as { document: { id: string; name: string; path: string } }
  return data.document
}

async listDocuments(
  projectId: string,
  path?: string,
): Promise<{ documents: DocumentInfo[]; folders?: Array<{ name: string; path: string }> }> {
  let url = `${this.baseUrl}/api/projects/${projectId}/documents`
  if (path) url += `?path=${encodeURIComponent(path)}`
  const response = await fetch(url)
  if (!response.ok) {
    throw new Error(`Failed to list documents: ${await response.text()}`)
  }
  return response.json()
}

// Similarly update other document/session methods
```

### Success Criteria:

#### Automated Verification:
- [ ] TypeScript compilation passes

#### Manual Verification:
- [ ] Client SDK can create/list documents with project and path

---

## Testing Strategy

### Unit Tests:
- `normalizePath()` edge cases
- Document manager functions with project scoping
- Path-based listing logic

### Integration Tests:
- Create project, create documents at paths, list folders
- Sessions within projects
- RLS enforcement for project access

### Manual Testing Steps:
1. Create project: `POST /api/projects {"name": "My Project"}`
2. Create doc at root: `POST /api/projects/:id/documents {"name": "readme"}`
3. Create doc in folder: `POST /api/projects/:id/documents {"name": "spec", "path": "/Design/"}`
4. List root: `GET /api/projects/:id/documents?path=/` → see readme + Design folder
5. List folder: `GET /api/projects/:id/documents?path=/Design/` → see spec
6. Create session: `POST /api/projects/:id/sessions`
7. Send message: `POST /api/projects/:id/sessions/:sid/messages`

## Performance Considerations

- Composite index `(project_id, path)` covers folder listing queries
- RLS joins to workspace_memberships are indexed
- No performance impact on existing patterns

## Migration Notes

- This is a **breaking change** - existing documents and sessions are deleted
- All API endpoints change from workspace-scoped to project-scoped
- Client code must be updated to use new endpoints

## References

- Projects table: `supabase/migrations/20260128204618_remote_schema.sql:1035-1046`
- Current document manager: `packages/server/document-manager.ts`
- Current document routes: `packages/server/routes/documents.ts`
- Current session routes: `packages/server/routes/sessions.ts`
- Shared types: `packages/shared/types.ts`, `packages/shared/api.ts`
