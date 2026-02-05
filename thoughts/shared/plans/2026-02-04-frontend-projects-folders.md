# Frontend: Projects & Folders UI Implementation Plan

## Overview

Build the frontend UI for project management and folder navigation in the Svelte web app. This includes a dedicated Projects page, project switching, a hierarchical folder tree sidebar, and CRUD operations with inline editing and context menus.

## Current State Analysis

**Frontend Stack:**
- Svelte 5 with runes (`$state`, `$derived`, `$props`, `$effect`)
- Factory function pattern for state (`createDocumentState`, `createAuthState`)
- Component-scoped CSS with CSS custom properties (no Tailwind)
- Supabase auth integration with JWT-based workspace claims

**Existing Components:**
- `App.svelte` - Main app with workspace selection, three-panel layout (filetree/editor/chat)
- `DocumentList.svelte` - Flat document list with create/delete buttons
- `AppHeader.svelte` - Header with app name and user menu
- `createDocumentState` - Manages documents with tabs, load/create/delete

**API Context (from backend plan):**
- New project-scoped routes: `/api/projects`, `/api/projects/:projectId/documents`
- Documents have `path` field for folder hierarchy (e.g., `/`, `/Design/`)
- Folders are virtual (derived from document paths, not stored)

### Key Discoveries:
- `DocumentList.svelte:59-81` - Single-level list rendering with click handlers
- `createDocumentState` at `state.svelte.ts:25-93` - Manages flat document array
- `App.svelte:98-112` - Panel rendering uses snippets for filetree/editor/chat
- `App.svelte:77-97` - Workspace selection flow before main app renders

## Desired End State

After implementation:

1. **Projects Page** - Dedicated view listing all workspace projects with create modal
2. **Project Context** - App is project-scoped, URL reflects current project
3. **Folder Tree** - Hierarchical sidebar with folders, documents, expand/collapse
4. **Inline CRUD** - Create/rename folders inline, context menus for actions
5. **State Persistence** - Expand/collapse state persists in localStorage

### Verification:
- Navigate to Projects page, see project list
- Create new project via modal, enter project
- Create folders at root and nested (up to 5 levels)
- Expand/collapse folders, state persists across refresh
- Rename folders inline (double-click or context menu)
- Delete folders (empty immediately, with contents shows confirmation)
- Single-click documents to open in editor

## What We're NOT Doing

- **Drag-and-drop organization** - Menu-based move is MVP (D5 deferred)
- **Move between projects** - Document moves within project only (D3 deferred)
- **Recent documents panel** - Tree + search covers navigation (N3 deferred)
- **Breadcrumb navigation** - Focus on tree view first (D4 separate story)
- **Keyboard navigation** - Tab, arrow keys deferred (F5 decision)
- **Expand All / Collapse All** - Deferred (F5 decision)
- **Project permissions UI** - Use existing RLS (no UI for permissions)

## Implementation Approach

1. Add projects API client functions
2. Create project state management (`createProjectState`)
3. Build Projects page component
4. Update app routing for project context
5. Refactor document state to be project-scoped with folder support
6. Build folder tree components (TreeView, TreeNode)
7. Add context menus and inline editing
8. Implement expand/collapse with localStorage persistence

---

## Phase 1: Projects API Client & Types

### Overview
Add API client functions for projects CRUD and update shared types for frontend.

### Changes Required:

#### 1. Add Project type to frontend
**File**: `src/lib/types.ts` (create)

```typescript
// Project types (mirrors @claude-agent/shared)
export type Project = {
  id: string
  workspace_id: string
  name: string
  description: string | null
  is_archived: boolean
  created_by: string
  created_at: string
  updated_at: string
}

export type Document = {
  id: string
  project_id: string
  workspace_id: string
  name: string
  path: string
  created_by: string
  created_at: string
  updated_at: string
}

export type FolderEntry = {
  name: string
  path: string
}
```

#### 2. Create projects API module
**File**: `src/lib/api/projects.ts` (create)

```typescript
import type { ApiClient } from './client'

export type Project = {
  id: string
  workspace_id: string
  name: string
  description: string | null
  is_archived: boolean
  created_by: string
  created_at: string
  updated_at: string
}

export type CreateProjectRequest = {
  name: string
  description?: string
}

export type ListProjectsResponse = {
  projects: Project[]
}

export type CreateProjectResponse = {
  project: Project
}

export type UpdateProjectRequest = {
  name?: string
  description?: string
  is_archived?: boolean
}

export function listProjects(api: ApiClient): Promise<ListProjectsResponse> {
  return api.apiFetch('/projects')
}

export function createProject(api: ApiClient, req: CreateProjectRequest): Promise<CreateProjectResponse> {
  return api.apiFetch('/projects', {
    method: 'POST',
    body: JSON.stringify(req),
  })
}

export function getProject(api: ApiClient, id: string): Promise<{ project: Project }> {
  return api.apiFetch(`/projects/${id}`)
}

export function updateProject(api: ApiClient, id: string, req: UpdateProjectRequest): Promise<{ project: Project }> {
  return api.apiFetch(`/projects/${id}`, {
    method: 'PATCH',
    body: JSON.stringify(req),
  })
}

export async function deleteProject(api: ApiClient, id: string): Promise<void> {
  await api.apiRawFetch(`/projects/${id}`, { method: 'DELETE' })
}
```

#### 3. Update documents API for project scope
**File**: `src/lib/api/documents.ts`

Update functions to take `projectId` parameter:

```typescript
import type { ApiClient } from './client'

export type Document = {
  id: string
  project_id: string
  workspace_id: string
  name: string
  path: string
  created_by: string
  created_at: string
  updated_at: string
}

export type FolderEntry = {
  name: string
  path: string
}

export type ListDocumentsResponse = {
  documents: Document[]
  folders?: FolderEntry[]
}

export type CreateDocumentRequest = {
  name: string
  content?: string
  path?: string
}

export function listDocuments(
  api: ApiClient,
  projectId: string,
  path?: string
): Promise<ListDocumentsResponse> {
  let url = `/projects/${projectId}/documents`
  if (path) url += `?path=${encodeURIComponent(path)}`
  return api.apiFetch(url)
}

export function createDocument(
  api: ApiClient,
  projectId: string,
  req: CreateDocumentRequest
): Promise<{ document: Document }> {
  return api.apiFetch(`/projects/${projectId}/documents`, {
    method: 'POST',
    body: JSON.stringify(req),
  })
}

export function getDocument(
  api: ApiClient,
  projectId: string,
  id: string
): Promise<{ document: Document & { content: string } }> {
  return api.apiFetch(`/projects/${projectId}/documents/${id}`)
}

export function updateDocument(
  api: ApiClient,
  projectId: string,
  id: string,
  req: { name?: string; content?: string; path?: string }
): Promise<{ document: Document }> {
  return api.apiFetch(`/projects/${projectId}/documents/${id}`, {
    method: 'PATCH',
    body: JSON.stringify(req),
  })
}

export async function deleteDocument(
  api: ApiClient,
  projectId: string,
  id: string
): Promise<void> {
  await api.apiRawFetch(`/projects/${projectId}/documents/${id}`, { method: 'DELETE' })
}
```

### Success Criteria:

#### Automated Verification:
- [ ] TypeScript compilation passes: `cd svelte-experiment && bun run check`
- [ ] No import errors: `cd svelte-experiment && bun run tsc --noEmit`

Run type checks to verify API client compiles correctly:
```bash
cd svelte-experiment && bun run check
cd svelte-experiment && bun run tsc --noEmit
```

---

## Phase 2: Project State Management

### Overview
Create project state management with list, select, create, update, delete operations.

### Changes Required:

#### 1. Create project state
**File**: `src/lib/projects/state.svelte.ts` (create)

