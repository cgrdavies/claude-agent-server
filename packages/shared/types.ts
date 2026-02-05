// ============================================================
// Domain entities (mirror DB shape)
// ============================================================

// ------------------------------------------------------------
// Projects
// ------------------------------------------------------------

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

// ------------------------------------------------------------
// Folders
// ------------------------------------------------------------

export type Folder = {
  id: string
  project_id: string
  parent_id: string | null // null = project root
  name: string
  created_by: string
  created_at: string
  updated_at: string
}

// ------------------------------------------------------------
// Documents
// ------------------------------------------------------------

export type Document = {
  id: string
  project_id: string
  workspace_id: string
  folder_id: string | null // null = project root
  name: string
  created_by: string
  created_at: string
  updated_at: string
}

export type DocumentWithContent = Document & {
  content: string // markdown
}

// ------------------------------------------------------------
// Sessions
// ------------------------------------------------------------

export type Provider = 'anthropic' | 'openai' | 'openrouter'

export type AgentSession = {
  id: string
  project_id: string
  workspace_id: string
  title: string
  model: string // e.g. "claude-sonnet-4-20250514"
  provider: Provider
  system_prompt: string | null
  created_by: string // user id
  created_at: string // ISO 8601
  updated_at: string
  last_message_at: string | null
  archived: boolean
}

// ------------------------------------------------------------
// Messages
// ------------------------------------------------------------

/**
 * Stored message row. The content field holds the AI SDK ModelMessage
 * content serialized as JSON. This is the canonical format for replay.
 *
 * For user/system messages: content is a JSON string (the text).
 * For assistant messages: content is a JSON array of content parts
 *   (text parts + tool-call parts together).
 * For tool messages: content is a JSON array of tool-result parts.
 *
 * This means the full ModelMessage can be reconstructed from just
 * (role, content) without needing separate columns for tool calls.
 */
export type StoredMessage = {
  id: string
  session_id: string
  role: MessageRole
  content: string // JSON-serialized ModelMessage content
  model: string | null // model that generated this (assistant messages only)
  tokens_in: number | null
  tokens_out: number | null
  created_at: string
}

export type MessageRole = 'user' | 'assistant' | 'tool' | 'system'

// ------------------------------------------------------------
// Navigation (Tree View, Search, Breadcrumbs)
// ------------------------------------------------------------

export type BreadcrumbItem = {
  id: string
  name: string
  type: 'project' | 'folder' | 'document'
}

export type TreeNode = {
  id: string
  name: string
  type: 'folder' | 'document'
  parent_id: string | null // null = project root
  updated_at: string
  children?: TreeNode[] // only populated in nested response format
}

export type SearchResult = {
  id: string
  name: string
  type: 'folder' | 'document'
  parent_id: string | null
  breadcrumb: BreadcrumbItem[]
}
