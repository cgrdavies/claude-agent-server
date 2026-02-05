# Projects Feature: Integration Contract

This document reconciles the 5 implementation plans for the Projects feature and serves as the canonical reference for implementation.

## Architectural Decisions

### 1. Folder Approach: Explicit Folders (RESOLVED)

**Decision**: Use explicit `folders` table with `folder_id` on documents.

**Rationale** (from Folders & Navigation Backend plan):
- Empty folders can exist naturally
- Folder rename is O(1), not O(n) document updates
- Soft delete is straightforward
- Real-time sync via simple entity changes
- Tree view query is efficient (one query for all folders + documents)
- Matches user mental model of filesystem

**Impact on Frontend Plans**:
- Frontend plans assumed path-based (`path` column on documents)
- Updated approach: Frontend fetches tree from `/api/projects/:projectId/tree` endpoint
- Documents use `folder_id` instead of `path`
- Breadcrumbs computed from folder ancestry, not string path

### 2. Nested API Routes

**Decision**: Project-scoped resources use nested routes.

Routes:
- `/api/projects` - Project CRUD
- `/api/projects/:projectId/folders` - Folder CRUD
- `/api/projects/:projectId/documents` - Document CRUD
- `/api/projects/:projectId/sessions` - Session CRUD
- `/api/projects/:projectId/tree` - Full hierarchy
- `/api/projects/:projectId/search` - Name search

### 3. Soft Delete Strategy

**Decision**: Soft delete for projects and folders (cascades to contents).

- Projects: `deleted_at` timestamp, superuser-only delete/restore
- Folders: `deleted_at` timestamp, cascades to child folders and documents
- Documents: `deleted_at` timestamp (set when parent folder deleted)

### 4. Session Project Context

**Decision**: Sessions get project context injected at creation time.

- Small projects (<=20 docs): Document list in system prompt
- Large projects (>20 docs): Tool usage instructions in system prompt
- Context is static (captured at session creation)

---

## Dependency Graph

```
Phase 1: Core Backend (projects table, project_id on docs/sessions)
    |
    v
Phase 2: Folders Backend (folders table, folder_id on docs)
    |
    +---> Phase 3: AI Session Integration (project context in sessions)
    |
    v
Phase 4: Frontend Projects & Folders (Projects page, TreeView)
    |
    v
Phase 5: Frontend Documents & Navigation (Search, Breadcrumbs)
```

**Build Order**:
1. **Core Backend Projects** - Foundation: projects CRUD, project_id FK on docs/sessions
2. **Folders & Navigation Backend** - Add folders table, tree/search APIs
3. **AI Session Integration** - Can build in parallel with #2 after #1 complete
4. **Frontend Projects & Folders** - Depends on #1, #2 complete
5. **Frontend Documents & Navigation** - Depends on #4 complete

---

## Shared Types (Source of Truth)

See `packages/shared/types.ts` for canonical type definitions.

### Core Entities

```typescript
// Project
type Project = {
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

// Folder
type Folder = {
  id: string
  project_id: string
  parent_id: string | null      // null = project root
  name: string
  created_by: string
  created_at: string
  updated_at: string
}

// Document (updated)
type Document = {
  id: string
  project_id: string
  workspace_id: string
  folder_id: string | null      // null = project root
  name: string
  created_by: string
  created_at: string
  updated_at: string
}

// AgentSession (updated)
type AgentSession = {
  id: string
  project_id: string
  workspace_id: string
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

### Navigation Types

```typescript
// Breadcrumb
type BreadcrumbItem = {
  id: string
  name: string
  type: 'project' | 'folder' | 'document'
}

// Tree Node (for tree view)
type TreeNode = {
  id: string
  name: string
  type: 'folder' | 'document'
  parent_id: string | null      // null = project root
  updated_at: string
  children?: TreeNode[]         // only for nested response
}