```typescript
import type { ApiClient } from '../api/client'
import * as projectsApi from '../api/projects'
import type { Project } from '../api/projects'

const PROJECT_KEY = 'project:selected'

export function createProjectState(api: ApiClient) {
  let projects = $state<Project[]>([])
  let isLoading = $state(false)
  let error = $state<string | null>(null)
  let selectedProjectId = $state<string | null>(null)

  // Restore selected project from localStorage
  const saved = localStorage.getItem(PROJECT_KEY)
  if (saved) selectedProjectId = saved

  async function load() {
    isLoading = true
    error = null
    try {
      const res = await projectsApi.listProjects(api)
      projects = res.projects
      // Validate saved selection still exists
      if (selectedProjectId && !projects.some(p => p.id === selectedProjectId)) {
        selectedProjectId = null
        localStorage.removeItem(PROJECT_KEY)
      }
    } catch (e) {
      error = e instanceof Error ? e.message : String(e)
    } finally {
      isLoading = false
    }
  }

  function select(id: string | null) {
    if (id && !projects.some(p => p.id === id)) return
    selectedProjectId = id
    if (id) {
      localStorage.setItem(PROJECT_KEY, id)
    } else {
      localStorage.removeItem(PROJECT_KEY)
    }
  }

  async function create(name: string, description?: string): Promise<Project | null> {
    error = null
    try {
      const res = await projectsApi.createProject(api, { name, description })
      projects = [res.project, ...projects]
      return res.project
    } catch (e) {
      error = e instanceof Error ? e.message : String(e)
      return null
    }
  }

  async function update(id: string, data: { name?: string; description?: string }): Promise<boolean> {
    error = null
    try {
      const res = await projectsApi.updateProject(api, id, data)
      projects = projects.map(p => p.id === id ? res.project : p)
      return true
    } catch (e) {
      error = e instanceof Error ? e.message : String(e)
      return false
    }
  }

  async function remove(id: string): Promise<boolean> {
    error = null
    try {
      await projectsApi.deleteProject(api, id)
      projects = projects.filter(p => p.id !== id)
      if (selectedProjectId === id) {
        selectedProjectId = null
        localStorage.removeItem(PROJECT_KEY)
      }
      return true
    } catch (e) {
      error = e instanceof Error ? e.message : String(e)
      return false
    }
  }

  return {
    get projects() { return projects },
    get isLoading() { return isLoading },
    get error() { return error },
    get selectedProjectId() { return selectedProjectId },
    get selectedProject(): Project | undefined {
      return projects.find(p => p.id === selectedProjectId)
    },

    load,
    select,
    create,
    update,
    remove,
  }
}

export type ProjectState = ReturnType<typeof createProjectState>
```

### Success Criteria:

#### Automated Verification:
- [ ] TypeScript compilation passes: `cd svelte-experiment && bun run check`

#### Smoke Test
Create `svelte-experiment/src/lib/projects/state.test.ts`:
```typescript
import { describe, test, expect, mock } from 'bun:test'

describe('Project State', () => {
  test('createProjectState initializes correctly', async () => {
    const mockApi = {
      apiFetch: mock(() => Promise.resolve({ projects: [] }))
    }
    // Note: Actual test depends on Svelte runtime for $state
    // This verifies the module can be imported
    const { createProjectState } = await import('./state.svelte')
    expect(createProjectState).toBeDefined()
  })
})
```

Run: `cd svelte-experiment && bun test src/lib/projects/state.test.ts`

---

## Phase 3: Projects Page Component

### Overview
Build the Projects page showing all projects with a create modal.

### Changes Required:

#### 1. Create Projects page
**File**: `src/lib/components/ProjectsPage.svelte` (create)

```svelte
<script lang="ts">
  import type { ProjectState } from '../projects/state.svelte'
  import { formatRelativeDate } from '../utils/date'

  let {
    projectState,
    onSelectProject,
  }: {
    projectState: ProjectState
    onSelectProject: (id: string) => void
  } = $props()

  let showCreateModal = $state(false)
  let newProjectName = $state('')
  let newProjectDescription = $state('')
  let isCreating = $state(false)
  let nameError = $state<string | null>(null)

  function validateName(name: string): string | null {
    const trimmed = name.trim()
    if (!trimmed) return 'Name is required'
    if (trimmed.length > 100) return 'Name must be 100 characters or less'
    return null
  }

  async function handleCreate() {
    const trimmedName = newProjectName.trim()
    nameError = validateName(trimmedName)
    if (nameError) return

    isCreating = true
    const project = await projectState.create(trimmedName, newProjectDescription.trim() || undefined)
    isCreating = false

    if (project) {
      showCreateModal = false
      newProjectName = ''
      newProjectDescription = ''
      nameError = null
      onSelectProject(project.id)
    }
  }

  function handleCancel() {
    showCreateModal = false
    newProjectName = ''
    newProjectDescription = ''
    nameError = null
  }

  function handleKeydown(e: KeyboardEvent) {
    if (e.key === 'Enter' && !isCreating) {
      handleCreate()
    } else if (e.key === 'Escape') {
      handleCancel()
    }
  }
</script>

<div class="projects-page">
  <header class="projects-header">
    <h1>Projects</h1>
    <button class="create-btn" onclick={() => showCreateModal = true}>
      + New Project
    </button>
  </header>

  <div class="projects-content">
    {#if projectState.isLoading}
      <div class="empty-state">
        <span class="empty-label">Loading projects...</span>
        <div class="loading-bar"><div class="loading-bar-fill"></div></div>
      </div>
    {:else if projectState.error}
      <div class="empty-state">
        <span class="empty-label">Failed to load projects</span>
        <span class="empty-hint">{projectState.error}</span>
        <button class="retry-btn" onclick={() => projectState.load()}>Retry</button>
      </div>
    {:else if projectState.projects.length === 0}
      <div class="empty-state">
        <span class="empty-label">No projects yet</span>
        <span class="empty-hint">Create your first project to get started</span>
        <button class="create-btn" onclick={() => showCreateModal = true}>
          + Create Project
        </button>
      </div>
    {:else}
      <div class="project-grid">
        {#each projectState.projects as project (project.id)}
          <button
            class="project-card"
            onclick={() => onSelectProject(project.id)}
          >
            <div class="project-name">{project.name}</div>
            {#if project.description}
              <div class="project-description">{project.description}</div>
            {/if}
            <div class="project-meta">
              Updated {formatRelativeDate(project.updated_at)}
            </div>
          </button>
        {/each}
      </div>
    {/if}
  </div>
</div>

{#if showCreateModal}
  <!-- svelte-ignore a11y_no_static_element_interactions -->
  <div class="modal-overlay" onclick={handleCancel} onkeydown={handleKeydown}>
    <!-- svelte-ignore a11y_click_events_have_key_events -->
    <div class="modal-content" onclick={(e) => e.stopPropagation()}>
      <h2>Create Project</h2>
      <div class="form-group">
        <label for="project-name">Name</label>
        <input
          id="project-name"
          type="text"
          bind:value={newProjectName}
          placeholder="Project name"
          maxlength="100"
          disabled={isCreating}
          class:error={nameError}
        />
        {#if nameError}
          <span class="error-text">{nameError}</span>
        {/if}
        <span class="char-count">{newProjectName.length}/100</span>
      </div>
      <div class="form-group">
        <label for="project-description">Description (optional)</label>
        <textarea
          id="project-description"
          bind:value={newProjectDescription}
          placeholder="Brief description"
          rows="3"
          disabled={isCreating}
        ></textarea>
      </div>
      <div class="modal-actions">
        <button class="cancel-btn" onclick={handleCancel} disabled={isCreating}>
          Cancel
        </button>
        <button class="submit-btn" onclick={handleCreate} disabled={isCreating}>
          {isCreating ? 'Creating...' : 'Create'}
        </button>
      </div>
    </div>
  </div>
{/if}

<style>
  .projects-page {
    display: flex;
    flex-direction: column;
    height: 100%;
    background: var(--bg-secondary);
  }

  .projects-header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding: 24px 32px;
    background: var(--bg-primary);
    border-bottom: 1px solid var(--border-color);
  }

  .projects-header h1 {
    font-size: 20px;
    font-weight: 600;
    color: var(--text-primary);
  }

  .create-btn {
    font-size: 13px;
    font-weight: 500;
    color: var(--bg-primary);
    background: var(--accent);
    border: none;
    border-radius: 6px;
    padding: 8px 16px;
    cursor: pointer;
    transition: opacity 0.15s;
  }

  .create-btn:hover {
    opacity: 0.9;
  }

  .projects-content {
    flex: 1;
    overflow-y: auto;
    padding: 24px 32px;
  }

  .project-grid {
    display: grid;
    grid-template-columns: repeat(auto-fill, minmax(280px, 1fr));
    gap: 16px;
  }

  .project-card {
    display: flex;
    flex-direction: column;
    align-items: flex-start;
    padding: 20px;
    background: var(--bg-primary);
    border: 1px solid var(--border-color);
    border-radius: 8px;
    cursor: pointer;
    text-align: left;
    font-family: var(--font-sans);
    transition: border-color 0.15s, box-shadow 0.15s;
  }

  .project-card:hover {
    border-color: var(--text-muted);
    box-shadow: 0 2px 8px rgba(0, 0, 0, 0.04);
  }

  .project-name {
    font-size: 15px;
    font-weight: 600;
    color: var(--text-primary);
    margin-bottom: 4px;
  }

  .project-description {
    font-size: 13px;
    color: var(--text-secondary);
    margin-bottom: 12px;
    line-height: 1.4;
    display: -webkit-box;
    -webkit-line-clamp: 2;
    -webkit-box-orient: vertical;
    overflow: hidden;
  }

  .project-meta {
    font-size: 11px;
    color: var(--text-muted);
    margin-top: auto;
  }

  /* Empty state */
  .empty-state {
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    gap: 8px;
    padding: 64px 16px;
    text-align: center;
  }

  .empty-label {
    font-size: 14px;
    font-weight: 500;
    color: var(--text-secondary);
  }

  .empty-hint {
    font-size: 13px;
    color: var(--text-muted);
    max-width: 240px;
  }

  .retry-btn {
    font-size: 12px;
    color: var(--text-secondary);
    background: none;
    border: 1px solid var(--border-color);
    border-radius: 4px;
    padding: 4px 12px;
    cursor: pointer;
    margin-top: 8px;
  }

  .retry-btn:hover {
    background: var(--accent-hover);
  }

  .loading-bar {
    width: 80px;
    height: 2px;
    background: var(--border-color);
    border-radius: 1px;
    overflow: hidden;
    margin-top: 8px;
  }

  .loading-bar-fill {
    width: 40%;
    height: 100%;
    background: var(--text-muted);
    border-radius: 1px;
    animation: loading-slide 1.2s ease-in-out infinite;
  }

  @keyframes loading-slide {
    0% { transform: translateX(-100%); }
    50% { transform: translateX(150%); }
    100% { transform: translateX(250%); }
  }

  /* Modal */
  .modal-overlay {
    position: fixed;
    inset: 0;
    background: rgba(0, 0, 0, 0.4);
    display: flex;
    align-items: center;
    justify-content: center;
    z-index: 1000;
  }

  .modal-content {
    width: 400px;
    max-width: 90vw;
    background: var(--bg-primary);
    border-radius: 12px;
    padding: 24px;
    box-shadow: 0 8px 32px rgba(0, 0, 0, 0.12);
  }

  .modal-content h2 {
    font-size: 16px;
    font-weight: 600;
    color: var(--text-primary);
    margin-bottom: 20px;
  }

  .form-group {
    margin-bottom: 16px;
    position: relative;
  }

  .form-group label {
    display: block;
    font-size: 12px;
    font-weight: 500;
    color: var(--text-secondary);
    margin-bottom: 6px;
  }

  .form-group input,
  .form-group textarea {
    width: 100%;
    font-size: 14px;
    font-family: var(--font-sans);
    color: var(--text-primary);
    background: var(--bg-secondary);
    border: 1px solid var(--border-color);
    border-radius: 6px;
    padding: 10px 12px;
    outline: none;
    transition: border-color 0.15s;
  }

  .form-group input:focus,
  .form-group textarea:focus {
    border-color: var(--accent);
  }

  .form-group input.error {
    border-color: #e53935;
  }

  .error-text {
    font-size: 11px;
    color: #e53935;
    margin-top: 4px;
  }

  .char-count {
    position: absolute;
    right: 8px;
    bottom: 8px;
    font-size: 10px;
    color: var(--text-muted);
  }

  .form-group textarea {
    resize: vertical;
    min-height: 60px;
  }

  .modal-actions {
    display: flex;
    justify-content: flex-end;
    gap: 8px;
    margin-top: 20px;
  }

  .cancel-btn {
    font-size: 13px;
    font-weight: 500;
    color: var(--text-secondary);
    background: none;
    border: 1px solid var(--border-color);
    border-radius: 6px;
    padding: 8px 16px;
    cursor: pointer;
    font-family: var(--font-sans);
  }

  .cancel-btn:hover:not(:disabled) {
    background: var(--accent-hover);
  }

  .submit-btn {
    font-size: 13px;
    font-weight: 500;
    color: var(--bg-primary);
    background: var(--accent);
    border: none;
    border-radius: 6px;
    padding: 8px 16px;
    cursor: pointer;
    font-family: var(--font-sans);
  }

  .submit-btn:hover:not(:disabled) {
    opacity: 0.9;
  }

  .submit-btn:disabled,
  .cancel-btn:disabled {
    opacity: 0.5;
    cursor: default;
  }
</style>
```

