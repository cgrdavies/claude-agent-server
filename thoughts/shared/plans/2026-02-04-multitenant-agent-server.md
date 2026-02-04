# Multitenant Agent Server Implementation Plan

## Overview

Migrate from a container-based, single-user Claude Agent SDK wrapper to a multitenant web application. Users authenticate via Supabase, belong to workspaces, and can create/resume agent sessions backed by the Vercel AI SDK. The server runs on Bun with Hono, streams LLM responses via SSE, and stores conversation history in Supabase for session resumption.

## Current State Analysis

- **Server**: Bun-based WebSocket server wrapping `@anthropic-ai/claude-agent-sdk`
- **Agent loop**: SDK's `query()` with async generator message queue, single active connection
- **Documents**: Yjs CRDTs stored in local SQLite (`~/agent-workspace/documents.db`), synced via WebSocket
- **Sessions**: Managed by SDK as `.jsonl` files in `~/.claude/projects/`
- **Auth**: None in server code; relies on container-mounted `~/.claude` credentials
- **Tools**: 6 document tools (create, read, edit, append, list, delete) registered as MCP server
- **Schema**: Supabase DB has workspaces, workspace_memberships, sessions (git-oriented), but NO messages table and NO documents table

### Key Discoveries:
- Sessions table (`schema.sql:1285-1312`) is heavily git-oriented (branch_name, start_commit, etc.) - not suitable for agent sessions
- No messages/conversation history table exists
- Custom JWT hook (`schema.sql:452-500`) already enriches tokens with workspace memberships
- Document tools use `@anthropic-ai/claude-agent-sdk`'s `tool()` + `createSdkMcpServer()` (`document-tools.ts:1-124`)
- Current monorepo has `packages/server` and `packages/client`

## Desired End State

A multitenant API server where:
1. Users authenticate with Supabase JWTs
2. Sessions are workspace-scoped and stored in Supabase
3. Full conversation history (user messages, assistant responses, tool calls, tool results) is persisted in a `messages` table
4. Sessions can be resumed by replaying stored messages
5. The Vercel AI SDK handles LLM interaction with support for Anthropic, OpenAI, and OpenRouter
6. LLM responses stream to clients via SSE
7. Document tools execute server-side against Supabase-backed Yjs documents
8. A shared types package (`packages/shared`) defines the full API contract for the client repo

### Verification:
- All API endpoints require valid Supabase JWT
- Users can only access sessions/documents in their workspace (RLS enforced)
- Creating a session, sending messages, and resuming returns correct data
- Streaming works end-to-end (client receives SSE token events)
- Tool calls execute and results appear in conversation
- `packages/shared` can be installed by the client repo and provides full type coverage

## What We're NOT Doing

- Frontend implementation (handled in client repo, just defining API contract)
- Migration of existing git-oriented sessions to new format
- User/workspace/org management CRUD (already exists)
- Billing or usage tracking
- File/code editing tools (only document tools for now)
- MCP server proxy (may add later)
- Multi-agent orchestration (single agent loop only)
- Real-time collaborative cursors/presence (Yjs awareness exists but not scoped here)

## Implementation Approach

Replace the Claude Agent SDK with the Vercel AI SDK for LLM interaction. Use Hono on Bun for HTTP routing and middleware. Store everything in Supabase with RLS for workspace isolation. Stream responses via SSE. Ship a shared types package first so the client team can work in parallel.

---

## Phase 1: Shared Types Package (`packages/shared`)

### Overview
Create the API contract as a standalone TypeScript package. This is the first deliverable so the client team can start building immediately.

### Changes Required:

#### 1. Package setup
**File**: `packages/shared/package.json`

```json
{
  "name": "@claude-agent/shared",
  "version": "0.1.0",
  "type": "module",
  "main": "index.ts",
  "types": "index.ts",
  "dependencies": {
    "zod": "^3.24.1"
  }
}
```

No build step needed - Bun and the client's bundler can consume `.ts` directly. The client repo installs via:
```json
"@claude-agent/shared": "github:cgrdavies/claude-agent-server#main&path:packages/shared"
```

#### 2. Core domain types
**File**: `packages/shared/types.ts`

```typescript
// ============================================================
// Domain entities (mirror DB shape for the new tables)
// ============================================================

export type AgentSession = {
  id: string
  workspace_id: string
  title: string
  model: string                          // e.g. "claude-sonnet-4-5-20250514"
  provider: Provider
  system_prompt: string | null
  created_by: string                     // user id
  created_at: string                     // ISO 8601
  updated_at: string
  last_message_at: string | null
  archived: boolean
}

export type Provider = 'anthropic' | 'openai' | 'openrouter'

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
  content: string                        // JSON-serialized ModelMessage content
  model: string | null                   // model that generated this (assistant messages only)
  tokens_in: number | null
  tokens_out: number | null
  created_at: string
}

export type MessageRole = 'user' | 'assistant' | 'tool' | 'system'

export type Document = {
  id: string
  workspace_id: string
  name: string
  created_by: string
  created_at: string
  updated_at: string
}

export type DocumentWithContent = Document & {
  content: string                        // markdown
}
```

#### 3. API request/response types
**File**: `packages/shared/api.ts`

```typescript
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
```

#### 4. SSE stream event types
**File**: `packages/shared/stream-events.ts`

These are the events the client receives when streaming an agent response.

```typescript
/**
 * SSE event types for the POST /sessions/:id/messages streaming endpoint.
 * Each event is sent as: `event: <type>\ndata: <JSON>\n\n`
 */

/** Assistant is producing text */
export type TextDeltaEvent = {
  type: 'text-delta'
  delta: string
}

/** Tool call is complete, execution is starting */
export type ToolCallCompleteEvent = {
  type: 'tool-call-complete'
  toolCallId: string
  toolName: string
  args: Record<string, unknown>
}

/** Tool has finished executing, result is available */
export type ToolResultEvent = {
  type: 'tool-result'
  toolCallId: string
  toolName: string
  result: unknown
  isError: boolean
}

/** A full step (LLM round-trip) has completed. */
export type StepCompleteEvent = {
  type: 'step-complete'
  /** Step number in the agent loop (1-based). Increments after each LLM round-trip. */
  stepIndex: number
  tokensIn: number
  tokensOut: number
}

/** The agent loop has finished (no more tool calls or step limit reached) */
export type DoneEvent = {
  type: 'done'
  /** The final assistant text (full, not delta) */
  text: string
  totalTokensIn: number
  totalTokensOut: number
  /** Total LLM round-trips in this response */
  totalSteps: number
}

/** An error occurred during generation */
export type ErrorEvent = {
  type: 'error'
  error: string
  code?: string
}

export type StreamEvent =
  | TextDeltaEvent
  | ToolCallCompleteEvent
  | ToolResultEvent
  | StepCompleteEvent
  | DoneEvent
  | ErrorEvent
```

#### 5. API route definitions
**File**: `packages/shared/routes.ts`

