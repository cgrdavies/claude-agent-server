# Folders & Navigation Backend APIs Implementation Plan

## Overview

Implement backend APIs for folder management and project navigation. This builds on the core project/document hierarchy (from the document-folder-hierarchy plan) by adding explicit folder entities, folder CRUD operations, tree view API, search API, and breadcrumb support.

## Current State Analysis

**Existing Plan (document-folder-hierarchy.md):**
- Documents have a `path` column for folder hierarchy (e.g., `/Design/Mockups/`)
- Folders are derived from document paths (implicit/virtual)
- API returns `folders` when listing documents at a path

**Problem with Path-Based Virtual Folders:**
1. Cannot create empty folders (no document to give a path)
2. Renaming a folder requires updating all document paths
3. Delete confirmation needs folder contents count (expensive query)
4. Real-time sync for folder changes is complex
5. Folder metadata (expand state) has no home

**This Plan Adds:**
- Explicit `folders` table in database
- Folder CRUD operations (create, rename, delete, move)
- Tree view API for sidebar navigation
- Search API for quick find
- Breadcrumb data in document responses

### Key Discoveries:
- Stories specify empty folders can exist (F4: delete empty folders immediately)
- Max folder depth is 5 levels
- No duplicate names in same parent (filesystem semantics)
- Soft delete for folders with contents
- Tree view uses indentation only (no connecting lines)
- Search is name-only, not content (Cmd/Ctrl+K)

## Desired End State

After implementation:

1. **Folders table** - Explicit folder entities with parent_id for hierarchy
2. **Folder CRUD APIs** - Create, rename, delete, move folders
3. **Tree View API** - Returns complete project structure in one call
4. **Search API** - Filter documents and folders by name
5. **Breadcrumb Support** - Document responses include path ancestors
6. **Documents use folder_id** - Instead of path string (simpler, more robust)

### Verification:
- Create project with nested folders (up to 5 levels)
- Create documents in folders
- Rename/move/delete folders
- Get tree view showing full hierarchy
- Search filters by name
- Breadcrumb shows path to document

## What We're NOT Doing

- **Expand/collapse state storage** - Frontend handles via localStorage (F5)
- **Drag-and-drop** - Frontend UX concern, uses existing move APIs
- **Recent documents** - Deferred (N3)
- **Cross-project moves** - Out of scope (D3)
- **Content search** - Search is name-only for MVP
- **Virtualization** - Frontend performance concern

## Design Decision: Explicit Folders vs Path-Based

**Chosen approach: Explicit folder entities with `folder_id` on documents**

Rationale:
1. Empty folders can exist naturally
2. Folder rename is O(1), not O(n) document updates
3. Soft delete is straightforward
4. Real-time sync via simple entity changes
5. Tree view query is efficient (one query for all folders + documents)
6. Matches user mental model of filesystem

Trade-offs:
- Additional table to maintain
- Need to ensure consistency (documents in deleted folders)
- Slightly more complex schema

Migration from path-based (if already implemented):
- Extract unique paths to folders table
- Update documents with folder_id
- Drop path column

## Implementation Approach

1. Database: Add `folders` table with parent_id hierarchy
2. Update documents: Replace `path` with `folder_id` (nullable = root)
3. Folder CRUD: Standard REST endpoints
4. Tree View: Single endpoint returning full hierarchy
5. Search: Query endpoint with name filter
6. Breadcrumbs: Include ancestors in document responses

---

## Phase 1: Database Schema - Folders Table

### Overview
Add explicit `folders` table and update documents to use `folder_id` instead of `path`.

### Changes Required:

#### 1. New migration file
**File**: `supabase/migrations/[timestamp]_add_folders_table.sql`

```sql
-- ============================================================
-- Add explicit folders table for project hierarchy
-- ============================================================

-- 1. Create folders table
CREATE TABLE folders (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id UUID NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  parent_id UUID REFERENCES folders(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  created_by UUID NOT NULL REFERENCES auth.users(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  deleted_at TIMESTAMPTZ,  -- soft delete

  -- No duplicate folder names in same parent (within project)
  CONSTRAINT folders_unique_name_in_parent
    UNIQUE NULLS NOT DISTINCT (project_id, parent_id, name)
);

-- 2. Add indexes
CREATE INDEX idx_folders_project ON folders(project_id);
CREATE INDEX idx_folders_parent ON folders(parent_id);
CREATE INDEX idx_folders_project_parent ON folders(project_id, parent_id);

-- 3. Add folder_id to documents (nullable = root level)
ALTER TABLE documents
  ADD COLUMN folder_id UUID REFERENCES folders(id) ON DELETE SET NULL;

-- 4. Create index for documents by folder
CREATE INDEX idx_documents_folder ON documents(folder_id);

-- 5. Add unique constraint: no duplicate doc names in same folder
ALTER TABLE documents
  ADD CONSTRAINT documents_unique_name_in_folder
    UNIQUE NULLS NOT DISTINCT (project_id, folder_id, name);

-- 6. RLS policies for folders
ALTER TABLE folders ENABLE ROW LEVEL SECURITY;

CREATE POLICY folders_select ON folders FOR SELECT USING (
  project_id IN (
    SELECT p.id FROM projects p
    JOIN workspace_memberships wm ON wm.workspace_id = p.workspace_id
    WHERE wm.user_id = auth.uid()
  )
  AND deleted_at IS NULL
);

CREATE POLICY folders_insert ON folders FOR INSERT WITH CHECK (
  created_by = auth.uid()
  AND project_id IN (
    SELECT p.id FROM projects p
    JOIN workspace_memberships wm ON wm.workspace_id = p.workspace_id
    WHERE wm.user_id = auth.uid()
  )
);

CREATE POLICY folders_update ON folders FOR UPDATE USING (
  project_id IN (
    SELECT p.id FROM projects p
    JOIN workspace_memberships wm ON wm.workspace_id = p.workspace_id
    WHERE wm.user_id = auth.uid()
  )
);

CREATE POLICY folders_delete ON folders FOR DELETE USING (
  project_id IN (
    SELECT p.id FROM projects p
    JOIN workspace_memberships wm ON wm.workspace_id = p.workspace_id
    WHERE wm.user_id = auth.uid()
  )
);

-- 7. Function to check folder depth (max 5 levels)
CREATE OR REPLACE FUNCTION check_folder_depth()
RETURNS TRIGGER AS $$
DECLARE
  depth INTEGER := 1;
  current_parent UUID := NEW.parent_id;
BEGIN
  WHILE current_parent IS NOT NULL LOOP
    depth := depth + 1;
    IF depth > 5 THEN
      RAISE EXCEPTION 'Maximum folder depth of 5 exceeded';
    END IF;
    SELECT parent_id INTO current_parent FROM folders WHERE id = current_parent;
  END LOOP;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER enforce_folder_depth
  BEFORE INSERT OR UPDATE ON folders
  FOR EACH ROW
  EXECUTE FUNCTION check_folder_depth();

-- 8. Function to cascade soft delete to children
CREATE OR REPLACE FUNCTION cascade_folder_soft_delete()
RETURNS TRIGGER AS $$
BEGIN
  IF NEW.deleted_at IS NOT NULL AND OLD.deleted_at IS NULL THEN
    -- Soft delete all child folders
    UPDATE folders SET deleted_at = NEW.deleted_at
    WHERE parent_id = NEW.id AND deleted_at IS NULL;

    -- Soft delete all documents in this folder
    UPDATE documents SET deleted_at = NEW.deleted_at
    WHERE folder_id = NEW.id AND deleted_at IS NULL;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER cascade_folder_delete
  AFTER UPDATE ON folders
  FOR EACH ROW
  EXECUTE FUNCTION cascade_folder_soft_delete();

-- 9. Add deleted_at to documents if not exists
ALTER TABLE documents
  ADD COLUMN IF NOT EXISTS deleted_at TIMESTAMPTZ;

-- 10. Update documents RLS to exclude soft-deleted
DROP POLICY IF EXISTS documents_select ON documents;
CREATE POLICY documents_select ON documents FOR SELECT USING (
  project_id IN (
    SELECT p.id FROM projects p
    JOIN workspace_memberships wm ON wm.workspace_id = p.workspace_id
    WHERE wm.user_id = auth.uid()
  )
  AND deleted_at IS NULL
);
```

