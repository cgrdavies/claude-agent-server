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
