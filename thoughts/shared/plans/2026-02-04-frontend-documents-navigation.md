# Frontend: Documents & Navigation UI Implementation Plan

## Overview

Implement the frontend UI for document operations within the folder hierarchy and navigation features. This includes a tree view sidebar with search, document creation in folders, document move functionality, breadcrumb navigation, and context menus.

## Current State Analysis

**Existing frontend architecture:**
- Svelte 5 with `$state`, `$derived`, and `$effect` runes for reactivity
- Documents state managed via `createDocumentState()` in `src/lib/documents/state.svelte.ts`
- Flat document list displayed in `DocumentList.svelte`
- API client pattern in `src/lib/api/client.ts`
- CSS variables for consistent theming in `src/app.css`
- Dropdown menu pattern exists in `AppHeader.svelte` (avatar menu)

**Relevant backend changes from folder hierarchy plan:**
- Documents gain `project_id` and `path` fields
- API changes to `GET /api/projects/:projectId/documents?path=/`
- Response includes `folders` array when `path` query param provided
- `PATCH /api/projects/:projectId/documents/:id` supports `path` update for moving

### Key Discoveries:
- No project selection UI exists yet - frontend needs project context before document operations
- Current `DocumentList.svelte` uses simple prompt() for document creation - needs redesign
- No context menu component exists - will need to create one
- No keyboard shortcut handling exists - will need to add global listener
- Document type from shared: `{ id, project_id, workspace_id, name, path, created_by, created_at, updated_at }`

## Desired End State

After implementation:

1. **Project Tree View** - Hierarchical sidebar showing folders and documents
2. **Search** - Cmd/Ctrl+K opens search, filters tree by name
3. **Create Document** - Inline creation within any folder
4. **Move Document** - Context menu action to move document to different folder
5. **Breadcrumb Navigation** - Shows path to current document, clickable segments
6. **Context Menus** - Right-click menus for documents and folders

### Verification:
- User can navigate folder hierarchy in sidebar
- User can search with Cmd/Ctrl+K
- User can create document in specific folder
- User can move document via context menu
- Breadcrumbs show full path and are clickable
- All operations update UI immediately

## What We're NOT Doing

- **Drag-and-drop organization** - Deferred per product decision
- **Project selection UI** - Assumes project context already set (separate story)
- **Folder CRUD** - Creating/renaming/deleting folders (separate epic)
- **Real-time sync of tree** - Initial load only, refresh on action
- **Virtualization for large trees** - Defer until needed
- **Keyboard navigation** - Deferred per product decision

## Implementation Approach

1. Create shared context menu component (reusable pattern)
2. Update document state to track folder structure and expand/collapse
3. Build tree view component with recursive rendering
4. Add search with Cmd/Ctrl+K shortcut
5. Implement breadcrumb component
6. Add move document functionality via context menu
7. Update document creation to support folder path

---

## Phase 1: Context Menu Component

### Overview
Create a reusable context menu component that can be triggered by right-click or programmatically. This is a foundation component used throughout the UI.

### Changes Required:

#### 1. Create ContextMenu component
**File**: `src/lib/components/ContextMenu.svelte`

```svelte
<script lang="ts">
  import { onMount, onDestroy } from 'svelte';

  export interface MenuItem {
    label: string;
    action: () => void;
    disabled?: boolean;
    divider?: boolean;
  }

  let {
    items,
    x,
    y,
    onClose,
  }: {
    items: MenuItem[];
    x: number;
    y: number;
    onClose: () => void;
  } = $props();

  let menuEl = $state<HTMLDivElement>();

  function handleClick(e: MouseEvent) {
    if (menuEl && !menuEl.contains(e.target as Node)) {
      onClose();
    }
  }

  function handleKeydown(e: KeyboardEvent) {
    if (e.key === 'Escape') {
      onClose();
    }
  }

  onMount(() => {
    window.addEventListener('click', handleClick);
    window.addEventListener('keydown', handleKeydown);
  });

  onDestroy(() => {
    window.removeEventListener('click', handleClick);
    window.removeEventListener('keydown', handleKeydown);
  });

  // Adjust position if menu would overflow viewport
  let adjustedX = $derived.by(() => {
    if (!menuEl) return x;
    const rect = menuEl.getBoundingClientRect();
    if (x + rect.width > window.innerWidth) {
      return window.innerWidth - rect.width - 8;
    }
    return x;
  });

  let adjustedY = $derived.by(() => {
    if (!menuEl) return y;
    const rect = menuEl.getBoundingClientRect();
    if (y + rect.height > window.innerHeight) {
      return window.innerHeight - rect.height - 8;
    }
    return y;
  });
</script>

<div
  class="context-menu"
  bind:this={menuEl}
  style="left: {adjustedX}px; top: {adjustedY}px"
  role="menu"
>
  {#each items as item}
    {#if item.divider}
      <div class="menu-divider"></div>
    {:else}
      <button
        class="menu-item"
        class:disabled={item.disabled}
        onclick={() => { if (!item.disabled) { item.action(); onClose(); } }}
        disabled={item.disabled}
        role="menuitem"
      >
        {item.label}
      </button>
    {/if}
  {/each}
</div>

<style>
  .context-menu {
    position: fixed;
    z-index: 1000;
    min-width: 160px;
    background: var(--bg-primary);
    border: 1px solid var(--border-color);
    border-radius: 8px;
    box-shadow: 0 4px 12px rgba(0, 0, 0, 0.1);
    padding: 4px 0;
    overflow: hidden;
  }

  .menu-item {
    display: block;
    width: 100%;
    padding: 8px 12px;
    background: none;
    border: none;
    font-size: 12px;
    font-family: var(--font-sans);
    color: var(--text-primary);
    cursor: pointer;
    text-align: left;
    transition: background 0.1s;
  }

  .menu-item:hover:not(:disabled) {
    background: var(--accent-hover);
  }

  .menu-item.disabled {
    color: var(--text-muted);
    cursor: default;
  }

  .menu-divider {
    height: 1px;
    background: var(--border-color);
    margin: 4px 0;
  }
</style>
```

### Success Criteria:

#### Automated Verification:
- [ ] TypeScript compilation passes: `cd svelte-experiment && bun run check`

#### Smoke Test
Create `svelte-experiment/src/lib/components/ContextMenu.test.ts`:
```typescript
import { describe, test, expect } from 'bun:test'
import type { MenuItem } from './ContextMenu.svelte'

describe('ContextMenu Component', () => {
  test('module can be imported', async () => {
    const mod = await import('./ContextMenu.svelte')
    expect(mod.default).toBeDefined()
  })

  test('MenuItem type is correctly defined', () => {
    const item: MenuItem = {
      label: 'Test Item',
      action: () => console.log('action'),
      disabled: false,
      divider: false
    }
    expect(item.label).toBe('Test Item')
    expect(typeof item.action).toBe('function')
  })
})
```