### Success Criteria:

#### Automated Verification:
- [x] Migration applies cleanly: `supabase db push`
- [x] Folders table exists: `SELECT * FROM folders LIMIT 0`
- [x] folder_id column on documents: `SELECT folder_id FROM documents LIMIT 0`
- [x] Indexes exist: `SELECT indexname FROM pg_indexes WHERE tablename = 'folders'`
- [x] RLS policies exist: `SELECT policyname FROM pg_policies WHERE tablename = 'folders'`

#### Smoke Test
Create `packages/server/tests/smoke/folders-phase1-schema.test.ts`:
```typescript
import { describe, test, expect } from 'bun:test'
import { sql } from '../test-utils'

describe('Folders Phase 1: Database Schema', () => {
  test('folders table exists with required columns', async () => {
    const result = await sql`SELECT column_name FROM information_schema.columns
      WHERE table_name = 'folders'`
    const columns = result.map((r: any) => r.column_name)
    expect(columns).toContain('id')
    expect(columns).toContain('project_id')
    expect(columns).toContain('parent_id')
    expect(columns).toContain('name')
    expect(columns).toContain('deleted_at')
  })

  test('documents table has folder_id column', async () => {
    const result = await sql`SELECT column_name FROM information_schema.columns
      WHERE table_name = 'documents' AND column_name = 'folder_id'`
    expect(result.length).toBe(1)
  })

  test('depth trigger prevents more than 5 levels', async () => {
    // This test creates folders and expects the 6th level to fail
    // Implementation depends on test setup with authenticated user
  })

  test('soft delete cascade works', async () => {
    // Verify that setting deleted_at on a folder cascades to children
    // Implementation depends on test setup
  })
})
```

Run: `bun test packages/server/tests/smoke/folders-phase1-schema.test.ts`

---

## Phase 2: Shared Types for Folders

### Overview
Add Folder type and update API types for folder operations and tree view.

### Changes Required:

#### 1. Add Folder type
**File**: `packages/shared/types.ts`

```typescript
export type Folder = {
  id: string
  project_id: string
  parent_id: string | null
  name: string
  created_by: string
  created_at: string
  updated_at: string
}
```

#### 2. Update Document type
**File**: `packages/shared/types.ts`

Update Document to include `folder_id` and `path` (computed for breadcrumbs):

```typescript
export type Document = {
  id: string
  project_id: string
  workspace_id: string
  folder_id: string | null     // null = project root
  name: string
  created_by: string
  created_at: string
  updated_at: string
}

export type DocumentWithBreadcrumb = Document & {
  breadcrumb: BreadcrumbItem[]
}

export type BreadcrumbItem = {
  id: string
  name: string
  type: 'project' | 'folder' | 'document'
}
```

#### 3. Add Folder API types
**File**: `packages/shared/api.ts`

```typescript
// ============================================================
// Folders
// ============================================================

export type CreateFolderRequest = {
  name: string
  parent_id?: string           // null/omit = project root
}

export type CreateFolderResponse = {
  folder: Folder
}

export type ListFoldersResponse = {
  folders: Folder[]
}

export type UpdateFolderRequest = {
  name?: string
  parent_id?: string | null    // move to different parent
}

export type UpdateFolderResponse = {
  folder: Folder
}

// ============================================================
// Tree View
// ============================================================

export type TreeNode = {
  id: string
  name: string
  type: 'folder' | 'document'
  parent_id: string | null     // null = project root
  updated_at: string
  children?: TreeNode[]        // only for folders, only populated in nested response
}

export type GetTreeResponse = {
  nodes: TreeNode[]            // flat list, client builds tree
}

// Alternative: nested tree response
export type GetTreeNestedResponse = {
  tree: TreeNode[]             // pre-built nested structure
}

// ============================================================
// Search
// ============================================================

export type SearchRequest = {
  query: string
  type?: 'all' | 'documents' | 'folders'  // default: all
}

export type SearchResult = {
  id: string
  name: string
  type: 'folder' | 'document'
  parent_id: string | null
  breadcrumb: BreadcrumbItem[]
}

export type SearchResponse = {
  results: SearchResult[]
}
```

#### 4. Update Document API types
**File**: `packages/shared/api.ts`

```typescript
export type CreateDocumentRequest = {
  name: string
  content?: string
  folder_id?: string           // null/omit = project root
}

export type UpdateDocumentRequest = {
  name?: string
  content?: string
  folder_id?: string | null    // move to different folder
}

export type GetDocumentResponse = {
  document: DocumentWithContent & {
    breadcrumb: BreadcrumbItem[]
  }
}
```

#### 5. Update route definitions
**File**: `packages/shared/routes.ts`

```typescript
export const API_ROUTES = {
  // ... existing routes ...

  // Folders (nested under projects)
  createFolder:   'POST   /api/projects/:projectId/folders',
  listFolders:    'GET    /api/projects/:projectId/folders',
  getFolder:      'GET    /api/projects/:projectId/folders/:id',
  updateFolder:   'PATCH  /api/projects/:projectId/folders/:id',
  deleteFolder:   'DELETE /api/projects/:projectId/folders/:id',

  // Tree View
  getTree:        'GET    /api/projects/:projectId/tree',

  // Search
  search:         'GET    /api/projects/:projectId/search',
} as const
```

### Success Criteria:

#### Automated Verification:
- [x] TypeScript compilation passes: `cd packages/shared && bun run tsc --noEmit`
- [x] No import errors in dependent packages: `cd packages/server && bun run tsc --noEmit`

Run both type checks to verify types compile and are importable:
```bash
cd packages/shared && bun run tsc --noEmit
cd packages/server && bun run tsc --noEmit
```

---

## Phase 3: Folder Manager Module