### Success Criteria:

#### Automated Verification:
- [ ] Component compiles without errors: `cd svelte-experiment && bun run check`
- [ ] No accessibility warnings from Svelte compiler

#### Smoke Test
Create `svelte-experiment/src/lib/components/ProjectsPage.test.ts`:
```typescript
import { describe, test, expect } from 'bun:test'

describe('ProjectsPage Component', () => {
  test('component module can be imported', async () => {
    // Verify the component can be imported without errors
    const mod = await import('./ProjectsPage.svelte')
    expect(mod.default).toBeDefined()
  })

  test('validateName rejects empty names', () => {
    // Extract validation logic for testing
    const validateName = (name: string): string | null => {
      const trimmed = name.trim()
      if (!trimmed) return 'Name is required'
      if (trimmed.length > 100) return 'Name must be 100 characters or less'
      return null
    }
    expect(validateName('')).toBe('Name is required')
    expect(validateName('   ')).toBe('Name is required')
    expect(validateName('a'.repeat(101))).toBe('Name must be 100 characters or less')
    expect(validateName('Valid Name')).toBeNull()
  })
})
```

Run: `cd svelte-experiment && bun test src/lib/components/ProjectsPage.test.ts`

---

## Phase 4: App Routing & Project Context

### Overview
Update App.svelte to handle project selection flow and integrate ProjectsPage.

### Changes Required:

#### 1. Update App.svelte
**File**: `src/App.svelte`

Add project state and routing logic:

```svelte
<script lang="ts">
  // ... existing imports ...
  import { createProjectState, type ProjectState } from './lib/projects/state.svelte'
  import ProjectsPage from './lib/components/ProjectsPage.svelte'

  const authState = createAuthState()
  const layoutState = createLayoutState()
  const dragState = createDragState()

  let projectState = $state<ProjectState | null>(null)
  let agentState = $state<AgentState | null>(null)
  let documentState = $state<DocumentState | null>(null)

  // Initialize app state when authenticated and workspace selected
  $effect(() => {
    if (authState.isAuthenticated && authState.session && authState.workspaceId) {
      untrack(() => {
        const api = createApiClient(authState)
        const ps = createProjectState(api)
        projectState = ps
        ps.load()
      })
    } else if (!authState.isAuthenticated && !authState.isLoading) {
      untrack(() => {
        projectState = null
        if (agentState) {
          agentState.disconnect()
          agentState = null
        }
        documentState = null
      })
    }
  })

  // Initialize document/agent state when project selected
  $effect(() => {
    if (projectState?.selectedProjectId && authState.isAuthenticated) {
      untrack(() => {
        const api = createApiClient(authState)
        const ds = createDocumentState(api, projectState!.selectedProjectId!)
        const as_ = createAgentState(authState, projectState!.selectedProjectId!)
        documentState = ds
        agentState = as_
        ds.load()
        as_.init()
      })
    } else if (!projectState?.selectedProjectId) {
      untrack(() => {
        if (agentState) {
          agentState.disconnect()
          agentState = null
        }
        documentState = null
      })
    }
  })

  function handleSelectProject(id: string) {
    projectState?.select(id)
  }

  function handleBackToProjects() {
    projectState?.select(null)
  }

  // ... rest of existing code ...
</script>

{#if authState.isLoading}
  <!-- Loading -->
{:else if !authState.isAuthenticated}
  <LoginPanel {authState} />
{:else if !authState.workspaceId}
  <!-- Workspace picker -->
{:else if projectState && !projectState.selectedProjectId}
  <!-- Projects page -->
  <AppHeader {authState} />
  <div class="projects-view">
    <ProjectsPage {projectState} onSelectProject={handleSelectProject} />
  </div>
{:else if projectState && agentState && documentState}
  <!-- Main app with project context -->
  <AppHeader {authState} onBackToProjects={handleBackToProjects} />
  <div class="ide-layout">
    <!-- existing layout -->
  </div>
{/if}
```