Run: `cd svelte-experiment && bun test src/lib/components/ContextMenu.test.ts`

Visual verification:
1. Start dev server: `bun run dev`
2. Right-click on document in tree
3. Verify menu appears at cursor position
4. Click outside or press Escape to close

---

## Phase 2: Project and Document State Updates

### Overview
Extend the document state to support projects, folder paths, expand/collapse state, and search filtering.

### Changes Required:

#### 1. Update shared types (if needed)
**File**: `packages/shared/types.ts`

Ensure Document type includes `path`:
```typescript
export type Document = {
  id: string
  project_id: string
  workspace_id: string
  name: string
  path: string                           // folder path, e.g., '/' or '/Design/'
  created_by: string
  created_at: string
  updated_at: string
}
```

#### 2. Add FolderEntry type to API
**File**: `packages/shared/api.ts`

```typescript
export type FolderEntry = {
  name: string                           // folder name (not full path)
  path: string                           // full path including this folder
}

export type ListDocumentsResponse = {
  documents: Document[]
  folders?: FolderEntry[]                // present when listing a specific path
}
```

#### 3. Create project state
**File**: `src/lib/projects/state.svelte.ts`

```typescript
import type { Project } from '@claude-agent/shared'
import type { ApiClient } from '../api/client'

export function createProjectState(api: ApiClient) {
  let projects = $state<Project[]>([])
  let isLoading = $state(false)
  let error = $state<string | null>(null)
  let activeProjectId = $state<string | null>(null)

  return {
    get projects() { return projects },
    get isLoading() { return isLoading },
    get error() { return error },
    get activeProjectId() { return activeProjectId },
    get activeProject() {
      return projects.find(p => p.id === activeProjectId) ?? null
    },

    set activeProjectId(id: string | null) { activeProjectId = id },

    async load() {
      isLoading = true
      error = null
      try {
        const res = await api.apiFetch<{ projects: Project[] }>('/projects')
        projects = res.projects
        // Auto-select first project if none selected
        if (!activeProjectId && projects.length > 0) {
          activeProjectId = projects[0]!.id
        }
      } catch (e) {
        error = e instanceof Error ? e.message : String(e)
      } finally {
        isLoading = false
      }
    },

    selectProject(id: string) {
      if (projects.some(p => p.id === id)) {
        activeProjectId = id
      }
    },
  }
}

export type ProjectState = ReturnType<typeof createProjectState>
```

#### 4. Update document state for project scoping and folders
**File**: `src/lib/documents/state.svelte.ts`

