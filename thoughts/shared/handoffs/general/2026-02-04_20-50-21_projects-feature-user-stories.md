---
date: 2026-02-04T20:50:21-0500
researcher: Claude
git_commit: dfc53938b0bbf3c1d466c9b5ae1723f41520b8c3
branch: main
repository: claude-agent-server
topic: "Projects Feature User Stories and Backlog"
tags: [user-stories, backlog, projects, hierarchical-documents, planning]
status: complete
last_updated: 2026-02-04
last_updated_by: Claude
type: product_planning
---

# Handoff: Projects Feature User Stories Complete

## Task(s)

**Completed:**
- Created comprehensive user stories for "Projects" feature with hierarchical file structures
- Organized 24 stories across 5 epics with `web-` prefix (to distinguish from electron client)
- Detailed breakdown of all stories with acceptance criteria, edge cases, dependencies, and decisions
- All stories synced to shopped backlog repository

**Story Breakdown Status:**
| Epic | Stories | Status |
|------|---------|--------|
| web-projects | P1-P5 (5) | ✅ Fully detailed |
| web-folders | F1-F5 (5) | ✅ Fully detailed |
| web-documents | D1-D5 (5) | ✅ Fully detailed |
| web-navigation | N1-N3 (3) | ✅ Fully detailed |
| web-ai-assistant | A1-A6 (6) | ✅ Fully detailed |

**MVP vs Deferred:**
- 19 stories in MVP scope
- 5 stories deferred: D3 (cross-project move), D5 (drag-drop), N3 (recents), A5 (@ mentions), A6 (folder structure awareness)

## Critical References

- Backlog repository: `/Users/cgrdavies/Projects/backlog/stories/`
- Epic definitions in `web-projects/`, `web-folders/`, `web-documents/`, `web-navigation/`, `web-ai-assistant/`

## Recent changes

No code changes - this was a product planning session. All changes were to the backlog repository.

## Learnings

**Key Product Decisions Made:**
1. **Information Architecture**: Dedicated Projects page sits above document view (cleaner IA)
2. **Filesystem Semantics**: No duplicate names in same folder (applies to both folders and documents)
3. **Folder Depth**: Max 5 levels
4. **Delete Behavior**: Soft delete for projects (superusers only, type-to-confirm), soft delete for folders (any member, simple confirm)
5. **AI Context Strategy**:
   - Small projects (≤20 docs): All doc names/IDs in system prompt, ordered by recent access
   - Large projects: Tool-based queries (search, list, read with pagination)
   - Structure knowledge via S3-style path naming (no explicit folder tree)
6. **Session Scoping**: AI sessions scoped to projects, clear to empty on project switch, preserve state when returning
7. **Navigation**: Single-click opens documents, Cmd/Ctrl+K for search, tree view with indentation only (no connecting lines)

**Shopped CLI Notes:**
- Epics are folder-based: `stories/{epic-name}/{story-slug}/story.md`
- Each epic has `_epic.md` with metadata
- Use `shopped backlog list --epic web-projects` to filter by epic
- Use `shopped backlog sync -m "message"` to commit and push

## Artifacts

All story documents in backlog repository:

**web-projects epic:**
- `/Users/cgrdavies/Projects/backlog/stories/web-projects/_epic.md`
- `/Users/cgrdavies/Projects/backlog/stories/web-projects/create-project/story.md`
- `/Users/cgrdavies/Projects/backlog/stories/web-projects/rename-project/story.md`
- `/Users/cgrdavies/Projects/backlog/stories/web-projects/delete-project/story.md`
- `/Users/cgrdavies/Projects/backlog/stories/web-projects/view-all-projects/story.md`
- `/Users/cgrdavies/Projects/backlog/stories/web-projects/switch-projects/story.md`

**web-folders epic:**
- `/Users/cgrdavies/Projects/backlog/stories/web-folders/_epic.md`
- `/Users/cgrdavies/Projects/backlog/stories/web-folders/create-folders/story.md`
- `/Users/cgrdavies/Projects/backlog/stories/web-folders/nested-folders/story.md`
- `/Users/cgrdavies/Projects/backlog/stories/web-folders/rename-folders/story.md`
- `/Users/cgrdavies/Projects/backlog/stories/web-folders/delete-folders/story.md`
- `/Users/cgrdavies/Projects/backlog/stories/web-folders/expand-collapse-folders/story.md`