```typescript
/**
 * API route map. Used for documentation and client SDK generation.
 * All routes are prefixed with /api.
 * All routes except /health require Authorization: Bearer <supabase_jwt>.
 */
export const API_ROUTES = {
  // Health
  health: 'GET /health',

  // Sessions
  createSession:  'POST   /api/sessions',
  listSessions:   'GET    /api/sessions',
  getSession:     'GET    /api/sessions/:id',
  updateSession:  'PATCH  /api/sessions/:id',

  // Messages (streaming)
  sendMessage:    'POST   /api/sessions/:id/messages',

  // Documents
  createDocument: 'POST   /api/documents',
  listDocuments:  'GET    /api/documents',
  getDocument:    'GET    /api/documents/:id',
  updateDocument: 'PATCH  /api/documents/:id',
  deleteDocument: 'DELETE /api/documents/:id',

  // Yjs WebSocket (upgrade)
  documentSync:   'GET    /ws/documents/:id',
} as const
```

#### 6. Integration context for the client repo
**File**: `packages/shared/CONTEXT.md`

This file is a prompt/context document that the Claude instance working on the client repo can load to understand the full server-side architecture. It should be referenced in the client repo's `CLAUDE.md` or loaded directly when starting client work.

```markdown
# Agent Server Integration Context

> This document describes the server API for the claude-agent multitenant platform.
> It is the source of truth for how the client should interact with the server.
> Import types from `@claude-agent/shared` - do not redefine them.

## Architecture Overview

The server is a Bun + Hono application that provides:
- REST API for session and document CRUD
- SSE streaming for LLM responses (agent loop with tool calling)
- WebSocket for Yjs document collaboration

All state is stored in Supabase (Postgres). Users authenticate via Supabase Auth.
The server uses the Vercel AI SDK for LLM interaction with support for
Anthropic, OpenAI, and OpenRouter.

## Authentication

Every API request (except `GET /health`) requires:
- `Authorization: Bearer <supabase_jwt>` header
- `X-Workspace-Id: <uuid>` header (or `?workspace_id=<uuid>` query param)

The JWT is a standard Supabase auth token obtained via `supabase.auth.getSession()`.
The workspace ID is the UUID of the workspace the user is currently operating in.
Users may be members of multiple workspaces. The server validates membership on every request.

## API Endpoints

### Sessions

**Create session**: `POST /api/sessions`
- Body: `CreateSessionRequest` (title?, model?, provider?, system_prompt?)
- Response: `CreateSessionResponse` (201)
- Default model: `claude-sonnet-4-5-20250514`, default provider: `anthropic`

**List sessions**: `GET /api/sessions`
- Query: `?cursor=<iso_timestamp>&limit=<number>`
- Response: `ListSessionsResponse` (paginated, sorted by created_at desc)
- Cursor is the `created_at` timestamp of the last item in the page
- Only returns non-archived sessions

**Get session with messages**: `GET /api/sessions/:id`
- Response: `GetSessionResponse` (session + all messages ordered by created_at)
- Use this for session resumption - render all messages in the UI,
  then POST new messages to continue the conversation

**Update session**: `PATCH /api/sessions/:id`
- Body: `UpdateSessionRequest` (title?, archived?)
- Response: `UpdateSessionResponse`

### Messages (Streaming)

**Send message**: `POST /api/sessions/:id/messages`
- Body: `SendMessageRequest` (content, model?, provider?)
- Response: **SSE stream** (not JSON)
- Content-Type: `text/event-stream`

The server runs an agent loop: it calls the LLM, if the LLM requests tool calls,
the server executes them and calls the LLM again, repeating up to 20 times.
Each iteration streams events to the client.

#### SSE Event Sequence

A typical response streams these events in order:

1. `text-delta` (repeated) - chunks of assistant text as they generate
2. If the LLM requests a tool call:
   - `tool-call-complete` - tool name and full arguments
   - `tool-result` - the result of executing the tool
   - `step-complete` - marks the end of one LLM round-trip
   - Then more `text-delta` events as the LLM continues with the tool result
3. `step-complete` - after each LLM round-trip
4. `done` - final event with complete text and token usage

On error: `error` event with message.

All event types are defined in `StreamEvent` from `@claude-agent/shared`.
Parse each SSE event's `data` field as JSON. The `event` field tells you the type.

#### Client-side SSE consumption

```typescript
const response = await fetch(`/api/sessions/${sessionId}/messages`, {
  method: 'POST',
  headers: {
    'Authorization': `Bearer ${jwt}`,
    'X-Workspace-Id': workspaceId,
    'Content-Type': 'application/json',
  },
  body: JSON.stringify({ content: userMessage }),
})

const reader = response.body!.getReader()
const decoder = new TextDecoder()
let buffer = ''

while (true) {
  const { done, value } = await reader.read()
  if (done) break

  buffer += decoder.decode(value, { stream: true })
  const lines = buffer.split('\n')
  buffer = lines.pop()! // keep incomplete line in buffer

  for (const line of lines) {
    if (line.startsWith('data: ')) {
      const event: StreamEvent = JSON.parse(line.slice(6))
      switch (event.type) {
        case 'text-delta':
          // Append event.delta to the assistant message in the UI
          break
        case 'tool-call-complete':
          // Show tool call in UI (event.toolName, event.args)
          break
        case 'tool-result':
          // Show tool result (event.result, event.isError)
          break
        case 'step-complete':
          // Optional: show step progress (event.stepIndex, token usage)
          break
        case 'done':
          // event.text has the full response, event.totalTokensIn/Out for usage
          break
        case 'error':
          // event.error has the error message
          break
      }
    }
  }
}
```

### Documents

**Create document**: `POST /api/documents`
- Body: `CreateDocumentRequest` (name, content?)
- Response: `CreateDocumentResponse` (201)

**List documents**: `GET /api/documents`
- Response: `ListDocumentsResponse`

**Get document**: `GET /api/documents/:id`
- Response: `GetDocumentResponse` (includes markdown content)

**Update document**: `PATCH /api/documents/:id`
- Body: `UpdateDocumentRequest` (name?, content?)
- Response: `UpdateDocumentResponse`

**Delete document**: `DELETE /api/documents/:id`
- Response: `{ success: true }`

### Yjs Document Collaboration (WebSocket)

For real-time collaborative editing, connect via WebSocket:

```
ws://<server>/ws/documents/:id?token=<jwt>&workspace_id=<uuid>
```

This uses the standard Yjs sync protocol (y-protocols). The server handles:
- SyncStep1/SyncStep2 for initial state sync
- Incremental updates broadcast to all connected clients
- Awareness protocol for cursor/presence info

Use `y-websocket` or manual `y-protocols` encoding on the client side.
The Yjs document uses `Y.XmlFragment('default')` with a ProseMirror/TipTap schema.

## Available Agent Tools

The agent has access to these document tools (executed server-side):

| Tool | Description |
|------|-------------|
| `doc_create` | Create a new markdown document (name, content?) |
| `doc_read` | Read a document as markdown (id) |
| `doc_edit` | Find and replace text in a document (id, old_text, new_text) |
| `doc_append` | Append markdown to end of document (id, content) |
| `doc_list` | List all documents in the workspace |
| `doc_delete` | Delete a document permanently (id) |

When the agent calls a tool, the client receives `tool-call-complete` and
`tool-result` SSE events. The UI should show these to the user so they
can see what the agent is doing.

Document edits made by the agent are applied via Yjs transactions,
so connected TipTap editors will see changes in real-time.

## Data Model

### Sessions
- Workspace-scoped (users only see sessions in their workspace)
- Have a model + provider that can be overridden per-message
- Optional system prompt
- Can be archived (soft delete from list view)

### Messages
- Ordered by `created_at` within a session
- Roles: `user`, `assistant`, `tool`, `system`
- The `content` column stores the full AI SDK ModelMessage content as JSON:
  - User/system: JSON string (the text)
  - Assistant: JSON array of content parts (text parts + tool-call parts)
  - Tool: JSON array of tool-result parts (includes toolCallId, toolName, result)
- Full conversation history is loaded when resuming a session and passed
  directly to the AI SDK as ModelMessage[]

### Documents
- Workspace-scoped
- Stored as Yjs CRDT state (binary) + markdown (derived)
- Can be created/edited by both users (via TipTap editor) and the agent (via tools)
- Real-time sync via WebSocket

## Error Responses

All error responses follow `ApiError` format:
```json
{ "error": "Human-readable message", "code": "OPTIONAL_CODE" }
```

Common HTTP status codes:
- 400: Bad request (missing/invalid fields)
- 401: Missing or invalid JWT
- 403: Not a member of the workspace
- 404: Resource not found (or not accessible due to RLS)
- 500: Server error
```