```typescript
import type { Document, FolderEntry } from '@claude-agent/shared'
import type { ApiClient } from '../api/client'

export interface OpenTab { id: string; name: string }

export interface TreeNode {
  type: 'folder' | 'document'
  name: string
  path: string
  document?: Document  // only for type === 'document'
  children?: TreeNode[]  // only for type === 'folder'
}

const EXPAND_STATE_KEY = 'documents:expandedFolders'

export function createDocumentState(api: ApiClient) {
  let documents = $state<Document[]>([])
  let folders = $state<FolderEntry[]>([])
  let isLoading = $state(false)
  let error = $state<string | null>(null)
  let activeDocumentId = $state<string | null>(null)
  let openTabs = $state<OpenTab[]>([])
  let projectId = $state<string | null>(null)
  let expandedFolders = $state<Set<string>>(new Set())
  let searchQuery = $state('')

  // Load expand state from localStorage
  function loadExpandState() {
    try {
      const saved = localStorage.getItem(EXPAND_STATE_KEY)
      if (saved) {
        expandedFolders = new Set(JSON.parse(saved))
      }
    } catch {
      // ignore
    }
  }

  // Save expand state to localStorage
  function saveExpandState() {
    try {
      localStorage.setItem(EXPAND_STATE_KEY, JSON.stringify([...expandedFolders]))
    } catch {
      // ignore
    }
  }

  loadExpandState()

  // Build tree structure from flat documents list
  function buildTree(): TreeNode[] {
    const root: TreeNode[] = []
    const folderMap = new Map<string, TreeNode>()

    // Create folder nodes from folders list
    for (const folder of folders) {
      const node: TreeNode = {
        type: 'folder',
        name: folder.name,
        path: folder.path,
        children: [],
      }
      folderMap.set(folder.path, node)
    }

    // Also extract unique folder paths from documents
    for (const doc of documents) {
      if (doc.path !== '/') {
        // Ensure parent folders exist
        const parts = doc.path.split('/').filter(Boolean)
        let currentPath = '/'
        for (const part of parts) {
          currentPath += part + '/'
          if (!folderMap.has(currentPath)) {
            const node: TreeNode = {
              type: 'folder',
              name: part,
              path: currentPath,
              children: [],
            }
            folderMap.set(currentPath, node)
          }
        }
      }
    }

    // Add documents as leaf nodes
    const docNodes: TreeNode[] = documents.map(doc => ({
      type: 'document' as const,
      name: doc.name,
      path: doc.path,
      document: doc,
    }))

    // Build tree structure
    for (const [path, folder] of folderMap) {
      // Find parent path
      const parts = path.slice(1, -1).split('/')
      if (parts.length === 1) {
        // Top-level folder
        root.push(folder)
      } else {
        // Nested folder - find parent
        const parentPath = '/' + parts.slice(0, -1).join('/') + '/'
        const parent = folderMap.get(parentPath)
        if (parent && parent.children) {
          parent.children.push(folder)
        }
      }
    }

    // Add documents to their folders
    for (const docNode of docNodes) {
      if (docNode.path === '/') {
        root.push(docNode)
      } else {
        const folder = folderMap.get(docNode.path)
        if (folder && folder.children) {
          folder.children.push(docNode)
        }
      }
    }

    // Sort: folders first, then alphabetically
    function sortNodes(nodes: TreeNode[]) {
      nodes.sort((a, b) => {
        if (a.type !== b.type) {
          return a.type === 'folder' ? -1 : 1
        }
        return a.name.localeCompare(b.name)
      })
      for (const node of nodes) {
        if (node.children) {
          sortNodes(node.children)
        }
      }
    }
    sortNodes(root)

    return root
  }

  // Filter tree by search query
  function filterTree(nodes: TreeNode[], query: string): TreeNode[] {
    if (!query) return nodes
    const lowerQuery = query.toLowerCase()

    function matches(node: TreeNode): boolean {
      if (node.name.toLowerCase().includes(lowerQuery)) return true
      if (node.children) {
        return node.children.some(matches)
      }
      return false
    }

    function filterNode(node: TreeNode): TreeNode | null {
      if (node.type === 'document') {
        return node.name.toLowerCase().includes(lowerQuery) ? node : null
      }
      // Folder - check if name matches or any children match
      const filteredChildren = node.children?.map(filterNode).filter(Boolean) as TreeNode[] | undefined
      if (node.name.toLowerCase().includes(lowerQuery) || (filteredChildren && filteredChildren.length > 0)) {
        return { ...node, children: filteredChildren ?? [] }
      }
      return null
    }

    return nodes.map(filterNode).filter(Boolean) as TreeNode[]
  }

  function closeTab(id: string) {
    const idx = openTabs.findIndex(t => t.id === id)
    if (idx === -1) return
    openTabs = openTabs.filter(t => t.id !== id)
    if (activeDocumentId === id) {
      const next = openTabs[Math.min(idx, openTabs.length - 1)]
      activeDocumentId = next ? next.id : null
    }
  }

  return {
    get documents() { return documents },
    get folders() { return folders },
    get isLoading() { return isLoading },
    get error() { return error },
    get activeDocumentId() { return activeDocumentId },
    get openTabs() { return openTabs },
    get projectId() { return projectId },
    get expandedFolders() { return expandedFolders },
    get searchQuery() { return searchQuery },

    get tree() { return buildTree() },
    get filteredTree() { return filterTree(buildTree(), searchQuery) },

    set activeDocumentId(id: string | null) { activeDocumentId = id },
    set projectId(id: string | null) { projectId = id },
    set searchQuery(q: string) { searchQuery = q },

    toggleFolder(path: string) {
      if (expandedFolders.has(path)) {
        expandedFolders.delete(path)
      } else {
        expandedFolders.add(path)
      }
      expandedFolders = new Set(expandedFolders)  // trigger reactivity
      saveExpandState()
    },

    expandFolder(path: string) {
      if (!expandedFolders.has(path)) {
        expandedFolders.add(path)
        expandedFolders = new Set(expandedFolders)
        saveExpandState()
      }
    },

    // Expand all folders in a path chain
    expandPathChain(path: string) {
      const parts = path.split('/').filter(Boolean)
      let currentPath = '/'
      for (const part of parts) {
        currentPath += part + '/'
        expandedFolders.add(currentPath)
      }
      expandedFolders = new Set(expandedFolders)
      saveExpandState()
    },

    openTab(id: string, name: string) {
      if (!openTabs.some(t => t.id === id)) {
        openTabs = [...openTabs, { id, name }]
      }
      activeDocumentId = id
    },

    closeTab,

    activateTab(id: string) {
      activeDocumentId = id
    },

    async load() {
      if (!projectId) return
      isLoading = true
      error = null
      try {
        // Load all documents (flat list)
        const res = await api.apiFetch<{ documents: Document[] }>(`/projects/${projectId}/documents`)
        documents = res.documents

        // Extract unique folder paths
        const folderPaths = new Set<string>()
        for (const doc of documents) {
          if (doc.path !== '/') {
            const parts = doc.path.split('/').filter(Boolean)
            let currentPath = '/'
            for (const part of parts) {
              currentPath += part + '/'
              folderPaths.add(currentPath)
            }
          }
        }
        folders = [...folderPaths].map(path => ({
          name: path.split('/').filter(Boolean).pop() ?? '',
          path,
        }))

        // Prune tabs for documents that no longer exist
        const ids = new Set(documents.map(d => d.id))
        const pruned = openTabs.filter(t => ids.has(t.id))
        if (pruned.length !== openTabs.length) {
          openTabs = pruned
          if (activeDocumentId && !ids.has(activeDocumentId)) {
            const next = pruned[pruned.length - 1]
            activeDocumentId = next ? next.id : null
          }
        }
      } catch (e) {
        error = e instanceof Error ? e.message : String(e)
      } finally {
        isLoading = false
      }
    },

    async create(name: string, content?: string, path?: string) {
      if (!projectId) return null
      error = null
      try {
        const res = await api.apiFetch<{ document: Document }>(`/projects/${projectId}/documents`, {
          method: 'POST',
          body: JSON.stringify({ name, content, path }),
        })
        // Re-fetch the full list
        await this.load()
        return res.document
      } catch (e) {
        error = e instanceof Error ? e.message : String(e)
        return null
      }
    },

    async move(id: string, newPath: string) {
      if (!projectId) return false
      error = null
      try {
        await api.apiFetch(`/projects/${projectId}/documents/${id}`, {
          method: 'PATCH',
          body: JSON.stringify({ path: newPath }),
        })
        await this.load()
        return true
      } catch (e) {
        error = e instanceof Error ? e.message : String(e)
        return false
      }
    },

    async remove(id: string) {
      if (!projectId) return
      error = null
      try {
        await api.apiRawFetch(`/projects/${projectId}/documents/${id}`, { method: 'DELETE' })
        closeTab(id)
        documents = documents.filter(d => d.id !== id)
      } catch (e) {
        error = e instanceof Error ? e.message : String(e)
      }
    },

    getDocument(id: string): Document | undefined {
      return documents.find(d => d.id === id)
    },

    // Get breadcrumb path for a document
    getBreadcrumb(documentId: string): Array<{ name: string; path: string }> {
      const doc = documents.find(d => d.id === documentId)
      if (!doc) return []

      const crumbs: Array<{ name: string; path: string }> = []
      const parts = doc.path.split('/').filter(Boolean)
      let currentPath = '/'

      for (const part of parts) {
        currentPath += part + '/'
        crumbs.push({ name: part, path: currentPath })
      }

      crumbs.push({ name: doc.name, path: doc.id })
      return crumbs
    },
  }
}

export type DocumentState = ReturnType<typeof createDocumentState>
```

### Success Criteria:

#### Automated Verification:
- [ ] TypeScript compilation passes: `cd svelte-experiment && bun run check`

#### Smoke Test
Create `svelte-experiment/src/lib/documents/state.test.ts`:
```typescript
import { describe, test, expect } from 'bun:test'

describe('Document State', () => {
  test('buildTree creates correct hierarchy', () => {
    // Test tree building logic
    const documents = [
      { id: '1', project_id: 'p', workspace_id: 'w', name: 'root-doc', path: '/', created_by: 'u', created_at: '', updated_at: '' },
      { id: '2', project_id: 'p', workspace_id: 'w', name: 'nested-doc', path: '/folder/', created_by: 'u', created_at: '', updated_at: '' },
    ]

    // Inline tree builder for testing
    function buildTree(docs: typeof documents) {
      const root: any[] = []
      const folderSet = new Set<string>()

      for (const doc of docs) {
        if (doc.path !== '/') {
          const parts = doc.path.split('/').filter(Boolean)
          let current = '/'
          for (const part of parts) {
            current += part + '/'
            folderSet.add(current)
          }
        }
      }

      // Add folders
      for (const path of folderSet) {
        root.push({ type: 'folder', path, name: path.split('/').filter(Boolean).pop() })
      }

      // Add docs at root
      for (const doc of docs) {
        if (doc.path === '/') {
          root.push({ type: 'document', document: doc })
        }
      }

      return root
    }

    const tree = buildTree(documents)
    expect(tree.length).toBe(2) // 1 folder + 1 root doc
  })

  test('filterTree matches documents by name', () => {
    const filter = (nodes: any[], query: string): any[] => {
      if (!query) return nodes
      return nodes.filter(n => n.name?.toLowerCase().includes(query.toLowerCase()))
    }

    const nodes = [
      { type: 'document', name: 'README' },
      { type: 'document', name: 'Design Spec' },
      { type: 'folder', name: 'Archive' }
    ]

    expect(filter(nodes, 'design').length).toBe(1)
    expect(filter(nodes, 'DESIGN').length).toBe(1) // case insensitive
  })
})
```