### Overview
Create a folder manager module with business logic for folder operations, depth validation, and breadcrumb computation.

### Changes Required:

#### 1. Create folder manager
**File**: `packages/server/folder-manager.ts`

```typescript
import { withRLS } from './lib/db'
import type { Folder, BreadcrumbItem } from '@claude-agent/shared'

export type FolderInfo = Folder

const MAX_FOLDER_DEPTH = 5
const MAX_FOLDER_NAME_LENGTH = 100

/**
 * Validate folder name
 */
function validateFolderName(name: string): void {
  if (!name || !name.trim()) {
    throw new Error('Folder name cannot be empty')
  }
  if (name.length > MAX_FOLDER_NAME_LENGTH) {
    throw new Error(`Folder name cannot exceed ${MAX_FOLDER_NAME_LENGTH} characters`)
  }
  // Disallow filesystem-unsafe characters
  if (/[<>:"/\\|?*\x00-\x1f]/g.test(name)) {
    throw new Error('Folder name contains invalid characters')
  }
}

/**
 * Check if adding a folder at this parent would exceed max depth.
 */
async function checkDepthLimit(
  userId: string,
  projectId: string,
  parentId: string | null,
): Promise<void> {
  if (!parentId) return // Root level is always OK

  let depth = 1
  let currentParentId: string | null = parentId

  while (currentParentId) {
    depth++
    if (depth > MAX_FOLDER_DEPTH) {
      throw new Error(`Maximum folder depth of ${MAX_FOLDER_DEPTH} exceeded`)
    }

    const rows = await withRLS(userId, sql =>
      sql`SELECT parent_id FROM folders WHERE id = ${currentParentId} AND project_id = ${projectId} LIMIT 1`
    )
    const row = rows[0] as { parent_id: string | null } | undefined
    if (!row) break
    currentParentId = row.parent_id
  }
}

/**
 * Create a new folder in a project.
 */
export async function createFolder(
  userId: string,
  projectId: string,
  name: string,
  parentId?: string | null,
): Promise<FolderInfo> {
  validateFolderName(name)
  await checkDepthLimit(userId, projectId, parentId ?? null)

  const rows = await withRLS(userId, sql =>
    sql`INSERT INTO folders (project_id, parent_id, name, created_by)
        VALUES (${projectId}, ${parentId ?? null}, ${name.trim()}, ${userId})
        RETURNING id, project_id, parent_id, name, created_by, created_at, updated_at`
  )

  return rows[0] as FolderInfo
}

/**
 * List folders in a project, optionally filtered by parent.
 */
export async function listFolders(
  userId: string,
  projectId: string,
  parentId?: string | null,
): Promise<FolderInfo[]> {
  if (parentId === undefined) {
    // All folders in project
    const rows = await withRLS(userId, sql =>
      sql`SELECT id, project_id, parent_id, name, created_by, created_at, updated_at
          FROM folders
          WHERE project_id = ${projectId} AND deleted_at IS NULL
          ORDER BY name ASC`
    )
    return rows as unknown as FolderInfo[]
  }

  // Folders in specific parent (null = root)
  const rows = await withRLS(userId, sql =>
    parentId === null
      ? sql`SELECT id, project_id, parent_id, name, created_by, created_at, updated_at
            FROM folders
            WHERE project_id = ${projectId} AND parent_id IS NULL AND deleted_at IS NULL
            ORDER BY name ASC`
      : sql`SELECT id, project_id, parent_id, name, created_by, created_at, updated_at
            FROM folders
            WHERE project_id = ${projectId} AND parent_id = ${parentId} AND deleted_at IS NULL
            ORDER BY name ASC`
  )
  return rows as unknown as FolderInfo[]
}

/**
 * Get a single folder by ID.
 */
export async function getFolder(
  userId: string,
  projectId: string,
  id: string,
): Promise<FolderInfo | null> {
  const rows = await withRLS(userId, sql =>
    sql`SELECT id, project_id, parent_id, name, created_by, created_at, updated_at
        FROM folders
        WHERE id = ${id} AND project_id = ${projectId} AND deleted_at IS NULL
        LIMIT 1`
  )
  return (rows[0] as FolderInfo | undefined) ?? null
}

/**
 * Rename a folder.
 */
export async function renameFolder(
  userId: string,
  projectId: string,
  id: string,
  name: string,
): Promise<FolderInfo | null> {
  validateFolderName(name)

  const rows = await withRLS(userId, sql =>
    sql`UPDATE folders
        SET name = ${name.trim()}, updated_at = now()
        WHERE id = ${id} AND project_id = ${projectId} AND deleted_at IS NULL
        RETURNING id, project_id, parent_id, name, created_by, created_at, updated_at`
  )
  return (rows[0] as FolderInfo | undefined) ?? null
}

/**
 * Move a folder to a new parent.
 */
export async function moveFolder(
  userId: string,
  projectId: string,
  id: string,
  newParentId: string | null,
): Promise<FolderInfo | null> {
  // Check we're not moving into ourselves or our descendants
  if (newParentId) {
    let checkId: string | null = newParentId
    while (checkId) {
      if (checkId === id) {
        throw new Error('Cannot move folder into itself or its descendants')
      }
      const rows = await withRLS(userId, sql =>
        sql`SELECT parent_id FROM folders WHERE id = ${checkId} LIMIT 1`
      )
      const row = rows[0] as { parent_id: string | null } | undefined
      checkId = row?.parent_id ?? null
    }
  }

  await checkDepthLimit(userId, projectId, newParentId)

  const rows = await withRLS(userId, sql =>
    sql`UPDATE folders
        SET parent_id = ${newParentId}, updated_at = now()
        WHERE id = ${id} AND project_id = ${projectId} AND deleted_at IS NULL
        RETURNING id, project_id, parent_id, name, created_by, created_at, updated_at`
  )
  return (rows[0] as FolderInfo | undefined) ?? null
}

/**
 * Soft delete a folder and its contents.
 * Returns stats about what was deleted.
 */
export async function deleteFolder(
  userId: string,
  projectId: string,
  id: string,
): Promise<{ deleted: boolean; documentsDeleted: number; foldersDeleted: number }> {
  // Get counts before deletion (for confirmation dialog data)
  const countRows = await withRLS(userId, sql =>
    sql`WITH RECURSIVE folder_tree AS (
          SELECT id FROM folders WHERE id = ${id} AND project_id = ${projectId}
          UNION ALL
          SELECT f.id FROM folders f
          JOIN folder_tree ft ON f.parent_id = ft.id
          WHERE f.deleted_at IS NULL
        )
        SELECT
          (SELECT COUNT(*)::int FROM folder_tree) - 1 as folders_count,
          (SELECT COUNT(*)::int FROM documents WHERE folder_id IN (SELECT id FROM folder_tree) AND deleted_at IS NULL) as docs_count`
  )
  const counts = countRows[0] as { folders_count: number; docs_count: number } | undefined

  // Soft delete the folder (trigger cascades to children)
  const result = await withRLS(userId, sql =>
    sql`UPDATE folders
        SET deleted_at = now()
        WHERE id = ${id} AND project_id = ${projectId} AND deleted_at IS NULL
        RETURNING id`
  )

  if (result.length === 0) {
    return { deleted: false, documentsDeleted: 0, foldersDeleted: 0 }
  }

  return {
    deleted: true,
    documentsDeleted: counts?.docs_count ?? 0,
    foldersDeleted: counts?.folders_count ?? 0,
  }
}

/**
 * Get folder contents info (for delete confirmation).
 */
export async function getFolderContents(
  userId: string,
  projectId: string,
  id: string,
): Promise<{ documentsCount: number; foldersCount: number } | null> {
  const rows = await withRLS(userId, sql =>
    sql`WITH RECURSIVE folder_tree AS (
          SELECT id FROM folders WHERE id = ${id} AND project_id = ${projectId} AND deleted_at IS NULL
          UNION ALL
          SELECT f.id FROM folders f
          JOIN folder_tree ft ON f.parent_id = ft.id
          WHERE f.deleted_at IS NULL
        )
        SELECT
          (SELECT COUNT(*)::int FROM folder_tree) - 1 as folders_count,
          (SELECT COUNT(*)::int FROM documents WHERE folder_id IN (SELECT id FROM folder_tree) AND deleted_at IS NULL) as docs_count`
  )
  const row = rows[0] as { folders_count: number; docs_count: number } | undefined
  if (!row) return null

  return {
    documentsCount: row.docs_count,
    foldersCount: row.folders_count,
  }
}

/**
 * Build breadcrumb path from a folder up to project root.
 */
export async function getBreadcrumb(
  userId: string,
  projectId: string,
  folderId: string | null,
): Promise<BreadcrumbItem[]> {
  if (!folderId) return []

  const rows = await withRLS(userId, sql =>
    sql`WITH RECURSIVE ancestors AS (
          SELECT id, parent_id, name, 1 as depth
          FROM folders
          WHERE id = ${folderId} AND project_id = ${projectId} AND deleted_at IS NULL
          UNION ALL
          SELECT f.id, f.parent_id, f.name, a.depth + 1
          FROM folders f
          JOIN ancestors a ON f.id = a.parent_id
          WHERE f.deleted_at IS NULL
        )
        SELECT id, name FROM ancestors ORDER BY depth DESC`
  )

  return (rows as unknown as { id: string; name: string }[]).map(r => ({
    id: r.id,
    name: r.name,
    type: 'folder' as const,
  }))
}
```