// Search Result
type SearchResult = {
  id: string
  name: string
  type: 'folder' | 'document'
  parent_id: string | null
  breadcrumb: BreadcrumbItem[]
}
```

---

## API Endpoints Summary

### Projects (Core Backend Plan)

| Method | Endpoint | Request | Response | Plan |
|--------|----------|---------|----------|------|
| POST | `/api/projects` | `CreateProjectRequest` | `CreateProjectResponse` | Core Backend |
| GET | `/api/projects` | - | `ListProjectsResponse` | Core Backend |
| GET | `/api/projects/:id` | - | `GetProjectResponse` | Core Backend |
| PATCH | `/api/projects/:id` | `UpdateProjectRequest` | `UpdateProjectResponse` | Core Backend |
| DELETE | `/api/projects/:id` | - | `DeleteProjectResponse` | Core Backend |
| POST | `/api/projects/:id/restore` | - | `RestoreProjectResponse` | Core Backend |

### Folders (Folders Backend Plan)

| Method | Endpoint | Request | Response | Plan |
|--------|----------|---------|----------|------|
| POST | `/api/projects/:projectId/folders` | `CreateFolderRequest` | `CreateFolderResponse` | Folders Backend |
| GET | `/api/projects/:projectId/folders` | - | `ListFoldersResponse` | Folders Backend |
| GET | `/api/projects/:projectId/folders/:id` | - | `GetFolderResponse` | Folders Backend |
| GET | `/api/projects/:projectId/folders/:id/contents` | - | `GetFolderContentsResponse` | Folders Backend |
| PATCH | `/api/projects/:projectId/folders/:id` | `UpdateFolderRequest` | `UpdateFolderResponse` | Folders Backend |
| DELETE | `/api/projects/:projectId/folders/:id` | - | `DeleteFolderResponse` | Folders Backend |

### Tree & Search (Folders Backend Plan)

| Method | Endpoint | Request | Response | Plan |
|--------|----------|---------|----------|------|
| GET | `/api/projects/:projectId/tree` | - | `GetTreeResponse` | Folders Backend |
| GET | `/api/projects/:projectId/search?q=...` | - | `SearchResponse` | Folders Backend |

### Documents (Core Backend + Folders Backend Plans)

| Method | Endpoint | Request | Response | Plan |
|--------|----------|---------|----------|------|
| POST | `/api/projects/:projectId/documents` | `CreateDocumentRequest` | `CreateDocumentResponse` | Core Backend |
| GET | `/api/projects/:projectId/documents` | - | `ListDocumentsResponse` | Core Backend |
| GET | `/api/projects/:projectId/documents/:id` | - | `GetDocumentResponse` | Folders Backend |
| PATCH | `/api/projects/:projectId/documents/:id` | `UpdateDocumentRequest` | `UpdateDocumentResponse` | Core Backend |
| DELETE | `/api/projects/:projectId/documents/:id` | - | `{success: boolean}` | Core Backend |

### Sessions (AI Session Integration Plan)

| Method | Endpoint | Request | Response | Plan |
|--------|----------|---------|----------|------|
| POST | `/api/projects/:projectId/sessions` | `CreateSessionRequest` | `CreateSessionResponse` | AI Session |
| GET | `/api/projects/:projectId/sessions` | - | `ListSessionsResponse` | AI Session |
| GET | `/api/projects/:projectId/sessions/:id` | - | `GetSessionResponse` | AI Session |
| PATCH | `/api/projects/:projectId/sessions/:id` | `UpdateSessionRequest` | `UpdateSessionResponse` | AI Session |
| POST | `/api/projects/:projectId/sessions/:id/messages` | `SendMessageRequest` | SSE stream | AI Session |

---

## Integration Points

### Backend to Backend

1. **Core Backend -> Folders Backend**
   - Folders Backend depends on `project_id` column existing on documents
   - Folders Backend adds `folder_id` column and `folders` table
   - Core Backend must complete Phase 1 before Folders Backend starts

2. **Folders Backend -> AI Session Integration**
   - AI Session uses `listDocs` with folder support for context building
   - AI Session uses `searchDocs` for large project tool support
   - Can build in parallel once Core Backend Phase 1 complete

### Frontend to Backend

3. **Frontend Projects Page -> Projects API**
   - `GET /api/projects` - Load project list
   - `POST /api/projects` - Create project
   - Frontend expects `ListProjectsResponse` shape

4. **Frontend Tree View -> Tree API**
   - `GET /api/projects/:projectId/tree` - Load full hierarchy
   - Frontend builds tree UI from flat `TreeNode[]` array
   - Frontend manages expand/collapse state in localStorage

5. **Frontend Search -> Search API**
   - `GET /api/projects/:projectId/search?q=...&type=...`
   - Frontend displays `SearchResult[]` with breadcrumbs
   - Cmd/Ctrl+K shortcut triggers search

6. **Frontend Document View -> Document API**
   - `GET /api/projects/:projectId/documents/:id` - Get with breadcrumb
   - Frontend displays breadcrumb from response
   - Clicking breadcrumb expands folders in sidebar

7. **Frontend Folder Operations -> Folders API**
   - Context menu triggers folder CRUD
   - Inline editing for folder rename
   - Delete confirmation shows contents count from `/folders/:id/contents`

### Data Flow

```
User clicks project -> Frontend calls GET /api/projects/:id
                    -> Frontend calls GET /api/projects/:id/tree
                    -> Frontend renders TreeView
                    -> User clicks document
                    -> Frontend calls GET /api/projects/:id/documents/:docId
                    -> Frontend displays editor with breadcrumb