#### 7. Package index
**File**: `packages/shared/index.ts`

```typescript
export * from './types'
export * from './api'
export * from './stream-events'
export * from './routes'
```

Note: `CONTEXT.md` is not exported - it's a documentation file for AI assistants
and developers working on the client repo. Reference it in the client's `CLAUDE.md`:
```markdown
Read packages/node_modules/@claude-agent/shared/CONTEXT.md for the full server API context.
```

### Success Criteria:

#### Automated Verification:
- [x] `cd packages/shared && bun run tsc --noEmit` passes with no errors
- [x] Package can be imported from `packages/server`: add `"@claude-agent/shared": "workspace:*"` to server's package.json, verify `import { AgentSession } from '@claude-agent/shared'` resolves
- [x] No runtime dependencies other than `zod`

#### Manual Verification:
- [ ] Client repo team confirms they can install the package and get full type coverage
- [ ] Type definitions match the agreed API contract
- [ ] SSE event types cover all states the client UI needs to handle
- [ ] `CONTEXT.md` provides enough information for the client-side Claude to build against the API without asking questions about the server

**Implementation Note**: After completing this phase and all automated verification passes, push to main so the client team can install the package and start building.

---

## Phase 2: Database Schema & Migrations

### Overview
Create the new Supabase tables for agent sessions, messages, and documents. Set up RLS policies for workspace isolation.

### Changes Required:

#### 1. New `agent_sessions` table

```sql
CREATE TABLE agent_sessions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id UUID NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  title TEXT NOT NULL DEFAULT 'New Session',
  model TEXT NOT NULL DEFAULT 'claude-sonnet-4-5-20250514',
  provider TEXT NOT NULL DEFAULT 'anthropic'
    CHECK (provider IN ('anthropic', 'openai', 'openrouter')),
  system_prompt TEXT,
  created_by UUID NOT NULL REFERENCES auth.users(id),
  last_message_at TIMESTAMPTZ,
  archived BOOLEAN NOT NULL DEFAULT false,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Indexes
CREATE INDEX idx_agent_sessions_workspace ON agent_sessions(workspace_id);
CREATE INDEX idx_agent_sessions_created_by ON agent_sessions(created_by);
CREATE INDEX idx_agent_sessions_workspace_archived ON agent_sessions(workspace_id, archived);

-- RLS
ALTER TABLE agent_sessions ENABLE ROW LEVEL SECURITY;

CREATE POLICY agent_sessions_select ON agent_sessions FOR SELECT USING (
  workspace_id IN (
    SELECT workspace_id FROM workspace_memberships WHERE user_id = auth.uid()
  )
);

CREATE POLICY agent_sessions_insert ON agent_sessions FOR INSERT WITH CHECK (
  created_by = auth.uid()
  AND workspace_id IN (
    SELECT workspace_id FROM workspace_memberships WHERE user_id = auth.uid()
  )
);

CREATE POLICY agent_sessions_update ON agent_sessions FOR UPDATE USING (
  workspace_id IN (
    SELECT workspace_id FROM workspace_memberships WHERE user_id = auth.uid()
  )
);
```

#### 2. New `messages` table

```sql
CREATE TABLE messages (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  session_id UUID NOT NULL REFERENCES agent_sessions(id) ON DELETE CASCADE,
  role TEXT NOT NULL CHECK (role IN ('user', 'assistant', 'tool', 'system')),
  content TEXT NOT NULL,                    -- JSON-serialized ModelMessage content part
                                            -- user/system: JSON string
                                            -- assistant: JSON array of text + tool-call parts
                                            -- tool: JSON array of tool-result parts
  model TEXT,                               -- model used (assistant only)
  tokens_in INTEGER,
  tokens_out INTEGER,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Indexes
CREATE INDEX idx_messages_session ON messages(session_id);
CREATE INDEX idx_messages_session_created ON messages(session_id, created_at);

-- RLS: messages inherit access from their session's workspace
ALTER TABLE messages ENABLE ROW LEVEL SECURITY;

CREATE POLICY messages_select ON messages FOR SELECT USING (
  session_id IN (
    SELECT id FROM agent_sessions WHERE workspace_id IN (
      SELECT workspace_id FROM workspace_memberships WHERE user_id = auth.uid()
    )
  )
);

CREATE POLICY messages_insert ON messages FOR INSERT WITH CHECK (
  session_id IN (
    SELECT id FROM agent_sessions WHERE workspace_id IN (
      SELECT workspace_id FROM workspace_memberships WHERE user_id = auth.uid()
    )
  )
);
```

#### 3. New `documents` table (replaces local SQLite)

```sql
CREATE TABLE documents (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id UUID NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  yjs_state BYTEA NOT NULL,                 -- Yjs Y.Doc encoded state
  created_by UUID NOT NULL REFERENCES auth.users(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Indexes
CREATE INDEX idx_documents_workspace ON documents(workspace_id);

-- RLS
ALTER TABLE documents ENABLE ROW LEVEL SECURITY;

CREATE POLICY documents_select ON documents FOR SELECT USING (
  workspace_id IN (
    SELECT workspace_id FROM workspace_memberships WHERE user_id = auth.uid()
  )
);

CREATE POLICY documents_insert ON documents FOR INSERT WITH CHECK (
  created_by = auth.uid()
  AND workspace_id IN (
    SELECT workspace_id FROM workspace_memberships WHERE user_id = auth.uid()
  )
);

CREATE POLICY documents_update ON documents FOR UPDATE USING (
  workspace_id IN (
    SELECT workspace_id FROM workspace_memberships WHERE user_id = auth.uid()
  )
);

CREATE POLICY documents_delete ON documents FOR DELETE USING (
  workspace_id IN (
    SELECT workspace_id FROM workspace_memberships WHERE user_id = auth.uid()
  )
);
```