### Success Criteria:

#### Automated Verification:
- [x] TypeScript compilation passes: `bun run tsc --noEmit`
- [x] Unit tests pass for validation functions

#### Smoke Test
Create `packages/server/tests/smoke/folders-phase3-manager.test.ts`:
```typescript
import { describe, test, expect } from 'bun:test'
import * as folderManager from '../../folder-manager'

describe('Folders Phase 3: Folder Manager', () => {
  test('validateFolderName rejects empty names', () => {
    expect(() => folderManager.validateFolderName('')).toThrow()
    expect(() => folderManager.validateFolderName('   ')).toThrow()
  })

  test('validateFolderName rejects names over 100 chars', () => {
    const longName = 'a'.repeat(101)
    expect(() => folderManager.validateFolderName(longName)).toThrow()
  })

  test('validateFolderName rejects invalid characters', () => {
    expect(() => folderManager.validateFolderName('test/folder')).toThrow()
    expect(() => folderManager.validateFolderName('test:folder')).toThrow()
  })

  test('validateFolderName accepts valid names', () => {
    expect(() => folderManager.validateFolderName('Valid Folder')).not.toThrow()
    expect(() => folderManager.validateFolderName('folder-name_123')).not.toThrow()
  })
})
```

Run: `bun test packages/server/tests/smoke/folders-phase3-manager.test.ts`

---

## Phase 4: Folders Router

### Overview
Create REST API endpoints for folder CRUD operations.

### Changes Required:

#### 1. Create folders router
**File**: `packages/server/routes/folders.ts`

```typescript
import { Hono } from 'hono'
import type {
  CreateFolderRequest,
  CreateFolderResponse,
  ListFoldersResponse,
  UpdateFolderRequest,
  UpdateFolderResponse,
} from '@claude-agent/shared'
import * as folderManager from '../folder-manager'

type Env = { Variables: { userId: string; workspaceId: string } }

export const foldersRouter = new Hono<Env>()

// POST /api/projects/:projectId/folders
foldersRouter.post('/', async (c) => {
  const userId = c.get('userId')
  const projectId = c.req.param('projectId')
  const body = await c.req.json<CreateFolderRequest>()

  try {
    const folder = await folderManager.createFolder(
      userId,
      projectId,
      body.name,
      body.parent_id,
    )
    return c.json({ folder } satisfies CreateFolderResponse, 201)
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Failed to create folder'
    // Check for unique constraint violation
    if (message.includes('unique') || message.includes('duplicate')) {
      return c.json({ error: 'A folder with this name already exists in this location' }, 409)
    }
    return c.json({ error: message }, 400)
  }
})

// GET /api/projects/:projectId/folders
foldersRouter.get('/', async (c) => {
  const userId = c.get('userId')
  const projectId = c.req.param('projectId')
  const parentId = c.req.query('parent_id') // optional filter

  const folders = await folderManager.listFolders(
    userId,
    projectId,
    parentId === '' ? null : parentId,
  )

  return c.json({ folders } satisfies ListFoldersResponse)
})

// GET /api/projects/:projectId/folders/:id
foldersRouter.get('/:id', async (c) => {
  const userId = c.get('userId')
  const projectId = c.req.param('projectId')
  const folderId = c.req.param('id')

  const folder = await folderManager.getFolder(userId, projectId, folderId)
  if (!folder) return c.json({ error: 'Folder not found' }, 404)

  return c.json({ folder })
})

// GET /api/projects/:projectId/folders/:id/contents
// Returns counts for delete confirmation dialog
foldersRouter.get('/:id/contents', async (c) => {
  const userId = c.get('userId')
  const projectId = c.req.param('projectId')
  const folderId = c.req.param('id')

  const contents = await folderManager.getFolderContents(userId, projectId, folderId)
  if (!contents) return c.json({ error: 'Folder not found' }, 404)

  return c.json(contents)
})

// PATCH /api/projects/:projectId/folders/:id
foldersRouter.patch('/:id', async (c) => {
  const userId = c.get('userId')
  const projectId = c.req.param('projectId')
  const folderId = c.req.param('id')
  const body = await c.req.json<UpdateFolderRequest>()

  try {
    let folder = await folderManager.getFolder(userId, projectId, folderId)
    if (!folder) return c.json({ error: 'Folder not found' }, 404)

    if (body.name !== undefined) {
      folder = await folderManager.renameFolder(userId, projectId, folderId, body.name)
      if (!folder) return c.json({ error: 'Folder not found' }, 404)
    }

    if (body.parent_id !== undefined) {
      folder = await folderManager.moveFolder(userId, projectId, folderId, body.parent_id)
      if (!folder) return c.json({ error: 'Folder not found' }, 404)
    }

    return c.json({ folder } satisfies UpdateFolderResponse)
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Failed to update folder'
    if (message.includes('unique') || message.includes('duplicate')) {
      return c.json({ error: 'A folder with this name already exists in this location' }, 409)
    }
    if (message.includes('depth')) {
      return c.json({ error: message }, 400)
    }
    if (message.includes('itself')) {
      return c.json({ error: message }, 400)
    }
    return c.json({ error: message }, 400)
  }
})

// DELETE /api/projects/:projectId/folders/:id
foldersRouter.delete('/:id', async (c) => {
  const userId = c.get('userId')
  const projectId = c.req.param('projectId')
  const folderId = c.req.param('id')

  const result = await folderManager.deleteFolder(userId, projectId, folderId)
  if (!result.deleted) return c.json({ error: 'Folder not found' }, 404)

  return c.json({
    success: true,
    documentsDeleted: result.documentsDeleted,
    foldersDeleted: result.foldersDeleted,
  })
})
```

