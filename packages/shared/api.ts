import type {
  AgentSession,
  Document,
  DocumentWithContent,
  Provider,
  StoredMessage,
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
  cursor: string | null                  // opaque cursor for next page
}

// ============================================================
// Sessions
// ============================================================

export type CreateSessionRequest = {
  title?: string
  model?: string                         // defaults to server default
  provider?: Provider                    // defaults to 'anthropic'
  system_prompt?: string
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

// ============================================================
// Documents
// ============================================================

export type CreateDocumentRequest = {
  name: string
  content?: string                       // initial markdown
}

export type CreateDocumentResponse = {
  document: Document
}

export type ListDocumentsResponse = {
  documents: Document[]
}

export type GetDocumentResponse = {
  document: DocumentWithContent
}

export type UpdateDocumentRequest = {
  name?: string
  content?: string
}

export type UpdateDocumentResponse = {
  document: Document
}