#### 4. Migration file
**File**: `supabase/migrations/YYYYMMDDHHMMSS_add_agent_tables.sql`

Combine the above SQL into a single migration file. Run via Supabase CLI: `supabase db push` or `supabase migration up`.

### Success Criteria:

#### Automated Verification:
- [x] Migration applies cleanly: `supabase db push --dry-run` succeeds
- [x] All three tables exist with correct columns and types
- [x] RLS policies are active on all tables

#### Manual Verification:
- [ ] Verify in Supabase dashboard that tables appear
- [ ] Test RLS by querying as a user - should only see workspace-scoped data
- [ ] Confirm indexes are created

**Implementation Note**: After completing this phase, pause for manual verification that the schema looks correct in Supabase dashboard before proceeding.

---

## Phase 3: Server Foundation (Hono + Auth)

### Overview
Set up the new Hono server with Supabase auth middleware, replacing the current `Bun.serve()` setup.

### Changes Required:

#### 1. New dependencies
**File**: `packages/server/package.json`

Add:
```json
{
  "dependencies": {
    "hono": "^4",
    "@supabase/supabase-js": "^2",
    "@claude-agent/shared": "workspace:*"
  }
}
```

Note: `@supabase/supabase-js` is only used for JWT verification via `getUser()`.
All data queries use `Bun.sql` (direct Postgres connection). See `lib/db.ts` below.

Remove:
```json
{
  "dependencies": {
    "@anthropic-ai/claude-agent-sdk": "^0.1.44"
  }
}
```

(Keep all tiptap/yjs deps - still needed for document tools.)

#### 2. Database connection with RLS context
**File**: `packages/server/lib/db.ts`

```typescript
import { SQL } from 'bun'

/**
 * Direct Postgres connection pool via Bun.sql.
 * Uses the Supabase connection pooler (Transaction mode).
 */
const sql = new SQL({
  url: Bun.env.DATABASE_URL!,   // e.g. postgresql://postgres.[ref]:[password]@[host]:6543/postgres
  max: 20,                       // connection pool size
  idleTimeout: 30,               // seconds
})

/**
 * Execute a query with RLS context set for a specific user.
 * Wraps the query in a transaction that sets the Supabase JWT claims,
 * so all RLS policies using auth.uid() work correctly.
 *
 * Usage:
 *   const rows = await withRLS(userId, (sql) =>
 *     sql`SELECT * FROM agent_sessions WHERE workspace_id = ${workspaceId}`
 *   )
 */
export async function withRLS<T>(
  userId: string,
  fn: (sql: SQL) => Promise<T>,
): Promise<T> {
  return sql.begin(async (tx) => {
    // Set the JWT claims so auth.uid() returns the correct user
    // Both 'sub' and 'role' are required for Supabase RLS to work
    await tx`SELECT set_config('request.jwt.claims', ${JSON.stringify({ sub: userId, role: 'authenticated' })}, true)`
    await tx`SET LOCAL role = 'authenticated'`
    return fn(tx)
  })
}

/**
 * Execute a query as service role (bypasses RLS).
 * Use sparingly - only for admin operations.
 */
export { sql as db }
```

#### 3. Auth middleware
**File**: `packages/server/middleware/auth.ts`

```typescript
import { createMiddleware } from 'hono/factory'
import { createClient } from '@supabase/supabase-js'

type AuthVariables = {
  userId: string
  workspaceId: string
}

/**
 * Verifies Supabase JWT and extracts user + workspace context.
 * Workspace ID comes from ?workspace_id query param or X-Workspace-Id header,
 * validated against the user's workspace_memberships in the JWT claims.
 *
 * JWT verification uses Supabase's getUser() (HTTP call to auth server).
 * All data queries then use Bun.sql with RLS context set via withRLS().
 */
export const authMiddleware = createMiddleware<{ Variables: AuthVariables }>(
  async (c, next) => {
    const authHeader = c.req.header('Authorization')
    if (!authHeader?.startsWith('Bearer ')) {
      return c.json({ error: 'Missing authorization token' }, 401)
    }

    const jwt = authHeader.slice(7)

    // Verify token with Supabase (getUser hits Supabase Auth server)
    const supabase = createClient(
      Bun.env.SUPABASE_URL!,
      Bun.env.SUPABASE_ANON_KEY!,
    )
    const { data: { user }, error } = await supabase.auth.getUser(jwt)

    if (error || !user) {
      return c.json({ error: 'Invalid or expired token' }, 401)
    }

    // Extract workspace ID from header or query param
    const workspaceId =
      c.req.header('X-Workspace-Id') ??
      c.req.query('workspace_id')

    if (!workspaceId) {
      return c.json({ error: 'Missing workspace_id' }, 400)
    }

    // Validate workspace membership from JWT claims
    // (custom_access_token_hook adds workspace_memberships to app_metadata)
    const memberships: Array<{ workspace_id: string }> =
      user.app_metadata?.workspace_memberships ?? []

    const isMember = memberships.some(
      (m) => m.workspace_id === workspaceId,
    )

    if (!isMember) {
      return c.json({ error: 'Not a member of this workspace' }, 403)
    }

    c.set('userId', user.id)
    c.set('workspaceId', workspaceId)

    await next()
  },
)
```

#### 4. Server entry point
**File**: `packages/server/index.ts` (replace existing)

```typescript
import { Hono } from 'hono'
import { cors } from 'hono/cors'
import { logger } from 'hono/logger'
import { authMiddleware } from './middleware/auth'
import { sessionsRouter } from './routes/sessions'
import { messagesRouter } from './routes/messages'
import { documentsRouter } from './routes/documents'
import { handleYjsUpgrade, yjsWebsocket } from './ws/yjs'

const app = new Hono()

// Global middleware
app.use('*', logger())
app.use('*', cors({
  origin: Bun.env.FRONTEND_URL ?? 'http://localhost:5173',
  credentials: true,
}))

// Public
app.get('/health', (c) =>
  c.json({ status: 'ok', timestamp: new Date().toISOString() }),
)

// Protected API routes
const api = new Hono()
api.use('*', authMiddleware)
api.route('/sessions', sessionsRouter)
api.route('/documents', documentsRouter)

// Messages are nested under sessions but defined separately for clarity
// POST /api/sessions/:sessionId/messages
api.route('/sessions', messagesRouter)

app.route('/api', api)

// Start server
const server = Bun.serve({
  port: Number(Bun.env.PORT ?? 4000),
  fetch(req, server) {
    // Handle WebSocket upgrades for Yjs
    const upgraded = handleYjsUpgrade(req, server)
    if (upgraded) return undefined

    return app.fetch(req)
  },
  websocket: yjsWebsocket,
})

console.log(`Server running on http://localhost:${server.port}`)

export { app }
```

#### 5. Environment variables
**File**: `.env.example`

```
# Supabase - ANON_KEY is only used for JWT verification via getUser()
SUPABASE_URL=https://xxx.supabase.co
SUPABASE_ANON_KEY=eyJ...