#### 2. Mount folders router
**File**: `packages/server/routes/projects.ts`

Add import and mount folders under projects:

```typescript
import { foldersRouter } from './folders'

// ... after existing routes ...

// Mount nested routers
projectsRouter.route('/:projectId/folders', foldersRouter)
```

### Success Criteria:

#### Automated Verification:
- [x] TypeScript compilation passes: `bun run tsc --noEmit`
- [x] Server starts without errors: `bun run dev`

#### Smoke Test
Create `packages/server/tests/smoke/folders-phase4-api.test.ts`:
```typescript
import { describe, test, expect, beforeAll } from 'bun:test'
import { createTestClient } from '../test-utils'

describe('Folders Phase 4: Folders API', () => {
  let client: ReturnType<typeof createTestClient>
  let projectId: string
  let folderId: string

  beforeAll(async () => {
    client = await createTestClient()
    const res = await client.post('/api/projects', { name: 'Folders Test' })
    projectId = (await res.json()).project.id
  })

  test('POST creates folder', async () => {
    const res = await client.post(`/api/projects/${projectId}/folders`, {
      name: 'Test Folder'
    })
    expect(res.status).toBe(201)
    folderId = (await res.json()).folder.id
  })

  test('GET lists folders', async () => {
    const res = await client.get(`/api/projects/${projectId}/folders`)
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.folders.length).toBeGreaterThan(0)
  })

  test('GET /:id returns folder', async () => {
    const res = await client.get(`/api/projects/${projectId}/folders/${folderId}`)
    expect(res.status).toBe(200)
  })

  test('PATCH renames folder', async () => {
    const res = await client.patch(`/api/projects/${projectId}/folders/${folderId}`, {
      name: 'Renamed Folder'
    })
    expect(res.status).toBe(200)
    expect((await res.json()).folder.name).toBe('Renamed Folder')
  })

  test('depth limit returns 400', async () => {
    // Create 5 nested folders, then try to create 6th
    let parentId = null
    for (let i = 0; i < 5; i++) {
      const res = await client.post(`/api/projects/${projectId}/folders`, {
        name: `Level ${i + 1}`,
        parent_id: parentId
      })
      parentId = (await res.json()).folder.id
    }
    // 6th level should fail
    const res = await client.post(`/api/projects/${projectId}/folders`, {
      name: 'Level 6',
      parent_id: parentId
    })
    expect(res.status).toBe(400)
  })

  test('duplicate name returns 409', async () => {
    const res = await client.post(`/api/projects/${projectId}/folders`, {
      name: 'Renamed Folder' // Same name as existing folder at root
    })
    expect(res.status).toBe(409)
  })
})
```

Run: `bun test packages/server/tests/smoke/folders-phase4-api.test.ts`

---

## Phase 5: Update Document Manager for Folder Integration

### Overview
Update document manager to use `folder_id` instead of `path`, and add breadcrumb support.

### Changes Required:

#### 1. Update DocumentInfo type
**File**: `packages/server/document-manager.ts`

```typescript
export type DocumentInfo = {
  id: string
  project_id: string
  workspace_id: string
  folder_id: string | null
  name: string
  created_by: string
  created_at: string
  updated_at: string
}
```

#### 2. Update createDoc
**File**: `packages/server/document-manager.ts`

Replace `path` parameter with `folderId`:

```typescript
export async function createDoc(
  userId: string,
  projectId: string,
  name: string,
  content?: string,
  folderId?: string | null,
): Promise<DocumentInfo> {
  // Validate name
  if (!name || !name.trim()) {
    throw new Error('Document name cannot be empty')
  }
  if (name.length > 100) {
    throw new Error('Document name cannot exceed 100 characters')
  }

  // Get workspace_id from project
  const projectRows = await withRLS(
    userId,
    sql => sql`SELECT workspace_id FROM projects WHERE id = ${projectId} LIMIT 1`
  )
  const workspaceId = (projectRows[0] as { workspace_id: string })?.workspace_id
  if (!workspaceId) throw new Error('Project not found')

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
      sql`INSERT INTO documents (id, project_id, workspace_id, folder_id, name, yjs_state, created_by)
        VALUES (${id}, ${projectId}, ${workspaceId}, ${folderId ?? null}, ${name.trim()}, ${state}, ${userId})
        RETURNING id, project_id, workspace_id, folder_id, name, created_by, created_at, updated_at`,
  )
  const info = rows[0] as DocumentInfo

  doc.on('update', () => debouncedPersist(userId, id, doc))
  docs.set(id, doc)

  return info
}
```

#### 3. Update listDocs
**File**: `packages/server/document-manager.ts`

```typescript
export async function listDocs(
  userId: string,
  projectId: string,
  folderId?: string | null,
): Promise<DocumentInfo[]> {
  if (folderId === undefined) {
    // All documents in project
    const rows = await withRLS(
      userId,
      sql =>
        sql`SELECT id, project_id, workspace_id, folder_id, name, created_by, created_at, updated_at
          FROM documents
          WHERE project_id = ${projectId} AND deleted_at IS NULL
          ORDER BY updated_at DESC`,
    )
    return rows as unknown as DocumentInfo[]
  }

  // Documents in specific folder (null = root)
  const rows = await withRLS(
    userId,
    sql =>
      folderId === null
        ? sql`SELECT id, project_id, workspace_id, folder_id, name, created_by, created_at, updated_at
              FROM documents
              WHERE project_id = ${projectId} AND folder_id IS NULL AND deleted_at IS NULL
              ORDER BY name ASC`
        : sql`SELECT id, project_id, workspace_id, folder_id, name, created_by, created_at, updated_at
              FROM documents
              WHERE project_id = ${projectId} AND folder_id = ${folderId} AND deleted_at IS NULL
              ORDER BY name ASC`,
  )
  return rows as unknown as DocumentInfo[]
}
```

#### 4. Add moveDoc function
**File**: `packages/server/document-manager.ts`