**web-documents epic:**
- `/Users/cgrdavies/Projects/backlog/stories/web-documents/_epic.md`
- `/Users/cgrdavies/Projects/backlog/stories/web-documents/create-document-in-folder/story.md`
- `/Users/cgrdavies/Projects/backlog/stories/web-documents/move-document-within-project/story.md`
- `/Users/cgrdavies/Projects/backlog/stories/web-documents/move-document-between-projects/story.md` (deferred)
- `/Users/cgrdavies/Projects/backlog/stories/web-documents/breadcrumb-navigation/story.md`
- `/Users/cgrdavies/Projects/backlog/stories/web-documents/drag-and-drop-organization/story.md` (deferred)

**web-navigation epic:**
- `/Users/cgrdavies/Projects/backlog/stories/web-navigation/_epic.md`
- `/Users/cgrdavies/Projects/backlog/stories/web-navigation/project-tree-view/story.md`
- `/Users/cgrdavies/Projects/backlog/stories/web-navigation/search-within-project/story.md`
- `/Users/cgrdavies/Projects/backlog/stories/web-navigation/recent-documents/story.md` (deferred)

**web-ai-assistant epic:**
- `/Users/cgrdavies/Projects/backlog/stories/web-ai-assistant/_epic.md`
- `/Users/cgrdavies/Projects/backlog/stories/web-ai-assistant/project-scoped-ai-sessions/story.md`
- `/Users/cgrdavies/Projects/backlog/stories/web-ai-assistant/ai-session-switching-on-project-change/story.md`
- `/Users/cgrdavies/Projects/backlog/stories/web-ai-assistant/new-ai-session-in-project/story.md`
- `/Users/cgrdavies/Projects/backlog/stories/web-ai-assistant/ai-awareness-of-project-documents/story.md`
- `/Users/cgrdavies/Projects/backlog/stories/web-ai-assistant/attach-document-to-ai-conversation/story.md` (deferred)
- `/Users/cgrdavies/Projects/backlog/stories/web-ai-assistant/ai-understands-folder-structure/story.md` (deferred)

## Action Items & Next Steps

1. **Create Technical Plans**: Use the detailed stories to create implementation plans
   - Suggested order: web-projects (P1-P5) → web-folders (F1-F5) → web-documents (D1-D4) → web-navigation (N1-N2) → web-ai-assistant (A1-A4)
   - Each story has acceptance criteria that can drive test cases

2. **Database Schema Design**: Projects feature needs:
   - `projects` table with workspace_id FK
   - `folders` table with project_id FK and parent_folder_id for nesting
   - Update `documents` table with folder_id FK and project_id FK
   - Update `sessions` table with project_id FK
   - Soft delete columns (`deleted_at`) for projects and folders

3. **Frontend Components to Build**:
   - Projects page (list view)
   - Project tree sidebar
   - Folder/document context menus
   - Breadcrumb component
   - Search input with filtering

4. **AI Tools to Refine**:
   - Existing doc read/write/edit tools need review
   - Add search_documents tool with pagination
   - Add list_documents tool with pagination
   - System prompt builder for small projects (≤20 docs)

## Other Notes

**Useful Commands:**
```bash
# List all stories in an epic
shopped backlog list --epic web-projects

# Show a specific story
shopped backlog show create-project --epic web-projects

# Search stories
shopped backlog search "MVP" --status backlog

# Sync changes
shopped backlog sync -m "message"
```

**Story ID Mapping** (original IDs for reference):
- P1: 38fd47 → create-project
- P2: dafd8c → rename-project
- P3: 709c10 → delete-project
- P4: afabeb → view-all-projects
- P5: 68dde7 → switch-projects

**Deferred Stories Summary:**
- D3: Move doc between projects - added complexity, not core need
- D5: Drag-and-drop - D2 menu-based move covers MVP need
- N3: Recent documents - tree + search covers core navigation
- A5: @ mention UI - users can say doc name, AI looks it up
- A6: Folder structure awareness - path naming provides implicit structure