# Direct Postgres connection (Supabase connection pooler, Transaction mode)
# Format: postgresql://postgres.[ref]:[password]@[host]:6543/postgres
DATABASE_URL=postgresql://...

# LLM providers
ANTHROPIC_API_KEY=sk-ant-...
OPENAI_API_KEY=sk-...
OPENROUTER_API_KEY=sk-or-...

FRONTEND_URL=http://localhost:5173
PORT=4000
```

### Success Criteria:

#### Automated Verification:
- [x] `bun install` succeeds
- [x] `bun run tsc --noEmit` in packages/server passes
- [x] `GET /health` returns 200
- [x] `GET /api/sessions` without JWT returns 401
- [x] `GET /api/sessions` with invalid JWT returns 401

#### Manual Verification:
- [ ] Server starts without errors
- [ ] Auth middleware correctly validates real Supabase JWTs
- [ ] Workspace membership check works against JWT claims

---

## Phase 4: Agent Loop & Message Streaming

### Overview
Implement the core agent loop using Vercel AI SDK. Messages stream to the client via SSE. All messages (user, assistant, tool calls, tool results) are persisted to the `messages` table for session resumption.

### Changes Required:

#### 1. AI SDK dependencies
**File**: `packages/server/package.json`

Add:
```json
{
  "dependencies": {
    "ai": "^6",
    "@ai-sdk/anthropic": "^1",
    "@ai-sdk/openai": "^1",
    "@openrouter/ai-sdk-provider": "^0.4"
  }
}
```

#### 2. Provider factory
**File**: `packages/server/lib/providers.ts`

```typescript
import { anthropic } from '@ai-sdk/anthropic'
import { openai } from '@ai-sdk/openai'
import { createOpenRouter } from '@openrouter/ai-sdk-provider'
import type { Provider } from '@claude-agent/shared'

const openrouter = createOpenRouter({
  apiKey: Bun.env.OPENROUTER_API_KEY,
})

export function getModel(provider: Provider, model: string) {
  switch (provider) {
    case 'anthropic':
      return anthropic(model)
    case 'openai':
      return openai(model)
    case 'openrouter':
      return openrouter(model)
    default:
      throw new Error(`Unknown provider: ${provider}`)
  }
}

export const DEFAULT_MODEL = 'claude-sonnet-4-5-20250514'
export const DEFAULT_PROVIDER: Provider = 'anthropic'
```

#### 3. Document tools (ported to AI SDK format)
**File**: `packages/server/tools/document-tools.ts`

```typescript
import { tool } from 'ai'
import { z } from 'zod'
import * as docManager from '../document-manager'

/**
 * Creates workspace-scoped document tools.
 * Receives both workspaceId and userId so that:
 * - workspaceId scopes which documents are accessible
 * - userId is passed through to withRLS() for DB operations
 */
export function createDocumentTools(workspaceId: string, userId: string) {
  return {
    doc_create: tool({
      description: 'Create a new markdown document in the workspace',
      inputSchema: z.object({
        name: z.string().describe('Document name/title'),
        content: z.string().optional().describe('Initial markdown content'),
      }),
      execute: async ({ name, content }) => {
        const doc = await docManager.createDoc(userId, workspaceId, name, content)
        return { id: doc.id, name: doc.name }
      },
    }),

    doc_read: tool({
      description: 'Read a document as markdown. Returns the full document content.',
      inputSchema: z.object({
        id: z.string().describe('Document ID'),
      }),
      execute: async ({ id }) => {
        const result = await docManager.readDocAsText(userId, workspaceId, id)
        if (!result) return { error: 'Document not found' }
        return { id, name: result.name, content: result.content }
      },
    }),

    doc_edit: tool({
      description:
        'Find and replace text in a document. The old_text must match exactly.',
      inputSchema: z.object({
        id: z.string().describe('Document ID'),
        old_text: z.string().describe('Text to find (must match exactly)'),
        new_text: z.string().describe('Text to replace it with'),
      }),
      execute: async ({ id, old_text, new_text }) => {
        const success = await docManager.editDoc(userId, workspaceId, id, old_text, new_text)
        if (!success) return { success: false, error: 'old_text not found in document' }
        return { success: true }
      },
    }),

    doc_append: tool({
      description: 'Append markdown content to the end of a document.',
      inputSchema: z.object({
        id: z.string().describe('Document ID'),
        content: z.string().describe('Markdown content to append'),
      }),
      execute: async ({ id, content }) => {
        await docManager.appendDoc(userId, workspaceId, id, content)
        return { success: true }
      },
    }),

    doc_list: tool({
      description: 'List all documents in the workspace.',
      inputSchema: z.object({}),
      execute: async () => {
        const documents = await docManager.listDocs(userId, workspaceId)
        return { documents }
      },
    }),

    doc_delete: tool({
      description: 'Delete a document permanently. This cannot be undone.',
      inputSchema: z.object({
        id: z.string().describe('Document ID'),
      }),
      execute: async ({ id }) => {
        await docManager.deleteDoc(userId, workspaceId, id)
        return { success: true }
      },
    }),
  }
}
```

#### 4. Message persistence
**File**: `packages/server/lib/messages.ts`

All data access uses `Bun.sql` via `withRLS()` from `lib/db.ts`.
RLS context is set per-transaction so `auth.uid()` resolves correctly.

Messages store the full AI SDK `ModelMessage` content as JSON.
This means the round-trip is simple: save the content part as-is,
load it back and reconstruct the ModelMessage with `{ role, content }`.

```typescript
import type { SQL } from 'bun'
import type { ModelMessage } from 'ai'
import { withRLS } from './db'

/**
 * Load all messages for a session, ordered by creation time.
 * Returns ModelMessage[] suitable for passing directly to AI SDK.
 */
export async function loadSessionMessages(
  userId: string,
  sessionId: string,
): Promise<ModelMessage[]> {
  const rows = await withRLS(userId, (sql) =>
    sql`SELECT * FROM messages
        WHERE session_id = ${sessionId}
        ORDER BY created_at ASC`
  )
  return rows.map(rowToModelMessage)
}

/**
 * Persist a user message to the database.
 */
export async function saveUserMessage(
  userId: string,
  sessionId: string,
  content: string,
) {
  await withRLS(userId, (sql) =>
    sql`INSERT INTO messages (session_id, role, content)
        VALUES (${sessionId}, 'user', ${JSON.stringify(content)})`
  )
}

/**
 * Persist an assistant message. Stores the full content array including
 * both text parts and tool-call parts as a single JSON value.
 */
export async function saveAssistantMessage(
  userId: string,
  sessionId: string,
  opts: {
    text: string
    toolCalls?: Array<{ toolCallId: string; toolName: string; args: unknown }>
    model: string
    tokensIn: number
    tokensOut: number
  },
) {
  // Build the content array in ModelMessage format
  const contentParts: unknown[] = []
  if (opts.text) {
    contentParts.push({ type: 'text', text: opts.text })
  }
  if (opts.toolCalls?.length) {
    for (const tc of opts.toolCalls) {
      contentParts.push({
        type: 'tool-call',
        toolCallId: tc.toolCallId,
        toolName: tc.toolName,
        args: tc.args,
      })
    }
  }

  // If only text and no tool calls, store as plain string for simplicity
  const content = contentParts.length === 1 && !opts.toolCalls?.length
    ? JSON.stringify(opts.text)
    : JSON.stringify(contentParts)

  await withRLS(userId, (sql) =>
    sql`INSERT INTO messages (session_id, role, content, model, tokens_in, tokens_out)
        VALUES (
          ${sessionId},
          'assistant',
          ${content},
          ${opts.model},
          ${opts.tokensIn},
          ${opts.tokensOut}
        )`
  )
}