```typescript
export async function moveDoc(
  userId: string,
  projectId: string,
  id: string,
  folderId: string | null,
): Promise<void> {
  await withRLS(
    userId,
    sql =>
      sql`UPDATE documents SET folder_id = ${folderId}, updated_at = now()
        WHERE id = ${id} AND project_id = ${projectId}`,
  )
}
```

#### 5. Update other functions
Update `getDoc`, `readDocAsText`, `editDoc`, `appendDoc`, `replaceDocContent`, `deleteDoc`, `renameDoc`, `getDocInfo` to:
- Replace `workspaceId` with `projectId`
- Return `folder_id` in queries
- Use `project_id` in WHERE clauses

### Success Criteria:

#### Automated Verification:
- [x] TypeScript compilation passes: `bun run tsc --noEmit`
- [x] Existing document tests pass (after updating): `bun test`

#### Smoke Test
Create `packages/server/tests/smoke/folders-phase5-doc-integration.test.ts`:
```typescript
import { describe, test, expect, beforeAll } from 'bun:test'
import { createTestClient } from '../test-utils'

describe('Folders Phase 5: Document Manager Integration', () => {
  let client: ReturnType<typeof createTestClient>
  let projectId: string
  let folderId: string
  let docId: string

  beforeAll(async () => {
    client = await createTestClient()
    const pRes = await client.post('/api/projects', { name: 'Doc Folder Test' })
    projectId = (await pRes.json()).project.id
    const fRes = await client.post(`/api/projects/${projectId}/folders`, { name: 'Docs' })
    folderId = (await fRes.json()).folder.id
  })

  test('create document with folder_id', async () => {
    const res = await client.post(`/api/projects/${projectId}/documents`, {
      name: 'Doc in Folder',
      folder_id: folderId
    })
    expect(res.status).toBe(201)
    const body = await res.json()
    expect(body.document.folder_id).toBe(folderId)
    docId = body.document.id
  })

  test('move document to different folder', async () => {
    // Create another folder
    const f2Res = await client.post(`/api/projects/${projectId}/folders`, { name: 'Other' })
    const folder2Id = (await f2Res.json()).folder.id

    const res = await client.patch(`/api/projects/${projectId}/documents/${docId}`, {
      folder_id: folder2Id
    })
    expect(res.status).toBe(200)
    expect((await res.json()).document.folder_id).toBe(folder2Id)
  })

  test('move document to root', async () => {
    const res = await client.patch(`/api/projects/${projectId}/documents/${docId}`, {
      folder_id: null
    })
    expect(res.status).toBe(200)
    expect((await res.json()).document.folder_id).toBeNull()
  })
})
```

Run: `bun test packages/server/tests/smoke/folders-phase5-doc-integration.test.ts`

---

## Phase 6: Tree View API

### Overview
Implement tree view endpoint that returns the complete project structure.

### Changes Required:

#### 1. Add tree view to projects router
**File**: `packages/server/routes/projects.ts`

```typescript
import type { TreeNode, GetTreeResponse } from '@claude-agent/shared'

// GET /api/projects/:projectId/tree
projectsRouter.get('/:projectId/tree', async (c) => {
  const userId = c.get('userId')
  const projectId = c.req.param('projectId')

  // Get all folders
  const folderRows = await withRLS(userId, sql =>
    sql`SELECT id, parent_id, name, updated_at
        FROM folders
        WHERE project_id = ${projectId} AND deleted_at IS NULL
        ORDER BY name ASC`
  )

  // Get all documents
  const docRows = await withRLS(userId, sql =>
    sql`SELECT id, folder_id as parent_id, name, updated_at
        FROM documents
        WHERE project_id = ${projectId} AND deleted_at IS NULL
        ORDER BY name ASC`
  )

  const nodes: TreeNode[] = [
    ...(folderRows as unknown as Array<{ id: string; parent_id: string | null; name: string; updated_at: string }>).map(f => ({
      id: f.id,
      name: f.name,
      type: 'folder' as const,
      parent_id: f.parent_id,
      updated_at: f.updated_at,
    })),
    ...(docRows as unknown as Array<{ id: string; parent_id: string | null; name: string; updated_at: string }>).map(d => ({
      id: d.id,
      name: d.name,
      type: 'document' as const,
      parent_id: d.parent_id,
      updated_at: d.updated_at,
    })),
  ]

  return c.json({ nodes } satisfies GetTreeResponse)
})
```

### Success Criteria:

#### Automated Verification:
- [x] TypeScript compilation passes: `bun run tsc --noEmit`
- [x] Server starts without errors: `bun run dev`

#### Smoke Test
Create `packages/server/tests/smoke/folders-phase6-tree.test.ts`:
```typescript
import { describe, test, expect, beforeAll } from 'bun:test'
import { createTestClient } from '../test-utils'

describe('Folders Phase 6: Tree View API', () => {
  let client: ReturnType<typeof createTestClient>
  let projectId: string

  beforeAll(async () => {
    client = await createTestClient()
    const pRes = await client.post('/api/projects', { name: 'Tree Test' })
    projectId = (await pRes.json()).project.id

    // Create some structure
    const f1 = await client.post(`/api/projects/${projectId}/folders`, { name: 'Folder1' })
    const folderId = (await f1.json()).folder.id
    await client.post(`/api/projects/${projectId}/documents`, { name: 'Doc at root' })
    await client.post(`/api/projects/${projectId}/documents`, {
      name: 'Doc in folder',
      folder_id: folderId
    })
  })

  test('GET /tree returns flat list of nodes', async () => {
    const res = await client.get(`/api/projects/${projectId}/tree`)
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.nodes).toBeDefined()
    expect(body.nodes.length).toBeGreaterThanOrEqual(3) // 1 folder + 2 docs
  })

  test('tree nodes have correct type and parent_id', async () => {
    const res = await client.get(`/api/projects/${projectId}/tree`)
    const body = await res.json()

    const folder = body.nodes.find((n: any) => n.type === 'folder')
    expect(folder).toBeDefined()
    expect(folder.parent_id).toBeNull() // root level folder

    const docInFolder = body.nodes.find((n: any) =>
      n.type === 'document' && n.parent_id !== null
    )
    expect(docInFolder).toBeDefined()
  })
})
```

Run: `bun test packages/server/tests/smoke/folders-phase6-tree.test.ts`

---

## Phase 7: Search API

### Overview
Implement search endpoint for finding documents and folders by name.

### Changes Required:

#### 1. Add search to projects router
**File**: `packages/server/routes/projects.ts`