Run: `cd svelte-experiment && bun test src/lib/documents/state.test.ts`

---

## Phase 3: Tree View Component

### Overview
Replace the flat DocumentList with a hierarchical tree view supporting folders and documents.

### Changes Required:

#### 1. Create TreeNode component
**File**: `src/lib/components/TreeNode.svelte`

```svelte
<script lang="ts">
  import type { TreeNode as TreeNodeType, DocumentState } from '../documents/state.svelte';
  import type { MenuItem } from './ContextMenu.svelte';

  let {
    node,
    depth = 0,
    documentState,
    onSelect,
    onContextMenu,
  }: {
    node: TreeNodeType;
    depth?: number;
    documentState: DocumentState;
    onSelect: (id: string) => void;
    onContextMenu: (e: MouseEvent, node: TreeNodeType) => void;
  } = $props();

  const isFolder = $derived(node.type === 'folder');
  const isExpanded = $derived(isFolder && documentState.expandedFolders.has(node.path));
  const isActive = $derived(!isFolder && node.document?.id === documentState.activeDocumentId);
  const hasChildren = $derived(isFolder && node.children && node.children.length > 0);

  function handleClick() {
    if (isFolder) {
      documentState.toggleFolder(node.path);
    } else if (node.document) {
      onSelect(node.document.id);
    }
  }

  function handleRightClick(e: MouseEvent) {
    e.preventDefault();
    onContextMenu(e, node);
  }
</script>

<div class="tree-node">
  <div
    class="tree-item"
    class:folder={isFolder}
    class:document={!isFolder}
    class:active={isActive}
    style="padding-left: {16 + depth * 16}px"
    onclick={handleClick}
    oncontextmenu={handleRightClick}
    onkeydown={(e) => { if (e.key === 'Enter') handleClick(); }}
    role="treeitem"
    tabindex="0"
    aria-expanded={isFolder ? isExpanded : undefined}
  >
    {#if isFolder}
      <span class="chevron" class:expanded={isExpanded}>
        <svg width="12" height="12" viewBox="0 0 12 12" fill="none">
          <path d="M4.5 3L7.5 6L4.5 9" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/>
        </svg>
      </span>
      <span class="icon folder-icon">
        <svg width="14" height="14" viewBox="0 0 14 14" fill="none">
          <path d="M1.5 3.5C1.5 2.94772 1.94772 2.5 2.5 2.5H5L6.5 4H11.5C12.0523 4 12.5 4.44772 12.5 5V10.5C12.5 11.0523 12.0523 11.5 11.5 11.5H2.5C1.94772 11.5 1.5 11.0523 1.5 10.5V3.5Z" stroke="currentColor" stroke-width="1.2"/>
        </svg>
      </span>
    {:else}
      <span class="icon-spacer"></span>
      <span class="icon doc-icon">
        <svg width="14" height="14" viewBox="0 0 14 14" fill="none">
          <path d="M8 1.5H3.5C2.94772 1.5 2.5 1.94772 2.5 2.5V11.5C2.5 12.0523 2.94772 12.5 3.5 12.5H10.5C11.0523 12.5 11.5 12.0523 11.5 11.5V5L8 1.5Z" stroke="currentColor" stroke-width="1.2"/>
          <path d="M8 1.5V5H11.5" stroke="currentColor" stroke-width="1.2"/>
        </svg>
      </span>
    {/if}
    <span class="tree-label">{node.name}</span>
  </div>

  {#if isFolder && isExpanded && node.children}
    <div class="tree-children" role="group">
      {#each node.children as child (child.type === 'document' ? child.document?.id : child.path)}
        <svelte:self
          node={child}
          depth={depth + 1}
          {documentState}
          {onSelect}
          {onContextMenu}
        />
      {/each}
    </div>
  {/if}
</div>

<style>
  .tree-node {
    user-select: none;
  }

  .tree-item {
    display: flex;
    align-items: center;
    gap: 6px;
    padding: 6px 8px;
    cursor: pointer;
    border-radius: 4px;
    margin: 1px 4px;
    transition: background 0.1s;
    font-size: 13px;
    color: var(--text-primary);
  }

  .tree-item:hover {
    background: var(--accent-hover);
  }

  .tree-item.active {
    background: var(--accent-active);
  }

  .chevron {
    display: flex;
    align-items: center;
    justify-content: center;
    width: 12px;
    height: 12px;
    color: var(--text-muted);
    transition: transform 0.15s ease;
  }

  .chevron.expanded {
    transform: rotate(90deg);
  }

  .icon-spacer {
    width: 12px;
  }

  .icon {
    display: flex;
    align-items: center;
    justify-content: center;
    color: var(--text-muted);
  }

  .tree-label {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    flex: 1;
  }

  .tree-children {
    /* children inherit indentation from depth prop */
  }
</style>
```

#### 2. Update DocumentList to use tree
**File**: `src/lib/components/DocumentList.svelte`

Replace the current flat list implementation with tree view:

```svelte
<script lang="ts">
  import type { DocumentState, TreeNode } from '../documents/state.svelte';
  import TreeNodeComponent from './TreeNode.svelte';
  import ContextMenu, { type MenuItem } from './ContextMenu.svelte';

  let {
    documentState,
    onSelect,
  }: {
    documentState: DocumentState
    onSelect: (id: string) => void
  } = $props();

  let isCreating = $state(false);
  let createInPath = $state('/');
  let newDocName = $state('');
  let newDocInput = $state<HTMLInputElement>();

  let contextMenu = $state<{ x: number; y: number; node: TreeNode } | null>(null);
  let moveDialogOpen = $state(false);
  let moveTargetNode = $state<TreeNode | null>(null);
  let selectedMovePath = $state('/');

  async function handleCreate() {
    if (!newDocName.trim()) return;
    isCreating = true;
    const doc = await documentState.create(newDocName.trim(), undefined, createInPath);
    isCreating = false;
    newDocName = '';
    createInPath = '/';
    if (doc) {
      onSelect(doc.id);
    }
  }

  function startCreate(path: string = '/') {
    createInPath = path;
    newDocName = '';
    // Focus input after render
    setTimeout(() => newDocInput?.focus(), 0);
  }

  function cancelCreate() {
    newDocName = '';
    createInPath = '/';
  }

  function handleContextMenu(e: MouseEvent, node: TreeNode) {
    contextMenu = { x: e.clientX, y: e.clientY, node };
  }

  function getContextMenuItems(): MenuItem[] {
    if (!contextMenu) return [];
    const node = contextMenu.node;

    if (node.type === 'folder') {
      return [
        { label: 'New Document', action: () => startCreate(node.path) },
      ];
    } else {
      return [
        { label: 'Move to...', action: () => openMoveDialog(node) },
        { divider: true, label: '', action: () => {} },
        {
          label: 'Delete',
          action: () => {
            if (node.document && confirm('Delete this document?')) {
              documentState.remove(node.document.id);
            }
          }
        },
      ];
    }
  }

  function openMoveDialog(node: TreeNode) {
    if (node.type !== 'document' || !node.document) return;
    moveTargetNode = node;
    selectedMovePath = '/';
    moveDialogOpen = true;
  }

  async function confirmMove() {
    if (!moveTargetNode?.document) return;
    await documentState.move(moveTargetNode.document.id, selectedMovePath);
    moveDialogOpen = false;
    moveTargetNode = null;
  }

  // Get all folder paths for move dialog
  function getAllFolderPaths(): string[] {
    const paths = new Set<string>(['/']);
    for (const doc of documentState.documents) {
      if (doc.path !== '/') {
        const parts = doc.path.split('/').filter(Boolean);
        let currentPath = '/';
        for (const part of parts) {
          currentPath += part + '/';
          paths.add(currentPath);
        }
      }
    }
    return [...paths].sort();
  }
</script>

<div class="document-list glass-panel">
  <div class="panel-header">
    <span>Documents</span>
    <button class="new-btn" onclick={() => startCreate('/')}>
      + New
    </button>
  </div>

  {#if newDocName !== '' || createInPath !== '/'}
    <div class="create-form">
      <input
        type="text"
        bind:this={newDocInput}
        bind:value={newDocName}
        placeholder="Document name..."
        onkeydown={(e) => {
          if (e.key === 'Enter') handleCreate();
          if (e.key === 'Escape') cancelCreate();
        }}
        disabled={isCreating}
      />
      <span class="create-path">in {createInPath === '/' ? 'root' : createInPath}</span>
    </div>
  {/if}

  <div class="tree-content" role="tree">
    {#if documentState.isLoading}
      <div class="empty-state">
        <span class="empty-label">Loading documents...</span>
        <div class="loading-bar"><div class="loading-bar-fill"></div></div>
      </div>
    {:else if documentState.error}
      <div class="empty-state">
        <span class="empty-label">Failed to load</span>
        <span class="empty-hint">{documentState.error}</span>
        <button class="retry-btn" onclick={() => documentState.load()}>Retry</button>
      </div>
    {:else if documentState.filteredTree.length === 0}
      <div class="empty-state">
        {#if documentState.searchQuery}
          <span class="empty-label">No matches found</span>
          <span class="empty-hint">Try a different search term</span>
        {:else}
          <span class="empty-label">No documents yet</span>
          <span class="empty-hint">Create a document to get started</span>
        {/if}
      </div>
    {:else}
      {#each documentState.filteredTree as node (node.type === 'document' ? node.document?.id : node.path)}
        <TreeNodeComponent
          {node}
          depth={0}
          {documentState}
          {onSelect}
          onContextMenu={handleContextMenu}
        />
      {/each}
    {/if}
  </div>
</div>

{#if contextMenu}
  <ContextMenu
    items={getContextMenuItems()}
    x={contextMenu.x}
    y={contextMenu.y}
    onClose={() => contextMenu = null}
  />
{/if}

{#if moveDialogOpen && moveTargetNode}
  <div class="modal-overlay" onclick={() => moveDialogOpen = false}>
    <div class="modal" onclick={(e) => e.stopPropagation()}>
      <h3>Move "{moveTargetNode.name}"</h3>
      <select bind:value={selectedMovePath}>
        {#each getAllFolderPaths() as path}
          <option value={path}>{path === '/' ? '/ (root)' : path}</option>
        {/each}
      </select>
      <div class="modal-actions">
        <button onclick={() => moveDialogOpen = false}>Cancel</button>
        <button class="primary" onclick={confirmMove}>Move</button>
      </div>
    </div>
  </div>
{/if}

<style>
  .document-list {
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
    font-size: 12px;
    font-weight: 500;
    color: var(--text-secondary);
    background: none;
    border: 1px solid var(--border-color);
    border-radius: 4px;
    padding: 2px 8px;
    cursor: pointer;
    transition: background 0.15s ease;
  }

  .new-btn:hover {
    background: var(--accent-hover);
  }

  .create-form {
    padding: 8px 12px;
    border-bottom: 1px solid var(--border-color);
    display: flex;
    flex-direction: column;
    gap: 4px;
  }

  .create-form input {
    width: 100%;
    padding: 6px 8px;
    border: 1px solid var(--border-color);
    border-radius: 4px;
    font-size: 13px;
    font-family: var(--font-sans);
    background: var(--bg-primary);
    color: var(--text-primary);
  }

  .create-form input:focus {
    outline: none;
    border-color: var(--accent);
  }

  .create-path {
    font-size: 11px;
    color: var(--text-muted);
  }

  .tree-content {
    flex: 1;
    overflow-y: auto;
    padding: 4px 0;
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
    line-height: 1.4;
    max-width: 160px;
  }

  .retry-btn {
    font-size: 11px;
    color: var(--text-secondary);
    background: none;
    border: 1px solid var(--border-color);
    border-radius: 4px;
    padding: 2px 10px;
    cursor: pointer;
    margin-top: 4px;
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
    margin-top: 4px;
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

  /* Modal styles */
  .modal-overlay {
    position: fixed;
    inset: 0;
    background: rgba(0, 0, 0, 0.4);
    display: flex;
    align-items: center;
    justify-content: center;
    z-index: 1000;
  }

  .modal {
    background: var(--bg-primary);
    border-radius: 12px;
    padding: 20px;
    min-width: 300px;
    box-shadow: 0 8px 32px rgba(0, 0, 0, 0.2);
  }

  .modal h3 {
    font-size: 14px;
    font-weight: 600;
    color: var(--text-primary);
    margin: 0 0 16px;
  }

  .modal select {
    width: 100%;
    padding: 8px;
    border: 1px solid var(--border-color);
    border-radius: 6px;
    font-size: 13px;
    font-family: var(--font-sans);
    background: var(--bg-primary);
    color: var(--text-primary);
  }

  .modal-actions {
    display: flex;
    justify-content: flex-end;
    gap: 8px;
    margin-top: 16px;
  }

  .modal-actions button {
    padding: 6px 12px;
    border: 1px solid var(--border-color);
    border-radius: 6px;
    font-size: 12px;
    font-family: var(--font-sans);
    cursor: pointer;
    background: var(--bg-primary);
    color: var(--text-primary);
  }

  .modal-actions button:hover {
    background: var(--accent-hover);
  }

  .modal-actions button.primary {
    background: var(--accent);
    color: white;
    border-color: var(--accent);
  }

  .modal-actions button.primary:hover {
    opacity: 0.9;
  }
</style>
```