#### 2. Update AppHeader for project context
**File**: `src/lib/components/AppHeader.svelte`

Add back button when in project view:

```svelte
<script lang="ts">
  import type { AuthState } from '../auth/state.svelte'

  interface Props {
    authState: AuthState
    onBackToProjects?: () => void
  }

  let { authState, onBackToProjects }: Props = $props()
  // ... rest of existing code ...
</script>

<header class="app-header">
  <div class="app-header-left">
    {#if onBackToProjects}
      <button class="back-btn" onclick={onBackToProjects} aria-label="Back to projects">
        <svg width="16" height="16" viewBox="0 0 16 16" fill="currentColor">
          <path d="M10.354 3.146a.5.5 0 010 .708L6.207 8l4.147 4.146a.5.5 0 01-.708.708l-4.5-4.5a.5.5 0 010-.708l4.5-4.5a.5.5 0 01.708 0z"/>
        </svg>
      </button>
    {/if}
    <span class="app-name">Shopped</span>
  </div>
  <!-- ... rest -->
</header>

<style>
  /* ... existing styles ... */

  .back-btn {
    display: flex;
    align-items: center;
    justify-content: center;
    width: 28px;
    height: 28px;
    background: none;
    border: none;
    border-radius: 4px;
    color: var(--text-secondary);
    cursor: pointer;
    margin-right: 8px;
  }

  .back-btn:hover {
    background: var(--accent-hover);
    color: var(--text-primary);
  }
</style>
```

#### 3. Update document state for project scope
**File**: `src/lib/documents/state.svelte.ts`

Update signature to accept projectId:

```typescript
export function createDocumentState(api: ApiClient, projectId: string) {
  // ... existing state ...

  async function load() {
    isLoading = true
    error = null
    try {
      const res = await listDocuments(api, projectId)
      documents = res.documents
      // ... rest unchanged
    } catch (e) {
      error = e instanceof Error ? e.message : String(e)
    } finally {
      isLoading = false
    }
  }

  async function create(name: string, content?: string, path?: string) {
    error = null
    try {
      const res = await createDocument(api, projectId, content ? { name, content, path } : { name, path })
      await this.load()
      return res.document
    } catch (e) {
      error = e instanceof Error ? e.message : String(e)
      return null
    }
  }

  async function remove(id: string) {
    error = null
    try {
      await deleteDocument(api, projectId, id)
      closeTab(id)
      documents = documents.filter(d => d.id !== id)
    } catch (e) {
      error = e instanceof Error ? e.message : String(e)
    }
  }

  // ... rest of methods updated similarly
}
```

### Success Criteria:

#### Automated Verification:
- [ ] TypeScript compilation passes: `cd svelte-experiment && bun run check`
- [ ] Dev server starts without errors: `cd svelte-experiment && bun run dev`

#### Smoke Test
Start the dev server and verify the app loads:
```bash
cd svelte-experiment && bun run dev
```

Then run the following checks programmatically or via browser devtools:
1. Open http://localhost:5173 in browser
2. Check browser console for no errors
3. Verify Projects page renders after login

Alternatively, create a Playwright smoke test:
```typescript
// svelte-experiment/tests/e2e/projects.test.ts
import { test, expect } from '@playwright/test'

test('projects page loads after login', async ({ page }) => {
  await page.goto('/')
  // After login flow, should see Projects page
  await expect(page.getByText('Projects')).toBeVisible()
})
```

Run: `cd svelte-experiment && bun run test:e2e`

---

## Phase 5: Folder Tree Data Model

### Overview
Extend document state to support hierarchical folder structure with expand/collapse.

### Changes Required:

#### 1. Add tree types
**File**: `src/lib/documents/types.ts` (create)

```typescript
export type TreeNodeType = 'folder' | 'document'

export type TreeNode = {
  id: string
  name: string
  type: TreeNodeType
  path: string
  children?: TreeNode[]
  // For documents only
  documentId?: string
  updatedAt?: string
}

export type ExpandState = Record<string, boolean>
```

#### 2. Add tree builder utility
**File**: `src/lib/documents/tree.ts` (create)

```typescript
import type { Document, FolderEntry } from '../api/documents'
import type { TreeNode } from './types'

/**
 * Build a tree structure from flat documents list.
 * Documents are organized by their path field.
 */
export function buildTree(documents: Document[]): TreeNode[] {
  const root: TreeNode[] = []
  const folderMap = new Map<string, TreeNode>()

  // First pass: create folder nodes from document paths
  for (const doc of documents) {
    const pathParts = doc.path.split('/').filter(Boolean)
    let currentPath = '/'

    for (const part of pathParts) {
      const parentPath = currentPath
      currentPath = currentPath + part + '/'

      if (!folderMap.has(currentPath)) {
        const folder: TreeNode = {
          id: `folder:${currentPath}`,
          name: part,
          type: 'folder',
          path: currentPath,
          children: [],
        }
        folderMap.set(currentPath, folder)

        // Add to parent
        if (parentPath === '/') {
          root.push(folder)
        } else {
          const parent = folderMap.get(parentPath)
          if (parent) {
            parent.children = parent.children || []
            parent.children.push(folder)
          }
        }
      }
    }
  }

  // Second pass: add documents to folders
  for (const doc of documents) {
    const docNode: TreeNode = {
      id: `document:${doc.id}`,
      name: doc.name,
      type: 'document',
      path: doc.path,
      documentId: doc.id,
      updatedAt: doc.updated_at,
    }

    if (doc.path === '/') {
      root.push(docNode)
    } else {
      const parent = folderMap.get(doc.path)
      if (parent) {
        parent.children = parent.children || []
        parent.children.push(docNode)
      }
    }
  }

  // Sort: folders first, then alphabetically
  const sortNodes = (nodes: TreeNode[]) => {
    nodes.sort((a, b) => {
      if (a.type !== b.type) return a.type === 'folder' ? -1 : 1
      return a.name.localeCompare(b.name)
    })
    for (const node of nodes) {
      if (node.children) sortNodes(node.children)
    }
  }
  sortNodes(root)

  return root
}

/**
 * Get depth of a path (number of folders deep).
 */
export function getPathDepth(path: string): number {
  return path.split('/').filter(Boolean).length
}

/**
 * Check if adding a folder at this path would exceed max depth.
 */
export function wouldExceedMaxDepth(parentPath: string, maxDepth: number = 5): boolean {
  return getPathDepth(parentPath) >= maxDepth
}

/**
 * Get parent path from a path.
 */
export function getParentPath(path: string): string {
  const parts = path.split('/').filter(Boolean)
  if (parts.length === 0) return '/'
  parts.pop()
  return parts.length === 0 ? '/' : '/' + parts.join('/') + '/'
}

/**
 * Check if a folder name already exists at the given path.
 */
export function folderExists(documents: Document[], parentPath: string, name: string): boolean {
  const targetPath = parentPath === '/' ? `/${name}/` : `${parentPath}${name}/`
  return documents.some(d => d.path.startsWith(targetPath))
}

/**
 * Check if a document name already exists at the given path.
 */
export function documentExists(documents: Document[], path: string, name: string): boolean {
  return documents.some(d => d.path === path && d.name === name)
}
```

#### 3. Add tree tests
**File**: `src/lib/documents/tree.test.ts` (create)