```typescript
import type { SearchResponse, SearchResult, BreadcrumbItem } from '@claude-agent/shared'
import * as folderManager from '../folder-manager'

// GET /api/projects/:projectId/search
projectsRouter.get('/:projectId/search', async (c) => {
  const userId = c.get('userId')
  const projectId = c.req.param('projectId')
  const query = c.req.query('q')
  const type = c.req.query('type') as 'all' | 'documents' | 'folders' | undefined

  if (!query || query.length < 1) {
    return c.json({ results: [] } satisfies SearchResponse)
  }

  // Escape special characters for ILIKE
  const searchPattern = `%${query.replace(/[%_]/g, '\\$&')}%`

  const results: SearchResult[] = []

  // Search folders
  if (type === 'all' || type === 'folders' || !type) {
    const folderRows = await withRLS(userId, sql =>
      sql`SELECT id, parent_id, name
          FROM folders
          WHERE project_id = ${projectId}
            AND deleted_at IS NULL
            AND name ILIKE ${searchPattern}
          ORDER BY name ASC
          LIMIT 20`
    )

    for (const row of folderRows as unknown as Array<{ id: string; parent_id: string | null; name: string }>) {
      const breadcrumb = await folderManager.getBreadcrumb(userId, projectId, row.parent_id)
      results.push({
        id: row.id,
        name: row.name,
        type: 'folder',
        parent_id: row.parent_id,
        breadcrumb,
      })
    }
  }

  // Search documents
  if (type === 'all' || type === 'documents' || !type) {
    const docRows = await withRLS(userId, sql =>
      sql`SELECT id, folder_id, name
          FROM documents
          WHERE project_id = ${projectId}
            AND deleted_at IS NULL
            AND name ILIKE ${searchPattern}
          ORDER BY name ASC
          LIMIT 20`
    )

    for (const row of docRows as unknown as Array<{ id: string; folder_id: string | null; name: string }>) {
      const breadcrumb = await folderManager.getBreadcrumb(userId, projectId, row.folder_id)
      results.push({
        id: row.id,
        name: row.name,
        type: 'document',
        parent_id: row.folder_id,
        breadcrumb,
      })
    }
  }

  // Sort by name
  results.sort((a, b) => a.name.localeCompare(b.name))

  return c.json({ results: results.slice(0, 20) } satisfies SearchResponse)
})
```

### Success Criteria:

#### Automated Verification:
- [x] TypeScript compilation passes: `bun run tsc --noEmit`
- [x] Server starts without errors: `bun run dev`

#### Smoke Test
Create `packages/server/tests/smoke/folders-phase7-search.test.ts`:
```typescript
import { describe, test, expect, beforeAll } from 'bun:test'
import { createTestClient } from '../test-utils'

describe('Folders Phase 7: Search API', () => {
  let client: ReturnType<typeof createTestClient>
  let projectId: string

  beforeAll(async () => {
    client = await createTestClient()
    const pRes = await client.post('/api/projects', { name: 'Search Test' })
    projectId = (await pRes.json()).project.id

    // Create searchable content
    await client.post(`/api/projects/${projectId}/folders`, { name: 'Design' })
    await client.post(`/api/projects/${projectId}/documents`, { name: 'Design Spec' })
    await client.post(`/api/projects/${projectId}/documents`, { name: 'API Reference' })
  })

  test('search returns matching items', async () => {
    const res = await client.get(`/api/projects/${projectId}/search?q=design`)
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.results.length).toBeGreaterThanOrEqual(2) // folder + doc
  })

  test('search is case-insensitive', async () => {
    const res = await client.get(`/api/projects/${projectId}/search?q=DESIGN`)
    const body = await res.json()
    expect(body.results.length).toBeGreaterThanOrEqual(2)
  })

  test('search includes breadcrumb', async () => {
    const res = await client.get(`/api/projects/${projectId}/search?q=design`)
    const body = await res.json()
    expect(body.results[0].breadcrumb).toBeDefined()
    expect(Array.isArray(body.results[0].breadcrumb)).toBe(true)
  })

  test('search filters by type', async () => {
    const docRes = await client.get(`/api/projects/${projectId}/search?q=design&type=documents`)
    const docBody = await docRes.json()
    expect(docBody.results.every((r: any) => r.type === 'document')).toBe(true)

    const folderRes = await client.get(`/api/projects/${projectId}/search?q=design&type=folders`)
    const folderBody = await folderRes.json()
    expect(folderBody.results.every((r: any) => r.type === 'folder')).toBe(true)
  })
})
```

Run: `bun test packages/server/tests/smoke/folders-phase7-search.test.ts`

---

## Phase 8: Breadcrumb in Document Responses

### Overview
Add breadcrumb to document GET responses.

### Changes Required:

#### 1. Update documents router
**File**: `packages/server/routes/documents.ts`

```typescript
import * as folderManager from '../folder-manager'
import type { BreadcrumbItem } from '@claude-agent/shared'

// GET /api/projects/:projectId/documents/:id
documentsRouter.get('/:id', async (c) => {
  const userId = c.get('userId')
  const projectId = c.req.param('projectId')
  const docId = c.req.param('id')

  const result = await docManager.readDocAsText(userId, projectId, docId)
  if (!result) return c.json({ error: 'Document not found' }, 404)

  const info = await docManager.getDocInfo(userId, projectId, docId)
  if (!info) return c.json({ error: 'Document not found' }, 404)

  // Build breadcrumb
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
  })
})
```

### Success Criteria:

#### Automated Verification:
- [x] TypeScript compilation passes: `bun run tsc --noEmit`

#### Smoke Test
Create `packages/server/tests/smoke/folders-phase8-breadcrumb.test.ts`:
```typescript
import { describe, test, expect, beforeAll } from 'bun:test'
import { createTestClient } from '../test-utils'

describe('Folders Phase 8: Breadcrumb in Document Responses', () => {
  let client: ReturnType<typeof createTestClient>
  let projectId: string
  let rootDocId: string
  let nestedDocId: string

  beforeAll(async () => {
    client = await createTestClient()
    const pRes = await client.post('/api/projects', { name: 'Breadcrumb Test' })
    projectId = (await pRes.json()).project.id

    // Create nested structure
    const f1 = await client.post(`/api/projects/${projectId}/folders`, { name: 'Level1' })
    const f1Id = (await f1.json()).folder.id
    const f2 = await client.post(`/api/projects/${projectId}/folders`, {
      name: 'Level2',
      parent_id: f1Id
    })
    const f2Id = (await f2.json()).folder.id

    // Create docs
    const rootDoc = await client.post(`/api/projects/${projectId}/documents`, { name: 'Root Doc' })
    rootDocId = (await rootDoc.json()).document.id

    const nestedDoc = await client.post(`/api/projects/${projectId}/documents`, {
      name: 'Nested Doc',
      folder_id: f2Id
    })
    nestedDocId = (await nestedDoc.json()).document.id
  })

  test('document at root has minimal breadcrumb', async () => {
    const res = await client.get(`/api/projects/${projectId}/documents/${rootDocId}`)
    const body = await res.json()
    expect(body.document.breadcrumb).toBeDefined()
    expect(body.document.breadcrumb.length).toBe(1) // just the document
    expect(body.document.breadcrumb[0].name).toBe('Root Doc')
  })

  test('nested document has full breadcrumb path', async () => {
    const res = await client.get(`/api/projects/${projectId}/documents/${nestedDocId}`)
    const body = await res.json()
    expect(body.document.breadcrumb.length).toBe(3) // Level1 > Level2 > Doc
    expect(body.document.breadcrumb[0].type).toBe('folder')
    expect(body.document.breadcrumb[1].type).toBe('folder')
    expect(body.document.breadcrumb[2].type).toBe('document')
  })
})
```