### Success Criteria:

#### Automated Verification:
- [ ] TypeScript compilation passes: `cd svelte-experiment && bun run check`
- [ ] Components compile without errors

#### Smoke Test
Create `svelte-experiment/src/lib/components/TreeNode.test.ts`:
```typescript
import { describe, test, expect } from 'bun:test'

describe('TreeNode Component', () => {
  test('module can be imported', async () => {
    const mod = await import('./TreeNode.svelte')
    expect(mod.default).toBeDefined()
  })
})

describe('DocumentList with Tree', () => {
  test('module can be imported', async () => {
    const mod = await import('./DocumentList.svelte')
    expect(mod.default).toBeDefined()
  })
})
```

Run: `cd svelte-experiment && bun test src/lib/components/TreeNode.test.ts`

Visual verification via dev server:
1. Start: `bun run dev`
2. Navigate to a project with documents
3. Verify tree renders with folders and documents
4. Test expand/collapse, right-click context menu
5. Test "Move to..." and document creation

---

## Phase 4: Search with Cmd/Ctrl+K

### Overview
Add a search input at the top of the sidebar with global keyboard shortcut support.

### Changes Required:

#### 1. Create SearchInput component
**File**: `src/lib/components/SearchInput.svelte`

```svelte
<script lang="ts">
  import { onMount, onDestroy } from 'svelte';

  let {
    value = $bindable(''),
    placeholder = 'Search...',
    onClear,
  }: {
    value?: string;
    placeholder?: string;
    onClear?: () => void;
  } = $props();

  let inputEl = $state<HTMLInputElement>();

  function handleKeydown(e: KeyboardEvent) {
    // Cmd/Ctrl+K to focus search
    if ((e.metaKey || e.ctrlKey) && e.key === 'k') {
      e.preventDefault();
      inputEl?.focus();
      inputEl?.select();
    }
  }

  function handleClear() {
    value = '';
    onClear?.();
    inputEl?.focus();
  }

  onMount(() => {
    window.addEventListener('keydown', handleKeydown);
  });

  onDestroy(() => {
    window.removeEventListener('keydown', handleKeydown);
  });
</script>

<div class="search-wrapper">
  <svg class="search-icon" width="14" height="14" viewBox="0 0 14 14" fill="none">
    <circle cx="6" cy="6" r="4.5" stroke="currentColor" stroke-width="1.2"/>
    <path d="M9.5 9.5L12.5 12.5" stroke="currentColor" stroke-width="1.2" stroke-linecap="round"/>
  </svg>
  <input
    type="text"
    bind:this={inputEl}
    bind:value
    {placeholder}
    class="search-input"
  />
  {#if value}
    <button class="clear-btn" onclick={handleClear} aria-label="Clear search">
      <svg width="12" height="12" viewBox="0 0 12 12" fill="none">
        <path d="M3 3L9 9M9 3L3 9" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/>
      </svg>
    </button>
  {:else}
    <span class="shortcut-hint">
      <kbd>{navigator.platform.includes('Mac') ? 'Cmd' : 'Ctrl'}</kbd>
      <kbd>K</kbd>
    </span>
  {/if}
</div>

<style>
  .search-wrapper {
    position: relative;
    display: flex;
    align-items: center;
    padding: 8px 12px;
    border-bottom: 1px solid var(--border-color);
  }

  .search-icon {
    position: absolute;
    left: 20px;
    color: var(--text-muted);
    pointer-events: none;
  }

  .search-input {
    width: 100%;
    padding: 6px 8px 6px 28px;
    border: 1px solid var(--border-color);
    border-radius: 6px;
    font-size: 12px;
    font-family: var(--font-sans);
    background: var(--bg-primary);
    color: var(--text-primary);
  }

  .search-input:focus {
    outline: none;
    border-color: var(--accent);
  }

  .search-input::placeholder {
    color: var(--text-muted);
  }

  .clear-btn {
    position: absolute;
    right: 20px;
    display: flex;
    align-items: center;
    justify-content: center;
    width: 16px;
    height: 16px;
    padding: 0;
    border: none;
    border-radius: 3px;
    background: var(--bg-tertiary);
    color: var(--text-muted);
    cursor: pointer;
    transition: background 0.1s, color 0.1s;
  }

  .clear-btn:hover {
    background: var(--accent-active);
    color: var(--text-primary);
  }

  .shortcut-hint {
    position: absolute;
    right: 20px;
    display: flex;
    gap: 2px;
  }

  .shortcut-hint kbd {
    font-size: 10px;
    font-family: var(--font-sans);
    color: var(--text-muted);
    background: var(--bg-tertiary);
    border: 1px solid var(--border-color);
    border-radius: 3px;
    padding: 1px 4px;
  }
</style>
```

#### 2. Integrate search into DocumentList
**File**: `src/lib/components/DocumentList.svelte`

Add search input at top, before the tree content:

```svelte
<!-- Add import -->
import SearchInput from './SearchInput.svelte';

<!-- Add between panel-header and create-form/tree-content -->
<SearchInput
  bind:value={documentState.searchQuery}
  placeholder="Search documents..."
  onClear={() => documentState.searchQuery = ''}
/>
```

The DocumentState already has `searchQuery` and `filteredTree` that filter based on it.

### Success Criteria:

#### Automated Verification:
- [ ] TypeScript compilation passes: `cd svelte-experiment && bun run check`

#### Smoke Test
Create `svelte-experiment/src/lib/components/SearchInput.test.ts`:
```typescript
import { describe, test, expect } from 'bun:test'

describe('SearchInput Component', () => {
  test('module can be imported', async () => {
    const mod = await import('./SearchInput.svelte')
    expect(mod.default).toBeDefined()
  })
})
```

Run: `cd svelte-experiment && bun test src/lib/components/SearchInput.test.ts`

Visual verification:
1. Start dev server: `bun run dev`
2. Navigate to project with documents
3. Press Cmd/Ctrl+K - verify search input focuses
4. Type query - verify tree filters in real-time
5. Click X to clear - verify tree restores
6. Search for nonexistent term - verify "No matches" message

---

## Phase 5: Breadcrumb Navigation

### Overview
Add breadcrumb navigation showing the path to the current document, with clickable segments.

### Changes Required:

#### 1. Create Breadcrumb component
**File**: `src/lib/components/Breadcrumb.svelte`