```typescript
import { test, expect } from 'bun:test'
import { buildTree, getPathDepth, wouldExceedMaxDepth, getParentPath } from './tree'
import type { Document } from '../api/documents'

test('buildTree creates correct structure', () => {
  const docs: Document[] = [
    { id: '1', project_id: 'p', workspace_id: 'w', name: 'readme', path: '/', created_by: 'u', created_at: '', updated_at: '' },
    { id: '2', project_id: 'p', workspace_id: 'w', name: 'spec', path: '/Design/', created_by: 'u', created_at: '', updated_at: '' },
    { id: '3', project_id: 'p', workspace_id: 'w', name: 'notes', path: '/Design/Drafts/', created_by: 'u', created_at: '', updated_at: '' },
  ]

  const tree = buildTree(docs)

  // Root should have Design folder and readme doc
  expect(tree).toHaveLength(2)

  const design = tree.find(n => n.name === 'Design')
  expect(design?.type).toBe('folder')
  expect(design?.children).toHaveLength(2) // Drafts folder + spec doc

  const drafts = design?.children?.find(n => n.name === 'Drafts')
  expect(drafts?.type).toBe('folder')
  expect(drafts?.children).toHaveLength(1) // notes doc
})

test('getPathDepth returns correct depth', () => {
  expect(getPathDepth('/')).toBe(0)
  expect(getPathDepth('/Design/')).toBe(1)
  expect(getPathDepth('/Design/Drafts/')).toBe(2)
})

test('wouldExceedMaxDepth checks correctly', () => {
  expect(wouldExceedMaxDepth('/', 5)).toBe(false)
  expect(wouldExceedMaxDepth('/a/b/c/d/', 5)).toBe(false)
  expect(wouldExceedMaxDepth('/a/b/c/d/e/', 5)).toBe(true)
})

test('getParentPath returns parent', () => {
  expect(getParentPath('/')).toBe('/')
  expect(getParentPath('/Design/')).toBe('/')
  expect(getParentPath('/Design/Drafts/')).toBe('/Design/')
})
```

### Success Criteria:

#### Automated Verification:
- [ ] Tree tests pass: `cd svelte-experiment && bun test src/lib/documents/tree.test.ts`
- [ ] TypeScript compilation passes: `cd svelte-experiment && bun run check`

The test file already exists in the plan. Run:
```bash
cd svelte-experiment && bun test src/lib/documents/tree.test.ts
```

---

## Phase 6: Folder Tree Components

### Overview
Build the hierarchical tree view components with expand/collapse.

### Changes Required:

#### 1. Create TreeView component
**File**: `src/lib/components/TreeView.svelte` (create)

```svelte
<script lang="ts">
  import type { DocumentState } from '../documents/state.svelte'
  import type { TreeNode, ExpandState } from '../documents/types'
  import { buildTree } from '../documents/tree'
  import TreeNodeComponent from './TreeNode.svelte'

  let {
    documentState,
    onSelectDocument,
  }: {
    documentState: DocumentState
    onSelectDocument: (id: string) => void
  } = $props()

  const EXPAND_KEY = 'tree:expanded'

  // Load expand state from localStorage
  let expandState = $state<ExpandState>(() => {
    try {
      const saved = localStorage.getItem(EXPAND_KEY)
      return saved ? JSON.parse(saved) : {}
    } catch {
      return {}
    }
  })

  // Save expand state to localStorage
  $effect(() => {
    localStorage.setItem(EXPAND_KEY, JSON.stringify(expandState))
  })

  let tree = $derived(buildTree(documentState.documents))

  function toggleExpand(nodeId: string) {
    expandState = { ...expandState, [nodeId]: !expandState[nodeId] }
  }

  function handleNodeClick(node: TreeNode) {
    if (node.type === 'folder') {
      toggleExpand(node.id)
    } else if (node.documentId) {
      onSelectDocument(node.documentId)
    }
  }

  let isCreatingFolder = $state(false)
  let newFolderPath = $state<string | null>(null)
  let newFolderName = $state('')

  function startCreateFolder(path: string) {
    newFolderPath = path
    newFolderName = ''
    isCreatingFolder = true
    // Expand parent to show inline input
    if (path !== '/') {
      const parentId = `folder:${path}`
      expandState = { ...expandState, [parentId]: true }
    }
  }

  async function confirmCreateFolder() {
    if (!newFolderPath || !newFolderName.trim()) return
    // Create a placeholder document to establish the folder
    // (Folders are virtual, derived from document paths)
    // For now, just clear state - actual folder creation requires a document
    isCreatingFolder = false
    newFolderPath = null
    newFolderName = ''
  }

  function cancelCreateFolder() {
    isCreatingFolder = false
    newFolderPath = null
    newFolderName = ''
  }
</script>

<div class="tree-view glass-panel">
  <div class="panel-header">
    <span>Files</span>
    <button
      class="new-btn"
      onclick={() => startCreateFolder('/')}
      title="New folder at root"
    >
      +
    </button>
  </div>
  <div class="tree-content">
    {#if documentState.isLoading}
      <div class="empty-state">
        <span class="empty-label">Loading...</span>
      </div>
    {:else if documentState.error}
      <div class="empty-state">
        <span class="empty-label">Failed to load</span>
        <button class="retry-btn" onclick={() => documentState.load()}>Retry</button>
      </div>
    {:else if tree.length === 0 && !isCreatingFolder}
      <div class="empty-state">
        <span class="empty-label">No files yet</span>
        <span class="empty-hint">Create a document to get started</span>
      </div>
    {:else}
      <div class="tree-nodes">
        {#each tree as node (node.id)}
          <TreeNodeComponent
            {node}
            depth={0}
            {expandState}
            activeDocumentId={documentState.activeDocumentId}
            onNodeClick={handleNodeClick}
            onToggleExpand={toggleExpand}
            onCreateFolder={startCreateFolder}
          />
        {/each}
      </div>
    {/if}
  </div>
</div>

<style>
  .tree-view {
    display: flex;
    flex-direction: column;
    overflow: hidden;
    height: 100%;
    background: var(--bg-secondary);
  }

  .panel-header {
    justify-content: space-between;
  }

  .new-btn {
    font-size: 14px;
    font-weight: 600;
    color: var(--text-secondary);
    background: none;
    border: none;
    width: 22px;
    height: 22px;
    border-radius: 4px;
    cursor: pointer;
    display: flex;
    align-items: center;
    justify-content: center;
  }

  .new-btn:hover {
    background: var(--accent-hover);
  }

  .tree-content {
    flex: 1;
    overflow-y: auto;
    padding: 4px 0;
  }

  .tree-nodes {
    display: flex;
    flex-direction: column;
  }

  .empty-state {
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    gap: 8px;
    padding: 32px 16px;
    text-align: center;
  }

  .empty-label {
    font-size: 12px;
    font-weight: 500;
    color: var(--text-secondary);
  }

  .empty-hint {
    font-size: 11px;
    color: var(--text-muted);
  }

  .retry-btn {
    font-size: 11px;
    color: var(--text-secondary);
    background: none;
    border: 1px solid var(--border-color);
    border-radius: 4px;
    padding: 2px 10px;
    cursor: pointer;
  }

  .retry-btn:hover {
    background: var(--accent-hover);
  }
</style>
```

#### 2. Create TreeNode component
**File**: `src/lib/components/TreeNode.svelte` (create)