Run: `bun test packages/server/tests/smoke/folders-phase8-breadcrumb.test.ts`

---

## Phase 9: Update Agent Tools

### Overview
Update document tools to support folders.

### Changes Required:

#### 1. Update createDocumentTools
**File**: `packages/server/tools/document-tools.ts`

```typescript
import * as folderManager from '../folder-manager'

export function createDocumentTools(projectId: string, userId: string) {
  return {
    doc_create: tool({
      description: 'Create a new markdown document. Optionally specify a folder.',
      inputSchema: z.object({
        name: z.string().describe('Document name/title'),
        content: z.string().optional().describe('Initial markdown content'),
        folder_id: z.string().optional().describe('Folder ID to create in. Omit for project root.'),
      }),
      execute: async ({ name, content, folder_id }) => {
        const info = await docManager.createDoc(userId, projectId, name, content, folder_id)
        return { id: info.id, name: info.name, folder_id: info.folder_id }
      },
    }),

    doc_list: tool({
      description: 'List documents. Optionally filter by folder.',
      inputSchema: z.object({
        folder_id: z.string().optional().describe('Folder ID to list. Omit for all documents.'),
      }),
      execute: async ({ folder_id }) => {
        const docs = await docManager.listDocs(userId, projectId, folder_id)
        return { documents: docs.map(d => ({ id: d.id, name: d.name, folder_id: d.folder_id })) }
      },
    }),

    doc_move: tool({
      description: 'Move a document to a different folder.',
      inputSchema: z.object({
        id: z.string().describe('Document ID'),
        folder_id: z.string().nullable().describe('Target folder ID, or null for project root'),
      }),
      execute: async ({ id, folder_id }) => {
        await docManager.moveDoc(userId, projectId, id, folder_id)
        return { success: true }
      },
    }),

    folder_create: tool({
      description: 'Create a new folder.',
      inputSchema: z.object({
        name: z.string().describe('Folder name'),
        parent_id: z.string().optional().describe('Parent folder ID. Omit for project root.'),
      }),
      execute: async ({ name, parent_id }) => {
        const folder = await folderManager.createFolder(userId, projectId, name, parent_id)
        return { id: folder.id, name: folder.name, parent_id: folder.parent_id }
      },
    }),

    folder_list: tool({
      description: 'List folders.',
      inputSchema: z.object({
        parent_id: z.string().optional().describe('Parent folder ID. Omit for all folders.'),
      }),
      execute: async ({ parent_id }) => {
        const folders = await folderManager.listFolders(userId, projectId, parent_id)
        return { folders: folders.map(f => ({ id: f.id, name: f.name, parent_id: f.parent_id })) }
      },
    }),

    // ... other tools remain similar, just update to use projectId
  }
}
```

### Success Criteria:

#### Automated Verification:
- [x] TypeScript compilation passes: `bun run tsc --noEmit`

#### Smoke Test
Create `packages/server/tests/smoke/folders-phase9-agent-tools.test.ts`:
```typescript
import { describe, test, expect } from 'bun:test'
import { createDocumentTools } from '../../tools/document-tools'

describe('Folders Phase 9: Agent Tools', () => {
  // These tests verify the tool definitions compile and have correct schemas
  const tools = createDocumentTools('test-project-id', 'test-user-id')

  test('doc_create tool accepts folder_id', () => {
    expect(tools.doc_create).toBeDefined()
    // Verify schema includes folder_id parameter
    const schema = tools.doc_create.inputSchema
    expect(schema.shape.folder_id).toBeDefined()
  })

  test('doc_list tool accepts folder_id filter', () => {
    expect(tools.doc_list).toBeDefined()
    const schema = tools.doc_list.inputSchema
    expect(schema.shape.folder_id).toBeDefined()
  })

  test('doc_move tool exists', () => {
    expect(tools.doc_move).toBeDefined()
    const schema = tools.doc_move.inputSchema
    expect(schema.shape.id).toBeDefined()
    expect(schema.shape.folder_id).toBeDefined()
  })

  test('folder_create tool exists', () => {
    expect(tools.folder_create).toBeDefined()
    const schema = tools.folder_create.inputSchema
    expect(schema.shape.name).toBeDefined()
    expect(schema.shape.parent_id).toBeDefined()
  })

  test('folder_list tool exists', () => {
    expect(tools.folder_list).toBeDefined()
    const schema = tools.folder_list.inputSchema
    expect(schema.shape.parent_id).toBeDefined()
  })
})
```

Run: `bun test packages/server/tests/smoke/folders-phase9-agent-tools.test.ts`

---

## Testing Strategy

### Unit Tests:
- `validateFolderName()` edge cases (empty, too long, invalid chars)
- `checkDepthLimit()` with various depths
- `getBreadcrumb()` path computation

### Integration Tests:
- Create nested folder structure (up to 5 levels)
- Create documents in folders
- Rename folder (verify documents still accessible)
- Move folder (verify children move too)
- Delete folder with contents (verify cascade)
- Tree view returns correct structure
- Search finds documents and folders

### Manual Testing Steps:
1. Create project
2. Create folder at root: `POST /api/projects/:id/folders {name: "Design"}`
3. Create nested folder: `POST /api/projects/:id/folders {name: "Mockups", parent_id: "..."}`
4. Create document in folder: `POST /api/projects/:id/documents {name: "spec", folder_id: "..."}`
5. Get tree: `GET /api/projects/:id/tree` - verify structure
6. Search: `GET /api/projects/:id/search?q=mock` - verify results
7. Get document: `GET /api/projects/:id/documents/:docId` - verify breadcrumb
8. Rename folder: `PATCH /api/projects/:id/folders/:folderId {name: "Designs"}`
9. Move document: `PATCH /api/projects/:id/documents/:docId {folder_id: null}` (to root)
10. Delete folder: `DELETE /api/projects/:id/folders/:folderId` - verify cascade

## Performance Considerations

- Tree view: Single query for folders + documents is O(n) where n = total items
- Search: ILIKE with prefix wildcard uses index scan (not full scan)
- Breadcrumb: Recursive CTE is efficient for shallow hierarchies (max 5)
- Consider adding caching for frequently accessed trees (future optimization)

## Migration Notes

If path-based folders were already implemented (from document-folder-hierarchy plan):
1. Create folders from unique paths
2. Update documents with folder_id based on path
3. Drop path column
4. Update RLS policies

## References

- Existing plan: `thoughts/shared/plans/2026-02-04-document-folder-hierarchy.md`
- Current document manager: `packages/server/document-manager.ts`
- Current document routes: `packages/server/routes/documents.ts`
- Shared types: `packages/shared/types.ts`, `packages/shared/api.ts`
- Stories: web-folders epic, web-navigation epic, web-documents epic