/**
 * Persist a tool result message. Stores the full tool-result content
 * part so it can be replayed directly.
 */
export async function saveToolResultMessage(
  userId: string,
  sessionId: string,
  toolCallId: string,
  toolName: string,
  result: unknown,
) {
  const content = JSON.stringify([{
    type: 'tool-result',
    toolCallId,
    toolName,
    result,
  }])

  await withRLS(userId, (sql) =>
    sql`INSERT INTO messages (session_id, role, content)
        VALUES (${sessionId}, 'tool', ${content})`
  )
}

/**
 * Convert a DB row back to a ModelMessage for AI SDK replay.
 * Since we store the content in ModelMessage format, reconstruction
 * is just JSON.parse + wrapping with the role.
 */
function rowToModelMessage(row: Record<string, unknown>): ModelMessage {
  const role = row.role as string
  const content = JSON.parse(row.content as string)

  return { role, content } as ModelMessage
}
```

#### 5. Messages route (SSE streaming agent loop)
**File**: `packages/server/routes/messages.ts`

```typescript
import { Hono } from 'hono'
import { streamSSE } from 'hono/streaming'
import { streamText, stepCountIs } from 'ai'
import type { SendMessageRequest, StreamEvent } from '@claude-agent/shared'
import { withRLS } from '../lib/db'
import { getModel } from '../lib/providers'
import { createDocumentTools } from '../tools/document-tools'
import {
  loadSessionMessages,
  saveUserMessage,
  saveAssistantMessage,
  saveToolResultMessage,
} from '../lib/messages'

export const messagesRouter = new Hono()

/**
 * POST /api/sessions/:sessionId/messages
 *
 * Sends a user message, runs the agent loop (tool calling in a loop),
 * and streams the response as SSE events.
 */
messagesRouter.post('/:sessionId/messages', async (c) => {
  const userId = c.get('userId')
  const workspaceId = c.get('workspaceId')
  const sessionId = c.req.param('sessionId')
  const body = await c.req.json<SendMessageRequest>()

  // Verify session exists and user has access (RLS handles this)
  const [session] = await withRLS(userId, (sql) =>
    sql`SELECT * FROM agent_sessions WHERE id = ${sessionId} LIMIT 1`
  )

  if (!session) {
    return c.json({ error: 'Session not found' }, 404)
  }

  // Use session's model/provider unless overridden in this message
  const provider = body.provider ?? session.provider
  const modelId = body.model ?? session.model
  const model = getModel(provider, modelId)

  // Save user message
  await saveUserMessage(userId, sessionId, body.content)

  // Load full conversation history for this session
  const previousMessages = await loadSessionMessages(userId, sessionId)

  // Create workspace-scoped tools (needs userId for RLS on doc operations)
  const tools = createDocumentTools(workspaceId, userId)

  return streamSSE(c, async (stream) => {
    let totalTokensIn = 0
    let totalTokensOut = 0
    let stepIndex = 0
    let fullText = ''

    try {
      const result = streamText({
        model,
        messages: previousMessages,
        tools,
        stopWhen: stepCountIs(20),  // max tool-call round-trips
        system: session.system_prompt ?? undefined,
        onStepFinish: async (step) => {
          // Persist assistant message after each step
          if (step.text || step.toolCalls?.length) {
            await saveAssistantMessage(userId, sessionId, {
              text: step.text,
              toolCalls: step.toolCalls?.map((tc) => ({
                toolCallId: tc.toolCallId,
                toolName: tc.toolName,
                args: tc.args,
              })),
              model: modelId,
              tokensIn: step.usage?.promptTokens ?? 0,
              tokensOut: step.usage?.completionTokens ?? 0,
            })
          }

          // Persist tool results (include toolName for ModelMessage format)
          if (step.toolResults) {
            for (const tr of step.toolResults) {
              await saveToolResultMessage(
                userId,
                sessionId,
                tr.toolCallId,
                tr.toolName,
                tr.result,
              )
            }
          }

          totalTokensIn += step.usage?.promptTokens ?? 0
          totalTokensOut += step.usage?.completionTokens ?? 0
          stepIndex++

          await stream.writeSSE({
            event: 'step-complete',
            data: JSON.stringify({
              type: 'step-complete',
              stepIndex,
              tokensIn: step.usage?.promptTokens ?? 0,
              tokensOut: step.usage?.completionTokens ?? 0,
            } satisfies StreamEvent),
          })
        },
      })

      // Stream text deltas and tool events to the client
      for await (const part of result.fullStream) {
        if (part.type === 'text-delta') {
          fullText += part.textDelta
          await stream.writeSSE({
            event: 'text-delta',
            data: JSON.stringify({
              type: 'text-delta',
              delta: part.textDelta,
            } satisfies StreamEvent),
          })
        } else if (part.type === 'tool-call') {
          await stream.writeSSE({
            event: 'tool-call-complete',
            data: JSON.stringify({
              type: 'tool-call-complete',
              toolCallId: part.toolCallId,
              toolName: part.toolName,
              args: part.args,
            } satisfies StreamEvent),
          })
        } else if (part.type === 'tool-result') {
          await stream.writeSSE({
            event: 'tool-result',
            data: JSON.stringify({
              type: 'tool-result',
              toolCallId: part.toolCallId,
              toolName: part.toolName,
              result: part.result,
              isError: false,
            } satisfies StreamEvent),
          })
        }
      }

      // Update session last_message_at
      await withRLS(userId, (sql) =>
        sql`UPDATE agent_sessions
            SET last_message_at = now(), updated_at = now()
            WHERE id = ${sessionId}`
      )

      await stream.writeSSE({
        event: 'done',
        data: JSON.stringify({
          type: 'done',
          text: fullText,
          totalTokensIn,
          totalTokensOut,
          totalSteps: stepIndex,
        } satisfies StreamEvent),
      })
    } catch (err) {
      await stream.writeSSE({
        event: 'error',
        data: JSON.stringify({
          type: 'error',
          error: err instanceof Error ? err.message : String(err),
        } satisfies StreamEvent),
      })
    }
  })
})
```

### Success Criteria:

#### Automated Verification:
- [x] `bun run tsc --noEmit` passes
- [x] `bun test` passes for message persistence helpers (unit tests with test DB)
- [x] Provider factory resolves all three providers without errors

#### Manual Verification:
- [ ] Create a session, send a message, receive streamed response via SSE
- [ ] Tool calls execute (e.g. ask the agent to create a document)
- [ ] Messages appear in the `messages` table with correct roles and content
- [ ] Resume a session: reload page, send another message, agent has full context
- [ ] Test with at least two providers (Anthropic + OpenAI or OpenRouter)

**Implementation Note**: This is the most complex phase. Test the agent loop thoroughly before proceeding. Verify that the persisted messages round-trip correctly (save -> load -> send to AI SDK -> same behavior).

---

## Phase 5: Session & Document CRUD

### Overview
Implement the REST endpoints for session management and document CRUD.

### Changes Required:

#### 1. Sessions routes
**File**: `packages/server/routes/sessions.ts`

```typescript
import { Hono } from 'hono'
import type {
  CreateSessionRequest,
  CreateSessionResponse,
  GetSessionResponse,
  ListSessionsResponse,
  UpdateSessionRequest,
  UpdateSessionResponse,
} from '@claude-agent/shared'
import { withRLS } from '../lib/db'
import { DEFAULT_MODEL, DEFAULT_PROVIDER } from '../lib/providers'