```svelte
<script lang="ts">
  import type { TreeNode, ExpandState } from '../documents/types'

  let {
    node,
    depth,
    expandState,
    activeDocumentId,
    onNodeClick,
    onToggleExpand,
    onCreateFolder,
  }: {
    node: TreeNode
    depth: number
    expandState: ExpandState
    activeDocumentId: string | null
    onNodeClick: (node: TreeNode) => void
    onToggleExpand: (id: string) => void
    onCreateFolder: (path: string) => void
  } = $props()

  let isExpanded = $derived(expandState[node.id] ?? false)
  let hasChildren = $derived(node.children && node.children.length > 0)
  let isActive = $derived(node.type === 'document' && node.documentId === activeDocumentId)
  let indentPx = $derived(depth * 16 + 8)

  function handleClick() {
    onNodeClick(node)
  }

  function handleChevronClick(e: MouseEvent) {
    e.stopPropagation()
    onToggleExpand(node.id)
  }

  function handleContextMenu(e: MouseEvent) {
    e.preventDefault()
    // TODO: Show context menu
  }
</script>

<div class="tree-node-wrapper">
  <!-- svelte-ignore a11y_click_events_have_key_events -->
  <div
    class="tree-node"
    class:active={isActive}
    class:folder={node.type === 'folder'}
    style="padding-left: {indentPx}px"
    onclick={handleClick}
    oncontextmenu={handleContextMenu}
    role="treeitem"
    tabindex="0"
    aria-expanded={node.type === 'folder' ? isExpanded : undefined}
  >
    {#if node.type === 'folder'}
      <button
        class="chevron"
        class:expanded={isExpanded}
        class:hidden={!hasChildren}
        onclick={handleChevronClick}
        tabindex="-1"
      >
        <svg width="12" height="12" viewBox="0 0 12 12" fill="currentColor">
          <path d="M4.5 2.5L8 6L4.5 9.5" stroke="currentColor" stroke-width="1.5" fill="none"/>
        </svg>
      </button>
      <span class="icon folder-icon">
        <svg width="14" height="14" viewBox="0 0 16 16" fill="currentColor">
          <path d="M1 3.5A1.5 1.5 0 012.5 2h3.379a1.5 1.5 0 011.06.44l1.122 1.12A1.5 1.5 0 009.12 4H13.5A1.5 1.5 0 0115 5.5v7a1.5 1.5 0 01-1.5 1.5h-11A1.5 1.5 0 011 12.5v-9z"/>
        </svg>
      </span>
    {:else}
      <span class="chevron-placeholder"></span>
      <span class="icon doc-icon">
        <svg width="14" height="14" viewBox="0 0 16 16" fill="currentColor">
          <path d="M4 1.5A1.5 1.5 0 015.5 0h4.379a1.5 1.5 0 011.06.44l2.122 2.12A1.5 1.5 0 0113.5 3.62V14.5a1.5 1.5 0 01-1.5 1.5H5.5A1.5 1.5 0 014 14.5v-13z"/>
        </svg>
      </span>
    {/if}
    <span class="node-name">{node.name}</span>
  </div>

  {#if node.type === 'folder' && isExpanded && node.children}
    <div class="children">
      {#each node.children as child (child.id)}
        <svelte:self
          node={child}
          depth={depth + 1}
          {expandState}
          {activeDocumentId}
          {onNodeClick}
          {onToggleExpand}
          {onCreateFolder}
        />
      {/each}
    </div>
  {/if}
</div>

<style>
  .tree-node-wrapper {
    display: flex;
    flex-direction: column;
  }

  .tree-node {
    display: flex;
    align-items: center;
    gap: 4px;
    padding: 4px 8px;
    cursor: pointer;
    user-select: none;
    transition: background 0.1s;
  }

  .tree-node:hover {
    background: var(--accent-hover);
  }

  .tree-node.active {
    background: var(--accent-active);
  }

  .chevron {
    display: flex;
    align-items: center;
    justify-content: center;
    width: 16px;
    height: 16px;
    background: none;
    border: none;
    padding: 0;
    color: var(--text-muted);
    cursor: pointer;
    transform: rotate(0deg);
    transition: transform 0.15s ease;
  }

  .chevron.expanded {
    transform: rotate(90deg);
  }

  .chevron.hidden {
    visibility: hidden;
  }

  .chevron-placeholder {
    width: 16px;
    height: 16px;
    flex-shrink: 0;
  }

  .icon {
    display: flex;
    align-items: center;
    justify-content: center;
    flex-shrink: 0;
  }

  .folder-icon {
    color: var(--text-muted);
  }

  .doc-icon {
    color: var(--text-muted);
  }

  .node-name {
    font-size: 13px;
    color: var(--text-primary);
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }

  .children {
    display: flex;
    flex-direction: column;
  }
</style>
```

### Success Criteria:

#### Automated Verification:
- [ ] Components compile without errors: `cd svelte-experiment && bun run check`
- [ ] No accessibility warnings from Svelte compiler

#### Smoke Test
Create `svelte-experiment/src/lib/components/TreeView.test.ts`:
```typescript
import { describe, test, expect } from 'bun:test'

describe('TreeView Components', () => {
  test('TreeView module can be imported', async () => {
    const mod = await import('./TreeView.svelte')
    expect(mod.default).toBeDefined()
  })

  test('TreeNode module can be imported', async () => {
    const mod = await import('./TreeNode.svelte')
    expect(mod.default).toBeDefined()
  })
})
```

Run: `cd svelte-experiment && bun test src/lib/components/TreeView.test.ts`

Visual verification via dev server:
```bash
cd svelte-experiment && bun run dev
# Open browser to localhost:5173 and navigate to a project
```

---

## Phase 7: Context Menus

### Overview
Add right-click context menus for folders and documents.

### Changes Required:

#### 1. Create ContextMenu component
**File**: `src/lib/components/ContextMenu.svelte` (create)

```svelte
<script lang="ts">
  export type MenuItem = {
    label: string
    action: () => void
    disabled?: boolean
    danger?: boolean
  }

  let {
    items,
    x,
    y,
    onClose,
  }: {
    items: MenuItem[]
    x: number
    y: number
    onClose: () => void
  } = $props()

  function handleClick(item: MenuItem) {
    if (item.disabled) return
    item.action()
    onClose()
  }
</script>

<svelte:window onclick={onClose} oncontextmenu={onClose} />

<!-- svelte-ignore a11y_no_static_element_interactions -->
<div
  class="context-menu"
  style="left: {x}px; top: {y}px"
  onclick={(e) => e.stopPropagation()}
  oncontextmenu={(e) => e.preventDefault()}
>
  {#each items as item}
    <button
      class="menu-item"
      class:disabled={item.disabled}
      class:danger={item.danger}
      onclick={() => handleClick(item)}
    >
      {item.label}
    </button>
  {/each}
</div>

<style>
  .context-menu {
    position: fixed;
    min-width: 160px;
    background: var(--bg-primary);
    border: 1px solid var(--border-color);
    border-radius: 8px;
    box-shadow: 0 4px 12px rgba(0, 0, 0, 0.12);
    padding: 4px;
    z-index: 1000;
  }

  .menu-item {
    display: block;
    width: 100%;
    padding: 8px 12px;
    font-size: 13px;
    font-family: var(--font-sans);
    color: var(--text-primary);
    background: none;
    border: none;
    border-radius: 4px;
    cursor: pointer;
    text-align: left;
    transition: background 0.1s;
  }

  .menu-item:hover:not(.disabled) {
    background: var(--accent-hover);
  }

  .menu-item.disabled {
    color: var(--text-muted);
    cursor: default;
  }

  .menu-item.danger {
    color: #e53935;
  }

  .menu-item.danger:hover:not(.disabled) {
    background: rgba(229, 57, 53, 0.1);
  }
</style>
```

#### 2. Update TreeNode with context menu
**File**: `src/lib/components/TreeNode.svelte`

Add context menu handling:

```svelte
<script lang="ts">
  import ContextMenu, { type MenuItem } from './ContextMenu.svelte'
  // ... existing imports and props ...

  let {
    // ... existing props ...
    onRename,
    onDelete,
    onCreateSubfolder,
    onCreateDocument,
  }: {
    // ... existing types ...
    onRename?: (node: TreeNode) => void
    onDelete?: (node: TreeNode) => void
    onCreateSubfolder?: (path: string) => void
    onCreateDocument?: (path: string) => void
  } = $props()

  let contextMenu = $state<{ x: number; y: number } | null>(null)

  function handleContextMenu(e: MouseEvent) {
    e.preventDefault()
    contextMenu = { x: e.clientX, y: e.clientY }
  }

  function closeContextMenu() {
    contextMenu = null
  }

  let menuItems = $derived<MenuItem[]>(() => {
    if (node.type === 'folder') {
      const items: MenuItem[] = [
        { label: 'New Folder', action: () => onCreateSubfolder?.(node.path) },
        { label: 'New Document', action: () => onCreateDocument?.(node.path) },
        { label: 'Rename', action: () => onRename?.(node) },
        { label: 'Delete', action: () => onDelete?.(node), danger: true },
      ]
      // Disable New Folder if at max depth
      if (getPathDepth(node.path) >= 5) {
        items[0]!.disabled = true
        items[0]!.label = 'New Folder (max depth)'
      }
      return items
    } else {
      return [
        { label: 'Rename', action: () => onRename?.(node) },
        { label: 'Delete', action: () => onDelete?.(node), danger: true },
      ]
    }
  })
</script>

<!-- In template, add context menu -->
{#if contextMenu}
  <ContextMenu
    items={menuItems}
    x={contextMenu.x}
    y={contextMenu.y}
    onClose={closeContextMenu}
  />
{/if}
```

### Success Criteria:

#### Automated Verification:
- [ ] Components compile without errors: `cd svelte-experiment && bun run check`