```

---

## Database Schema Changes

### Migration 1: Project Scoping (Core Backend)

```sql
-- Add deleted_at to projects
ALTER TABLE projects ADD COLUMN deleted_at TIMESTAMPTZ;

-- Add project_id to documents (NOT NULL)
ALTER TABLE documents ADD COLUMN project_id UUID NOT NULL REFERENCES projects(id);

-- Add project_id to agent_sessions (NOT NULL)
ALTER TABLE agent_sessions ADD COLUMN project_id UUID NOT NULL REFERENCES projects(id);
```

### Migration 2: Folders (Folders Backend)

```sql
-- Create folders table
CREATE TABLE folders (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id UUID NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  parent_id UUID REFERENCES folders(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  created_by UUID NOT NULL REFERENCES auth.users(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  deleted_at TIMESTAMPTZ,
  CONSTRAINT folders_unique_name_in_parent UNIQUE NULLS NOT DISTINCT (project_id, parent_id, name)
);

-- Add folder_id to documents (nullable = root)
ALTER TABLE documents ADD COLUMN folder_id UUID REFERENCES folders(id) ON DELETE SET NULL;

-- Add soft delete to documents
ALTER TABLE documents ADD COLUMN deleted_at TIMESTAMPTZ;
```

---

## Validation Rules

### Folder Constraints
- Max depth: 5 levels
- Max name length: 100 characters
- No duplicate names in same parent
- Invalid characters: `< > : " / \ | ? *`

### Document Constraints
- Max name length: 100 characters
- No duplicate names in same folder

### Project Constraints
- Max name length: 100 characters
- Only superusers can delete/restore

---

## References

| Plan | File |
|------|------|
| Core Backend | `thoughts/shared/plans/2026-02-04-core-backend-projects.md` |
| Folders Backend | `thoughts/shared/plans/2026-02-04-folders-navigation-backend.md` |
| AI Session | `thoughts/shared/plans/2026-02-04-ai-session-integration.md` |
| Frontend Projects | `thoughts/shared/plans/2026-02-04-frontend-projects-folders.md` |
| Frontend Documents | `thoughts/shared/plans/2026-02-04-frontend-documents-navigation.md` |
| Shared Types | `packages/shared/types.ts` |
| Shared API | `packages/shared/api.ts` |