export const sessionsRouter = new Hono()

// POST /api/sessions
sessionsRouter.post('/', async (c) => {
  const userId = c.get('userId')
  const workspaceId = c.get('workspaceId')
  const body = await c.req.json<CreateSessionRequest>()

  const title = body.title ?? 'New Session'
  const model = body.model ?? DEFAULT_MODEL
  const provider = body.provider ?? DEFAULT_PROVIDER
  const systemPrompt = body.system_prompt ?? null

  const [session] = await withRLS(userId, (sql) =>
    sql`INSERT INTO agent_sessions (workspace_id, title, model, provider, system_prompt, created_by)
        VALUES (${workspaceId}, ${title}, ${model}, ${provider}, ${systemPrompt}, ${userId})
        RETURNING *`
  )

  return c.json({ session } satisfies CreateSessionResponse, 201)
})

// GET /api/sessions
// Cursor-based pagination using created_at (always non-null, unlike last_message_at)
sessionsRouter.get('/', async (c) => {
  const userId = c.get('userId')
  const workspaceId = c.get('workspaceId')
  const cursor = c.req.query('cursor')
  const limit = Math.min(Number(c.req.query('limit') ?? 50), 100)

  const sessions = await withRLS(userId, (sql) =>
    cursor
      ? sql`SELECT * FROM agent_sessions
            WHERE workspace_id = ${workspaceId}
              AND archived = false
              AND created_at < ${cursor}
            ORDER BY created_at DESC
            LIMIT ${limit + 1}`
      : sql`SELECT * FROM agent_sessions
            WHERE workspace_id = ${workspaceId}
              AND archived = false
            ORDER BY created_at DESC
            LIMIT ${limit + 1}`
  )

  const hasMore = sessions.length > limit
  const page = hasMore ? sessions.slice(0, limit) : sessions
  const nextCursor = hasMore
    ? page[page.length - 1]?.created_at
    : null

  return c.json({
    data: page,
    cursor: nextCursor,
  } satisfies ListSessionsResponse)
})

// GET /api/sessions/:id
sessionsRouter.get('/:id', async (c) => {
  const userId = c.get('userId')
  const sessionId = c.req.param('id')

  // Run both queries in the same RLS transaction
  const result = await withRLS(userId, async (sql) => {
    const [session] = await sql`SELECT * FROM agent_sessions WHERE id = ${sessionId} LIMIT 1`
    if (!session) return null

    const messages = await sql`SELECT * FROM messages
                               WHERE session_id = ${sessionId}
                               ORDER BY created_at ASC`
    return { session, messages }
  })

  if (!result) return c.json({ error: 'Session not found' }, 404)

  return c.json({
    session: result.session,
    messages: result.messages,
  } satisfies GetSessionResponse)
})

// PATCH /api/sessions/:id
sessionsRouter.patch('/:id', async (c) => {
  const userId = c.get('userId')
  const sessionId = c.req.param('id')
  const body = await c.req.json<UpdateSessionRequest>()

  // Build update dynamically based on provided fields
  const [session] = await withRLS(userId, async (sql) => {
    if (body.title !== undefined && body.archived !== undefined) {
      return sql`UPDATE agent_sessions
                 SET title = ${body.title}, archived = ${body.archived}, updated_at = now()
                 WHERE id = ${sessionId} RETURNING *`
    } else if (body.title !== undefined) {
      return sql`UPDATE agent_sessions
                 SET title = ${body.title}, updated_at = now()
                 WHERE id = ${sessionId} RETURNING *`
    } else if (body.archived !== undefined) {
      return sql`UPDATE agent_sessions
                 SET archived = ${body.archived}, updated_at = now()
                 WHERE id = ${sessionId} RETURNING *`
    }
    return sql`SELECT * FROM agent_sessions WHERE id = ${sessionId} LIMIT 1`
  })

  if (!session) return c.json({ error: 'Session not found' }, 404)
  return c.json({ session } satisfies UpdateSessionResponse)
})
```

#### 2. Documents routes
**File**: `packages/server/routes/documents.ts`

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
import { withRLS } from '../lib/db'
import * as docManager from '../document-manager'

export const documentsRouter = new Hono()

// POST /api/documents
documentsRouter.post('/', async (c) => {
  const userId = c.get('userId')
  const workspaceId = c.get('workspaceId')
  const body = await c.req.json<CreateDocumentRequest>()

  // Create Yjs doc in memory and get initial state
  const doc = await docManager.createDoc(workspaceId, body.name, body.content)

  // Persist to Postgres
  const [document] = await withRLS(userId, (sql) =>
    sql`INSERT INTO documents (id, workspace_id, name, yjs_state, created_by)
        VALUES (${doc.id}, ${workspaceId}, ${body.name}, ${doc.yjsState}, ${userId})
        RETURNING id, workspace_id, name, created_by, created_at, updated_at`
  )

  return c.json({ document } satisfies CreateDocumentResponse, 201)
})

// GET /api/documents
documentsRouter.get('/', async (c) => {
  const userId = c.get('userId')
  const workspaceId = c.get('workspaceId')

  const documents = await withRLS(userId, (sql) =>
    sql`SELECT id, workspace_id, name, created_by, created_at, updated_at
        FROM documents
        WHERE workspace_id = ${workspaceId}
        ORDER BY updated_at DESC`
  )

  return c.json({ documents } satisfies ListDocumentsResponse)
})

// GET /api/documents/:id
documentsRouter.get('/:id', async (c) => {
  const userId = c.get('userId')
  const docId = c.req.param('id')

  const [doc] = await withRLS(userId, (sql) =>
    sql`SELECT id, workspace_id, name, created_by, created_at, updated_at
        FROM documents WHERE id = ${docId} LIMIT 1`
  )

  if (!doc) return c.json({ error: 'Document not found' }, 404)

  const content = await docManager.readDocAsText(doc.workspace_id, docId)
  if (!content) return c.json({ error: 'Document not found' }, 404)

  return c.json({
    document: { ...doc, content: content.content },
  } satisfies GetDocumentResponse)
})

// PATCH /api/documents/:id
documentsRouter.patch('/:id', async (c) => {
  const userId = c.get('userId')
  const docId = c.req.param('id')
  const body = await c.req.json<UpdateDocumentRequest>()

  if (body.content !== undefined) {
    // Update Yjs doc content (needs workspace_id from DB)
    const [existing] = await withRLS(userId, (sql) =>
      sql`SELECT workspace_id FROM documents WHERE id = ${docId} LIMIT 1`
    )
    if (!existing) return c.json({ error: 'Document not found' }, 404)
    await docManager.replaceDocContent(existing.workspace_id, docId, body.content)
  }

  const [document] = await withRLS(userId, (sql) =>
    body.name !== undefined
      ? sql`UPDATE documents SET name = ${body.name}, updated_at = now()
            WHERE id = ${docId}
            RETURNING id, workspace_id, name, created_by, created_at, updated_at`
      : sql`UPDATE documents SET updated_at = now()
            WHERE id = ${docId}
            RETURNING id, workspace_id, name, created_by, created_at, updated_at`
  )

  if (!document) return c.json({ error: 'Document not found' }, 404)
  return c.json({ document } satisfies UpdateDocumentResponse)
})

// DELETE /api/documents/:id
documentsRouter.delete('/:id', async (c) => {
  const userId = c.get('userId')
  const docId = c.req.param('id')

  const result = await withRLS(userId, (sql) =>
    sql`DELETE FROM documents WHERE id = ${docId} RETURNING id`
  )

  if (result.length === 0) return c.json({ error: 'Document not found' }, 404)
  return c.json({ success: true })
})
```

