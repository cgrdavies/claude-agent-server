import type {
  AgentSession,
  BreadcrumbItem,
  Document,
  DocumentWithContent,
  Folder,
  Project,
  Provider,
  SearchResult,
  StoredMessage,
  TreeNode,
} from './types'

// ============================================================
// Common
// ============================================================

export type ApiError = {
  error: string
  code?: string
}

export type PaginatedResponse<T> = {
  data: T[]
  cursor: string | null // opaque cursor for next page
}

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

// ============================================================
// Folders
// ============================================================

export type CreateFolderRequest = {
  name: string
  parent_id?: string // null/omit = project root
}

export type CreateFolderResponse = {
  folder: Folder
}

export type ListFoldersResponse = {
  folders: Folder[]
}

export type GetFolderResponse = {
  folder: Folder
}

export type GetFolderContentsResponse = {
  documentsCount: number
  foldersCount: number
}

export type UpdateFolderRequest = {
  name?: string
  parent_id?: string | null // move to different parent
}

export type UpdateFolderResponse = {
  folder: Folder
}

export type DeleteFolderResponse = {
  success: boolean
  documentsDeleted: number
  foldersDeleted: number
}

// ============================================================
// Tree View & Search
// ============================================================

export type GetTreeResponse = {
  nodes: TreeNode[] // flat list, client builds tree from parent_id
}

export type GetTreeNestedResponse = {
  tree: TreeNode[] // pre-built nested structure with children populated
}

export type SearchRequest = {
  query: string
  type?: 'all' | 'documents' | 'folders' // default: all
}

export type SearchResponse = {
  results: SearchResult[]
}

// ============================================================
// Documents
// ============================================================

export type CreateDocumentRequest = {
  name: string
  content?: string // initial markdown
  project_id: string // required until nested routes are implemented
  folder_id?: string // null/omit = project root
}

export type CreateDocumentResponse = {
  document: Document
}

export type ListDocumentsResponse = {
  documents: Document[]
}

export type GetDocumentResponse = {
  document: DocumentWithContent & {
    breadcrumb: BreadcrumbItem[]
  }
}

export type UpdateDocumentRequest = {
  name?: string
  content?: string
  project_id: string // required until nested routes are implemented
  folder_id?: string | null // move to different folder
}

export type UpdateDocumentResponse = {
  document: Document
}

// ============================================================
// Sessions
// ============================================================

export type CreateSessionRequest = {
  project_id: string // required: the project this session belongs to
  title?: string
  model?: string // defaults to server default
  provider?: Provider // defaults to 'anthropic'
  system_prompt?: string // user's custom instructions (project context added automatically)
}

export type CreateSessionResponse = {
  session: AgentSession
}

export type ListSessionsResponse = PaginatedResponse<AgentSession>

export type GetSessionResponse = {
  session: AgentSession
  messages: StoredMessage[]
}

export type UpdateSessionRequest = {
  title?: string
  archived?: boolean
}

export type UpdateSessionResponse = {
  session: AgentSession
}

// ============================================================
// Messages (send + stream)
// ============================================================

export type SendMessageRequest = {
  content: string
  /** Optional: override model for this message only */
  model?: string
  provider?: Provider
}

// Response is an SSE stream - see stream-events.ts