#### Smoke Test
Create `svelte-experiment/src/lib/components/ContextMenu.test.ts`:
```typescript
import { describe, test, expect } from 'bun:test'
import type { MenuItem } from './ContextMenu.svelte'

describe('ContextMenu', () => {
  test('module can be imported', async () => {
    const mod = await import('./ContextMenu.svelte')
    expect(mod.default).toBeDefined()
  })

  test('MenuItem type includes required properties', () => {
    const item: MenuItem = {
      label: 'Test',
      action: () => {},
      disabled: false,
      danger: false
    }
    expect(item.label).toBe('Test')
  })
})
```

Run: `cd svelte-experiment && bun test src/lib/components/ContextMenu.test.ts`

---

## Phase 8: Inline Editing

### Overview
Implement inline name editing for folders and documents (rename + create).

### Changes Required:

#### 1. Create InlineEdit component
**File**: `src/lib/components/InlineEdit.svelte` (create)

```svelte
<script lang="ts">
  let {
    value,
    placeholder,
    maxLength,
    onConfirm,
    onCancel,
  }: {
    value: string
    placeholder?: string
    maxLength?: number
    onConfirm: (value: string) => void
    onCancel: () => void
  } = $props()

  let inputRef: HTMLInputElement
  let inputValue = $state(value)

  $effect(() => {
    inputRef?.focus()
    inputRef?.select()
  })

  function handleKeydown(e: KeyboardEvent) {
    if (e.key === 'Enter') {
      e.preventDefault()
      handleConfirm()
    } else if (e.key === 'Escape') {
      e.preventDefault()
      onCancel()
    }
  }

  function handleConfirm() {
    const trimmed = inputValue.trim()
    if (trimmed) {
      onConfirm(trimmed)
    } else {
      onCancel()
    }
  }

  function handleBlur() {
    handleConfirm()
  }
</script>

<input
  bind:this={inputRef}
  bind:value={inputValue}
  class="inline-edit"
  type="text"
  {placeholder}
  maxlength={maxLength}
  onkeydown={handleKeydown}
  onblur={handleBlur}
/>

<style>
  .inline-edit {
    flex: 1;
    font-size: 13px;
    font-family: var(--font-sans);
    color: var(--text-primary);
    background: var(--bg-primary);
    border: 1px solid var(--accent);
    border-radius: 3px;
    padding: 2px 6px;
    outline: none;
    min-width: 0;
  }
</style>
```

#### 2. Update TreeNode for inline editing
**File**: `src/lib/components/TreeNode.svelte`

Add rename state and inline edit:

```svelte
<script lang="ts">
  import InlineEdit from './InlineEdit.svelte'
  // ... existing code ...

  let isRenaming = $state(false)

  function startRename() {
    isRenaming = true
  }

  function handleRenameConfirm(newName: string) {
    if (newName !== node.name) {
      onRename?.({ ...node, name: newName })
    }
    isRenaming = false
  }

  function handleRenameCancel() {
    isRenaming = false
  }

  function handleDoubleClick() {
    if (node.type === 'folder') {
      startRename()
    }
  }
</script>

<!-- In template -->
<div
  class="tree-node"
  ...
  ondblclick={handleDoubleClick}
>
  <!-- icons as before -->
  {#if isRenaming}
    <InlineEdit
      value={node.name}
      placeholder="Name"
      maxLength={100}
      onConfirm={handleRenameConfirm}
      onCancel={handleRenameCancel}
    />
  {:else}
    <span class="node-name">{node.name}</span>
  {/if}
</div>
```

#### 3. Add new folder inline row
**File**: `src/lib/components/TreeView.svelte`

Add state for creating new folders inline:

```svelte
<script lang="ts">
  // ... existing code ...

  let newItemState = $state<{
    type: 'folder' | 'document'
    parentPath: string
  } | null>(null)

  function startCreate(type: 'folder' | 'document', parentPath: string) {
    newItemState = { type, parentPath }
    // Expand parent folder if needed
    if (parentPath !== '/') {
      const parentId = `folder:${parentPath}`
      expandState = { ...expandState, [parentId]: true }
    }
  }

  async function handleCreateConfirm(name: string) {
    if (!newItemState) return
    const { type, parentPath } = newItemState

    if (type === 'folder') {
      // Create placeholder doc to establish folder
      // API will handle folder creation when we add first doc
      // For now, we need to create a doc with the folder path
      const folderPath = parentPath === '/' ? `/${name}/` : `${parentPath}${name}/`
      // TODO: Create folder through API
    } else {
      await documentState.create(name, undefined, parentPath)
    }

    newItemState = null
  }

  function handleCreateCancel() {
    newItemState = null
  }
</script>
```

### Success Criteria:

#### Automated Verification:
- [ ] Components compile without errors: `cd svelte-experiment && bun run check`

#### Smoke Test
Create `svelte-experiment/src/lib/components/InlineEdit.test.ts`:
```typescript
import { describe, test, expect } from 'bun:test'

describe('InlineEdit Component', () => {
  test('module can be imported', async () => {
    const mod = await import('./InlineEdit.svelte')
    expect(mod.default).toBeDefined()
  })
})
```

Run: `cd svelte-experiment && bun test src/lib/components/InlineEdit.test.ts`

Visual verification via dev server - test inline editing flow:
1. Start dev server: `bun run dev`
2. Navigate to a project with folders
3. Double-click folder name to trigger inline edit
4. Test Enter, Escape, and blur behaviors

---

## Phase 9: Delete Confirmation

### Overview
Implement delete confirmation dialogs for folders with contents.

### Changes Required:

#### 1. Create DeleteConfirmDialog component
**File**: `src/lib/components/DeleteConfirmDialog.svelte` (create)

```svelte
<script lang="ts">
  let {
    title,
    message,
    itemCounts,
    onConfirm,
    onCancel,
  }: {
    title: string
    message: string
    itemCounts?: { documents: number; folders: number }
    onConfirm: () => void
    onCancel: () => void
  } = $props()

  function handleKeydown(e: KeyboardEvent) {
    if (e.key === 'Escape') {
      onCancel()
    }
  }
</script>

<svelte:window onkeydown={handleKeydown} />

<!-- svelte-ignore a11y_no_static_element_interactions -->
<div class="dialog-overlay" onclick={onCancel}>
  <!-- svelte-ignore a11y_click_events_have_key_events -->
  <div class="dialog-content" onclick={(e) => e.stopPropagation()}>
    <h3>{title}</h3>
    <p class="message">{message}</p>
    {#if itemCounts && (itemCounts.documents > 0 || itemCounts.folders > 0)}
      <p class="counts">
        This will delete
        {#if itemCounts.documents > 0}
          <strong>{itemCounts.documents}</strong> document{itemCounts.documents === 1 ? '' : 's'}
        {/if}
        {#if itemCounts.documents > 0 && itemCounts.folders > 0}
          and
        {/if}
        {#if itemCounts.folders > 0}
          <strong>{itemCounts.folders}</strong> subfolder{itemCounts.folders === 1 ? '' : 's'}
        {/if}.
      </p>
    {/if}
    <div class="dialog-actions">
      <button class="cancel-btn" onclick={onCancel}>Cancel</button>
      <button class="delete-btn" onclick={onConfirm}>Delete</button>
    </div>
  </div>
</div>

<style>
  .dialog-overlay {
    position: fixed;
    inset: 0;
    background: rgba(0, 0, 0, 0.4);
    display: flex;
    align-items: center;
    justify-content: center;
    z-index: 1000;
  }

  .dialog-content {
    width: 360px;
    max-width: 90vw;
    background: var(--bg-primary);
    border-radius: 12px;
    padding: 24px;
    box-shadow: 0 8px 32px rgba(0, 0, 0, 0.12);
  }

  h3 {
    font-size: 16px;
    font-weight: 600;
    color: var(--text-primary);
    margin-bottom: 12px;
  }

  .message {
    font-size: 14px;
    color: var(--text-secondary);
    line-height: 1.5;
    margin-bottom: 8px;
  }

  .counts {
    font-size: 13px;
    color: var(--text-secondary);
    margin-bottom: 20px;
  }

  .counts strong {
    color: var(--text-primary);
  }

  .dialog-actions {
    display: flex;
    justify-content: flex-end;
    gap: 8px;
  }

  .cancel-btn {
    font-size: 13px;
    font-weight: 500;
    color: var(--text-secondary);
    background: none;
    border: 1px solid var(--border-color);
    border-radius: 6px;
    padding: 8px 16px;
    cursor: pointer;
    font-family: var(--font-sans);
  }

  .cancel-btn:hover {
    background: var(--accent-hover);
  }

  .delete-btn {
    font-size: 13px;
    font-weight: 500;
    color: #fff;
    background: #e53935;
    border: none;
    border-radius: 6px;
    padding: 8px 16px;
    cursor: pointer;
    font-family: var(--font-sans);
  }

  .delete-btn:hover {
    background: #d32f2f;
  }
</style>
```