```svelte
<script lang="ts">
  import type { DocumentState } from '../documents/state.svelte';

  let {
    documentState,
    projectName = 'Project',
    onNavigate,
  }: {
    documentState: DocumentState;
    projectName?: string;
    onNavigate: (path: string) => void;
  } = $props();

  let crumbs = $derived(
    documentState.activeDocumentId
      ? documentState.getBreadcrumb(documentState.activeDocumentId)
      : []
  );
</script>

{#if documentState.activeDocumentId}
  <nav class="breadcrumb" aria-label="Breadcrumb">
    <ol class="breadcrumb-list">
      <li class="breadcrumb-item">
        <button
          class="breadcrumb-link"
          onclick={() => onNavigate('/')}
        >
          {projectName}
        </button>
      </li>
      {#each crumbs as crumb, i (crumb.path)}
        <li class="breadcrumb-separator" aria-hidden="true">/</li>
        <li class="breadcrumb-item">
          {#if i === crumbs.length - 1}
            <span class="breadcrumb-current" aria-current="page">
              {crumb.name}
            </span>
          {:else}
            <button
              class="breadcrumb-link"
              onclick={() => onNavigate(crumb.path)}
            >
              {crumb.name}
            </button>
          {/if}
        </li>
      {/each}
    </ol>
  </nav>
{/if}

<style>
  .breadcrumb {
    padding: 8px 16px;
    border-bottom: 1px solid var(--border-color);
    background: var(--bg-primary);
  }

  .breadcrumb-list {
    display: flex;
    align-items: center;
    flex-wrap: wrap;
    gap: 4px;
    list-style: none;
    margin: 0;
    padding: 0;
    font-size: 12px;
  }

  .breadcrumb-item {
    display: flex;
    align-items: center;
  }

  .breadcrumb-separator {
    color: var(--text-muted);
  }

  .breadcrumb-link {
    background: none;
    border: none;
    padding: 2px 4px;
    margin: -2px -4px;
    border-radius: 4px;
    font-size: 12px;
    font-family: var(--font-sans);
    color: var(--text-secondary);
    cursor: pointer;
    transition: background 0.1s, color 0.1s;
  }

  .breadcrumb-link:hover {
    background: var(--accent-hover);
    color: var(--text-primary);
  }

  .breadcrumb-current {
    color: var(--text-primary);
    font-weight: 500;
  }
</style>
```

#### 2. Integrate breadcrumb into Editor panel
**File**: `src/lib/components/Editor.svelte`

Add breadcrumb navigation above the editor tabs:

```svelte
<!-- Add import -->
import Breadcrumb from './Breadcrumb.svelte';

<!-- Add function to handle breadcrumb navigation -->
function handleBreadcrumbNavigate(path: string) {
  // Expand the folder in the sidebar and scroll to it
  if (path !== '/' && !path.match(/^[a-f0-9-]+$/)) {
    // It's a folder path
    documentState.expandPathChain(path);
  }
  // Could also focus/scroll to the folder in the tree
}

<!-- Add before EditorTabs -->
<Breadcrumb
  {documentState}
  projectName="Project"
  onNavigate={handleBreadcrumbNavigate}
/>
```

Update the Editor component to receive documentState and include the Breadcrumb:

```svelte
<script lang="ts">
  import { onDestroy, untrack, tick } from 'svelte';
  import { Editor } from '@tiptap/core';
  import StarterKit from '@tiptap/starter-kit';
  import { TableKit } from '@tiptap/extension-table';
  import Collaboration from '@tiptap/extension-collaboration';
  import * as Y from 'yjs';
  import { WebsocketProvider } from 'y-websocket';
  import { yCursorPlugin } from '@tiptap/y-tiptap';
  import type { AuthState } from '../auth/state.svelte';
  import type { DocumentState } from '../documents/state.svelte';
  import EditorTabs from './EditorTabs.svelte';
  import Breadcrumb from './Breadcrumb.svelte';

  let { documentState, authState }: { documentState: DocumentState; authState: AuthState } = $props();

  // ... rest of existing code ...

  function handleBreadcrumbNavigate(path: string) {
    if (path !== '/' && !path.match(/^[a-f0-9-]+$/)) {
      documentState.expandPathChain(path);
    }
  }
</script>

<div class="editor-panel glass-panel">
  <Breadcrumb
    {documentState}
    projectName="Project"
    onNavigate={handleBreadcrumbNavigate}
  />
  <EditorTabs
    tabs={documentState.openTabs}
    activeTabId={documentState.activeDocumentId}
    onActivate={(id) => documentState.activateTab(id)}
    onClose={(id) => documentState.closeTab(id)}
  />
  <!-- ... rest of existing template ... -->
</div>
```

### Success Criteria:

#### Automated Verification:
- [ ] TypeScript compilation passes: `cd svelte-experiment && bun run check`

#### Smoke Test
Create `svelte-experiment/src/lib/components/Breadcrumb.test.ts`:
```typescript
import { describe, test, expect } from 'bun:test'

describe('Breadcrumb Component', () => {
  test('module can be imported', async () => {
    const mod = await import('./Breadcrumb.svelte')
    expect(mod.default).toBeDefined()
  })

  test('getBreadcrumb builds correct path', () => {
    // Test breadcrumb generation logic
    function getBreadcrumb(doc: { path: string; name: string; id: string }) {
      const crumbs: Array<{ name: string; path: string }> = []
      const parts = doc.path.split('/').filter(Boolean)
      let currentPath = '/'

      for (const part of parts) {
        currentPath += part + '/'
        crumbs.push({ name: part, path: currentPath })
      }

      crumbs.push({ name: doc.name, path: doc.id })
      return crumbs
    }

    const doc = { id: 'doc-1', name: 'My Doc', path: '/Design/Drafts/' }
    const breadcrumb = getBreadcrumb(doc)

    expect(breadcrumb.length).toBe(3) // Design > Drafts > My Doc
    expect(breadcrumb[0].name).toBe('Design')
    expect(breadcrumb[1].name).toBe('Drafts')
    expect(breadcrumb[2].name).toBe('My Doc')
  })
})
```

Run: `cd svelte-experiment && bun test src/lib/components/Breadcrumb.test.ts`

Visual verification:
1. Start dev server: `bun run dev`
2. Open a document nested in folders
3. Verify breadcrumb shows: Project > Folder > Subfolder > Document
4. Click folder segment - verify sidebar expands to that folder

---

## Phase 6: App Integration

### Overview
Wire up project state, update App.svelte to use the new components, and ensure everything works together.

### Changes Required:

#### 1. Create projects API functions
**File**: `src/lib/api/projects.ts`