### Success Criteria:

#### Automated Verification:
- [x] `bun run tsc --noEmit` passes
- [x] `bun test` passes for route handlers
- [x] All CRUD endpoints return correct status codes and shapes matching shared types

#### Manual Verification:
- [x] Create, list, get, update, archive sessions through API
- [x] Create, list, get, update, delete documents through API
- [ ] RLS prevents cross-workspace access (test with two different workspace users)
- [x] Pagination works for session listing

---

## Phase 6: Yjs Document Collaboration (Supabase-backed)

### Overview
Migrate Yjs document storage from local SQLite to Supabase. Keep the WebSocket sync protocol but add auth and workspace scoping.

### Changes Required:

#### 1. Update document manager to use Supabase
**File**: `packages/server/document-manager.ts`

Refactor to:
- Load/save Yjs state from Supabase `documents.yjs_state` (BYTEA) instead of local SQLite
- Accept `workspaceId` parameter on all operations for scoping
- Keep in-memory Y.Doc cache keyed by `docId`
- Persist to Supabase on Y.Doc `update` events (debounced)

#### 2. Update WebSocket handler with auth
**File**: `packages/server/ws/yjs.ts`

- Authenticate WebSocket upgrade via `?token=<jwt>` query param
- Verify workspace membership and document access before upgrade
- Pass `workspaceId` and `userId` in `ws.data`
- Keep existing Yjs sync protocol (SyncStep1/SyncStep2, awareness)

#### 3. Remove local SQLite dependency
**File**: `packages/server/db.ts`

Delete this file. All storage moves to Supabase.

### Success Criteria:

#### Automated Verification:
- [x] `bun run tsc --noEmit` passes
- [x] `bun test` passes for document manager with test DB
- [x] No references to `bun:sqlite` remain in codebase

#### Manual Verification:
- [ ] Create a document via API, open it in the client editor
- [ ] Edit in real-time with two clients connected
- [ ] Yjs state persists to Supabase (check `documents.yjs_state` column)
- [ ] Agent tool edits appear in real-time in connected editors
- [ ] WebSocket rejects unauthenticated connections

**Implementation Note**: After completing this phase, the entire system should be functional end-to-end. Do thorough integration testing before declaring done.

---

## Testing Strategy

### Unit Tests:
- Message persistence: save/load round-trip, CoreMessage reconstruction
- Provider factory: all three providers resolve
- Auth middleware: valid JWT, invalid JWT, missing workspace, non-member
- Tool definitions: each tool executes correctly with mocked doc manager

### Integration Tests:
- Full agent loop: send message -> tool call -> tool result -> response
- Session resume: create session, send messages, reload, verify context preserved
- Workspace isolation: user A can't see user B's sessions/documents
- SSE streaming: verify event sequence matches shared types

### Manual Testing Steps:
1. Log in via Supabase, select workspace
2. Create new session, send a message
3. Verify streamed response appears
4. Ask agent to create/edit a document
5. Open document in editor, verify content
6. Reload page, resume session, verify context
7. Test with a second user in same workspace (can see shared docs)
8. Test with a user in different workspace (can't see anything)

## Frontend Notes (for client repo)

- Install `@claude-agent/shared` from the server repo for full type coverage
- Replace WebSocket chat connection with SSE streaming (`EventSource` or `fetch` with `ReadableStream`)
- Auth: pass Supabase JWT as `Authorization: Bearer <token>` header
- Pass workspace ID as `X-Workspace-Id` header on all API requests
- Session list: `GET /api/sessions` with cursor-based pagination
- Send message: `POST /api/sessions/:id/messages` returns SSE stream
- Resume: `GET /api/sessions/:id` returns session + all messages
- Document collaboration: WebSocket to `/ws/documents/:id?token=<jwt>` (same Yjs protocol)
- Handle all `StreamEvent` types from `@claude-agent/shared/stream-events`

## Performance Considerations

- **Bun.sql connection pool**: Pool size of 20 should handle moderate load. Use Supabase's Transaction mode pooler (`port 6543`) for connection multiplexing. Each `withRLS()` call acquires a connection, sets RLS context, runs the query, and releases - the two `SET` calls per request add negligible overhead (~0.1ms).
- **Message table growth**: Index on `(session_id, created_at)` handles efficient history loading. Consider archiving old sessions if table grows large.
- **Yjs state persistence**: Debounce writes to Postgres (e.g. 500ms) to avoid excessive updates during rapid editing.
- **RLS subquery performance**: The `workspace_memberships` subquery in RLS policies runs on every query. The index on `workspace_memberships(user_id)` is critical. Consider a materialized view or caching if this becomes a bottleneck.
- **SSE connection limits**: Browsers limit to ~6 SSE connections per domain. Only one should be active per session.
- **AI SDK `maxSteps`**: Set to 20 to prevent runaway tool loops. Monitor and adjust.

## Migration Notes

- The existing container-based server can continue running during development
- No data migration needed - this is a fresh set of tables (`agent_sessions`, `messages`, `documents`)
- The old `sessions` table is untouched
- Old client can keep using the old server until the new API is ready
- Cut over by pointing the client to the new API endpoints

## References

- Vercel AI SDK docs: https://ai-sdk.dev
- AI SDK `streamText`: https://ai-sdk.dev/docs/reference/ai-sdk-core/stream-text
- AI SDK `tool`: https://ai-sdk.dev/docs/reference/ai-sdk-core/tool
- Hono docs: https://hono.dev
- Hono SSE streaming: https://hono.dev/docs/helpers/streaming
- Supabase RLS: https://supabase.com/docs/guides/auth/row-level-security
- Supabase auth server-side: https://supabase.com/docs/guides/auth/server-side/advanced-guide