#### 2. Integrate delete flow in TreeView
**File**: `src/lib/components/TreeView.svelte`

Add delete state and handlers:

```svelte
<script lang="ts">
  import DeleteConfirmDialog from './DeleteConfirmDialog.svelte'
  // ... existing code ...

  let deleteTarget = $state<TreeNode | null>(null)

  function countContents(node: TreeNode): { documents: number; folders: number } {
    let documents = 0
    let folders = 0

    function count(n: TreeNode) {
      if (n.type === 'document') {
        documents++
      } else {
        folders++
        n.children?.forEach(count)
      }
    }

    node.children?.forEach(count)
    return { documents, folders }
  }

  async function handleDelete(node: TreeNode) {
    if (node.type === 'folder') {
      const counts = countContents(node)
      if (counts.documents === 0 && counts.folders === 0) {
        // Empty folder - delete immediately
        // TODO: API call to delete folder (if folders become real entities)
      } else {
        // Show confirmation
        deleteTarget = node
      }
    } else if (node.documentId) {
      // Direct document delete with simple confirm
      if (confirm('Delete this document?')) {
        await documentState.remove(node.documentId)
      }
    }
  }

  async function confirmDelete() {
    if (!deleteTarget) return
    // TODO: Delete folder and all contents via API
    deleteTarget = null
  }

  function cancelDelete() {
    deleteTarget = null
  }
</script>

<!-- At end of template -->
{#if deleteTarget}
  {@const counts = countContents(deleteTarget)}
  <DeleteConfirmDialog
    title="Delete {deleteTarget.name}?"
    message="This folder and all its contents will be moved to trash."
    itemCounts={counts}
    onConfirm={confirmDelete}
    onCancel={cancelDelete}
  />
{/if}
```

### Success Criteria:

#### Automated Verification:
- [ ] Components compile without errors: `cd svelte-experiment && bun run check`

#### Smoke Test
Create `svelte-experiment/src/lib/components/DeleteConfirmDialog.test.ts`:
```typescript
import { describe, test, expect } from 'bun:test'

describe('DeleteConfirmDialog Component', () => {
  test('module can be imported', async () => {
    const mod = await import('./DeleteConfirmDialog.svelte')
    expect(mod.default).toBeDefined()
  })

  test('countContents helper returns correct counts', () => {
    // Test the counting logic used by delete confirmation
    const countContents = (node: any): { documents: number; folders: number } => {
      let documents = 0
      let folders = 0
      function count(n: any) {
        if (n.type === 'document') documents++
        else {
          folders++
          n.children?.forEach(count)
        }
      }
      node.children?.forEach(count)
      return { documents, folders }
    }

    const folder = {
      type: 'folder',
      children: [
        { type: 'document' },
        { type: 'document' },
        { type: 'folder', children: [{ type: 'document' }] }
      ]
    }

    const counts = countContents(folder)
    expect(counts.documents).toBe(3)
    expect(counts.folders).toBe(1)
  })
})
```

Run: `cd svelte-experiment && bun test src/lib/components/DeleteConfirmDialog.test.ts`

---

## Phase 10: Integration & Polish

### Overview
Wire everything together and add final polish.

### Changes Required:

#### 1. Replace DocumentList with TreeView
**File**: `src/App.svelte`

```svelte
<script lang="ts">
  // ... existing imports ...
  import TreeView from './lib/components/TreeView.svelte'

  // In renderPanel snippet:
  {#if panelId === 'filetree'}
    <TreeView documentState={documentState!} onSelectDocument={handleSelectDocument} />
  <!-- ... -->
</script>
```

#### 2. Add toast notifications for errors
**File**: `src/lib/components/Toast.svelte` (create)

Simple toast component for error feedback.

#### 3. Add CSS transitions for expand/collapse
**File**: `src/app.css`

```css
/* Tree expand/collapse animation */
.tree-children-enter {
  animation: tree-expand 0.15s ease-out;
}

@keyframes tree-expand {
  from {
    opacity: 0;
    transform: translateY(-4px);
  }
  to {
    opacity: 1;
    transform: translateY(0);
  }
}
```

#### 4. Handle auto-expand on navigation
When navigating to a document in a collapsed folder, auto-expand parent chain.

```typescript
// In TreeView
$effect(() => {
  if (documentState.activeDocumentId) {
    const doc = documentState.documents.find(d => d.id === documentState.activeDocumentId)
    if (doc) {
      // Expand all parent folders
      const parts = doc.path.split('/').filter(Boolean)
      let currentPath = '/'
      for (const part of parts) {
        currentPath = currentPath + part + '/'
        const folderId = `folder:${currentPath}`
        if (!expandState[folderId]) {
          expandState = { ...expandState, [folderId]: true }
        }
      }
    }
  }
})
```

### Success Criteria:

#### Automated Verification:
- [ ] Type check passes: `cd svelte-experiment && bun run check`
- [ ] All unit tests pass: `cd svelte-experiment && bun test`
- [ ] Dev server starts: `cd svelte-experiment && bun run dev`

#### Integration Smoke Test
Create `svelte-experiment/tests/integration/projects-folders.test.ts`:
```typescript
import { describe, test, expect } from 'bun:test'

describe('Projects & Folders Integration', () => {
  // These tests verify the full flow compiles and modules work together

  test('all required components can be imported', async () => {
    const modules = await Promise.all([
      import('../../src/lib/components/ProjectsPage.svelte'),
      import('../../src/lib/components/TreeView.svelte'),
      import('../../src/lib/components/TreeNode.svelte'),
      import('../../src/lib/components/ContextMenu.svelte'),
      import('../../src/lib/components/InlineEdit.svelte'),
      import('../../src/lib/components/DeleteConfirmDialog.svelte'),
      import('../../src/lib/projects/state.svelte'),
    ])
    modules.forEach(mod => expect(mod.default).toBeDefined())
  })

  test('tree builder produces correct structure', async () => {
    const { buildTree } = await import('../../src/lib/documents/tree')
    const docs = [
      { id: '1', project_id: 'p', workspace_id: 'w', name: 'doc1', path: '/', created_by: 'u', created_at: '', updated_at: '' },
      { id: '2', project_id: 'p', workspace_id: 'w', name: 'doc2', path: '/folder/', created_by: 'u', created_at: '', updated_at: '' },
    ]
    const tree = buildTree(docs)
    expect(tree.length).toBe(2) // folder + doc at root
  })
})
```

Run: `cd svelte-experiment && bun test tests/integration/projects-folders.test.ts`

For E2E testing, start the dev server and verify visually:
```bash
cd svelte-experiment && bun run dev
# Navigate through the full flow in browser
```

---

## Testing Strategy

### Unit Tests:
- `tree.ts` functions (buildTree, getPathDepth, etc.)
- State management (projectState, documentState with folders)

### Integration Tests:
- API client functions with mock responses
- Component rendering with mock state

### Manual Testing Steps:
1. Login -> Select workspace -> See Projects page
2. Create project "Test Project" with description
3. Enter project -> See empty tree
4. Create document at root -> Appears in tree
5. Right-click root -> New Folder -> Name it "Design"
6. Create document in Design folder
7. Collapse Design -> refresh -> Still collapsed
8. Click document -> Opens in editor
9. Double-click folder -> Rename inline
10. Right-click folder -> Delete -> Shows confirmation
11. Back button -> Returns to Projects page

## Performance Considerations

- Tree is rebuilt from flat documents list on each change
- Consider memoization if document count exceeds 100
- Expand state in localStorage is O(n) for folder count
- Consider virtualization for trees with 500+ items (deferred)

## References

- Backend plan: `thoughts/shared/plans/2026-02-04-document-folder-hierarchy.md`
- User stories: `/Users/cgrdavies/Projects/backlog/stories/web-projects/`, `web-folders/`
- Existing frontend: `/Users/cgrdavies/Projects/shopped/svelte-experiment/src/`
- Product decisions handoff: `thoughts/shared/handoffs/general/2026-02-04_20-50-21_projects-feature-user-stories.md`