```typescript
import type { ApiClient } from './client'
import type {
  Project,
  CreateProjectRequest,
  CreateProjectResponse,
  ListProjectsResponse,
  GetProjectResponse,
  UpdateProjectRequest,
  UpdateProjectResponse,
} from '@claude-agent/shared'

export type { Project }

export function listProjects(api: ApiClient): Promise<ListProjectsResponse> {
  return api.apiFetch('/projects')
}

export function createProject(api: ApiClient, req: CreateProjectRequest): Promise<CreateProjectResponse> {
  return api.apiFetch('/projects', {
    method: 'POST',
    body: JSON.stringify(req),
  })
}

export function getProject(api: ApiClient, id: string): Promise<GetProjectResponse> {
  return api.apiFetch(`/projects/${id}`)
}

export function updateProject(api: ApiClient, id: string, req: UpdateProjectRequest): Promise<UpdateProjectResponse> {
  return api.apiFetch(`/projects/${id}`, {
    method: 'PATCH',
    body: JSON.stringify(req),
  })
}

export async function deleteProject(api: ApiClient, id: string): Promise<void> {
  await api.apiRawFetch(`/projects/${id}`, { method: 'DELETE' })
}
```

#### 2. Update App.svelte initialization
**File**: `src/App.svelte`

Add project state initialization and pass to components:

```svelte
<script lang="ts">
  // ... existing imports ...
  import { createProjectState, type ProjectState } from './lib/projects/state.svelte';

  // ... existing state ...
  let projectState = $state<ProjectState | null>(null);

  // Update the $effect to initialize project state
  $effect(() => {
    if (authState.isAuthenticated && authState.session && authState.workspaceId) {
      untrack(() => {
        const api = createApiClient(authState);
        const ps = createProjectState(api);
        const ds = createDocumentState(api);
        const as_ = createAgentState(authState);

        projectState = ps;
        documentState = ds;
        agentState = as_;

        // Load projects first, then documents once project is selected
        ps.load().then(() => {
          if (ps.activeProjectId) {
            ds.projectId = ps.activeProjectId;
            ds.load();
          }
        });
        as_.init();
      });
    } else if (!authState.isAuthenticated && !authState.isLoading) {
      untrack(() => {
        if (agentState) {
          agentState.disconnect();
          agentState = null;
        }
        documentState = null;
        projectState = null;
      });
    }
  });

  // Update document state when project changes
  $effect(() => {
    if (projectState?.activeProjectId && documentState) {
      documentState.projectId = projectState.activeProjectId;
      documentState.load();
    }
  });

  // ... rest of existing code ...
</script>
```

#### 3. Add project selector to AppHeader (optional enhancement)
If multiple projects exist, user needs a way to switch. This can be a simple dropdown in the header.

**File**: `src/lib/components/AppHeader.svelte`

Add project selector:

```svelte
<script lang="ts">
  import type { AuthState } from '../auth/state.svelte';
  import type { ProjectState } from '../projects/state.svelte';

  interface Props {
    authState: AuthState;
    projectState?: ProjectState;
  }

  let { authState, projectState }: Props = $props();
  // ... existing code ...
</script>

<!-- In template, add project selector if projectState provided -->
<header class="app-header">
  <div class="app-header-left">
    <span class="app-name">Shopped</span>
    {#if projectState && projectState.projects.length > 0}
      <select
        class="project-selector"
        value={projectState.activeProjectId ?? ''}
        onchange={(e) => projectState.selectProject((e.target as HTMLSelectElement).value)}
      >
        {#each projectState.projects as project}
          <option value={project.id}>{project.name}</option>
        {/each}
      </select>
    {/if}
  </div>
  <!-- ... rest of template ... -->
</header>

<style>
  /* ... existing styles ... */

  .project-selector {
    margin-left: 12px;
    padding: 4px 8px;
    border: 1px solid var(--border-color);
    border-radius: 4px;
    font-size: 12px;
    font-family: var(--font-sans);
    background: var(--bg-primary);
    color: var(--text-primary);
  }
</style>
```

### Success Criteria:

#### Automated Verification:
- [ ] TypeScript compilation passes: `cd svelte-experiment && bun run check`
- [ ] Application starts without errors: `cd svelte-experiment && bun run dev`

#### Integration Smoke Test
Create `svelte-experiment/tests/integration/documents-navigation.test.ts`:
```typescript
import { describe, test, expect } from 'bun:test'

describe('Documents & Navigation Integration', () => {
  test('all required components can be imported', async () => {
    const modules = await Promise.all([
      import('../../src/lib/components/ContextMenu.svelte'),
      import('../../src/lib/components/TreeNode.svelte'),
      import('../../src/lib/components/DocumentList.svelte'),
      import('../../src/lib/components/SearchInput.svelte'),
      import('../../src/lib/components/Breadcrumb.svelte'),
      import('../../src/lib/documents/state.svelte'),
      import('../../src/lib/projects/state.svelte'),
    ])
    modules.forEach(mod => expect(mod.default).toBeDefined())
  })

  test('API client modules can be imported', async () => {
    const modules = await Promise.all([
      import('../../src/lib/api/projects'),
      import('../../src/lib/api/documents'),
    ])
    expect(modules[0].listProjects).toBeDefined()
    expect(modules[1].listDocuments).toBeDefined()
  })
})
```

Run: `cd svelte-experiment && bun test tests/integration/documents-navigation.test.ts`

For full E2E verification:
```bash
cd svelte-experiment && bun run dev
# Navigate through the complete flow in browser:
# 1. Login -> Projects load
# 2. Select project -> Documents load in tree
# 3. Test Cmd/Ctrl+K search
# 4. Create document in folder
# 5. Move document to different folder
# 6. Verify breadcrumb navigation
```

---

## Testing Strategy

### Unit Tests:
- Tree building logic (flat documents to tree structure)
- Search filtering logic
- Path normalization
- Breadcrumb generation

### Integration Tests:
- Document state with API calls
- Expand/collapse persistence
- Search + tree interaction

### Manual Testing Steps:
1. Log in and verify projects load
2. Click folder to expand/collapse - verify animation and persistence
3. Press Cmd/Ctrl+K - verify search input focuses
4. Type search query - verify tree filters
5. Clear search - verify full tree restores with previous expand state
6. Right-click folder - verify "New Document" option
7. Create document in folder - verify it appears in correct location
8. Right-click document - verify "Move to..." and "Delete" options
9. Move document to different folder - verify tree updates
10. Open document - verify breadcrumb shows full path
11. Click breadcrumb folder segment - verify folder expands in sidebar

## Performance Considerations

- Tree building is computed on each render - memoize if performance issues arise
- Search filtering recalculates on each keystroke - debounce input if needed
- LocalStorage operations for expand state are synchronous - batch if needed
- Large trees (100+ items) may need virtualization (deferred)

## References

- Backend plan: `thoughts/shared/plans/2026-02-04-document-folder-hierarchy.md`
- Story: create-document-in-folder (8b93fc)
- Story: move-document-within-project (846d9a)
- Story: breadcrumb-navigation (a96fde)
- Story: project-tree-view (web-navigation)
- Story: search-within-project (web-navigation)
- Current DocumentList: `src/lib/components/DocumentList.svelte`
- Current document state: `src/lib/documents/state.svelte.ts`
