# Concurrent Sessions Implementation Plan

## Overview

Enable the claude-agent-server to support multiple concurrent sessions per WebSocket connection, and multiple simultaneous WebSocket connections. Each client (user) maintains one WebSocket connection over which they can create and interact with multiple independent Claude Agent SDK sessions. Session lifecycle is managed via REST endpoints; real-time messaging flows over WebSocket with `session_id` as the routing key.

## Current State Analysis

The server enforces a 1-to-1 model with all state as module-level singletons (`packages/server/index.ts:36-46`):

- `activeConnection: ServerWebSocket | null` - single WebSocket allowed
- `messageQueue: SDKUserMessage[]` - single shared queue
- `activeStream: ReturnType<typeof query> | null` - single SDK stream
- `queryConfig: QueryConfig` - single global config

A second WebSocket connection is rejected at `index.ts:316-323`. The global `POST /config` endpoint sets config for the one stream.

The Claude Agent SDK's `query()` returns independent `Query` async generators with no documented concurrency constraints. Each SDK message already carries a `session_id`. The SDK supports this architecture natively.

### Key Discoveries:
- `query()` can be called multiple times concurrently, each returning an independent async generator (`node_modules/@anthropic-ai/claude-agent-sdk/sdk.d.ts:551-554`)
- Every SDK message type includes `session_id` as a field - this is already the natural routing key
- The SDK `Options` type includes `abortController` for per-query cancellation (`sdk.d.ts:488`)
- Session resume is built into the SDK via `Options.resume` (`sdk.d.ts:535`)

## Desired End State

- Multiple WebSocket connections accepted simultaneously (one per client/user)
- Each connection can have multiple active sessions running concurrently
- Sessions created via `POST /sessions` with per-session config, returning a session ID
- Sessions torn down via `DELETE /sessions/:id`
- User messages routed to the correct session's SDK stream by `session_id`
- SDK responses routed back to the correct WebSocket connection by tracking which connection owns which session
- When a WebSocket disconnects, all sessions owned by that connection are immediately interrupted and cleaned up
- Global `POST /config` endpoint removed (breaking change accepted)

### Verification:
- Multiple clients can connect via WebSocket simultaneously
- A single client can create multiple sessions and send messages to each
- SDK responses arrive on the correct WebSocket with correct `session_id`
- Disconnecting a client tears down only that client's sessions
- `GET /sessions` and `GET /sessions/:id` continue to work
- Session resume works via creating a new session with `resume` in the config

## What We're NOT Doing

- Authentication/authorization per connection (no user identity system)
- Transparent reconnection or session keepalive on disconnect
- WebSocket library (staying with Bun built-in WebSockets)
- Rate limiting or resource quotas per connection
- Shared sessions between connections
- Client-side connection pooling

## Implementation Approach

Replace singleton state with two maps: a **session map** (`Map<string, Session>`) holding per-session state (queue, stream, config, owning connection), and a **connection map** (`Map<ServerWebSocket, ConnectionState>`) tracking which sessions belong to each connection. Session lifecycle moves to REST endpoints. The WebSocket handler becomes a router that dispatches messages by `session_id`.

---

## Phase 1: Server-Side Data Structures and Session Manager

### Overview
Introduce the core data structures and a session manager module that encapsulates session lifecycle (create, destroy, route messages). This replaces the singleton state.

### Changes Required:

#### 1. New file: `packages/server/session-manager.ts`

Create a session manager that owns all session and connection state:

```typescript
import { query, type Options, type SDKUserMessage } from '@anthropic-ai/claude-agent-sdk'
import { type ServerWebSocket } from 'bun'
import { type QueryConfig, type WSOutputMessage } from './message-types'

export type Session = {
  id: string
  config: QueryConfig
  messageQueue: SDKUserMessage[]
  stream: ReturnType<typeof query> | null
  connection: ServerWebSocket
}

export type ConnectionState = {
  sessions: Set<string>
}

// Maps
const sessions = new Map<string, Session>()
const connections = new Map<ServerWebSocket, ConnectionState>()

// --- Connection lifecycle ---

export function registerConnection(ws: ServerWebSocket): void {
  connections.set(ws, { sessions: new Set() })
}

export function unregisterConnection(ws: ServerWebSocket): void {
  const state = connections.get(ws)
  if (state) {
    // Tear down all sessions for this connection
    for (const sessionId of state.sessions) {
      destroySession(sessionId)
    }
    connections.delete(ws)
  }
}

// --- Session lifecycle ---

export function createSession(
  ws: ServerWebSocket,
  sessionId: string,
  config: QueryConfig,
): void {
  if (sessions.has(sessionId)) {
    throw new Error(`Session ${sessionId} already exists`)
  }
  const connState = connections.get(ws)
  if (!connState) {
    throw new Error('Connection not registered')
  }

  const session: Session = {
    id: sessionId,
    config,
    messageQueue: [],
    stream: null,
    connection: ws,
  }

  sessions.set(sessionId, session)
  connState.sessions.add(sessionId)

  // Start the SDK query stream for this session
  startSessionStream(session)
}

export function destroySession(sessionId: string): void {
  const session = sessions.get(sessionId)
  if (!session) return

  if (session.stream) {
    session.stream.interrupt()
    session.stream = null
  }
  session.messageQueue.length = 0

  // Remove from connection's session set
  const connState = connections.get(session.connection)
  if (connState) {
    connState.sessions.delete(sessionId)
  }

  sessions.delete(sessionId)
}

export function getSession(sessionId: string): Session | undefined {
  return sessions.get(sessionId)
}

export function getConnectionState(ws: ServerWebSocket): ConnectionState | undefined {
  return connections.get(ws)
}

// --- Message routing ---

export function pushMessage(sessionId: string, message: SDKUserMessage): void {
  const session = sessions.get(sessionId)
  if (!session) {
    throw new Error(`Session ${sessionId} not found`)
  }
  session.messageQueue.push(message)
}

export function interruptSession(sessionId: string): void {
  const session = sessions.get(sessionId)
  if (!session) return
  session.stream?.interrupt()
}

// --- Internal ---

async function* generateMessages(session: Session) {
  while (true) {
    while (session.messageQueue.length > 0) {
      const message = session.messageQueue.shift()
      yield message!
    }
    await new Promise(resolve => setTimeout(resolve, 10))
  }
}

async function startSessionStream(session: Session) {
  try {
    const options: Options = {
      permissionMode: 'bypassPermissions',
      allowDangerouslySkipPermissions: true,
      settingSources: ['local'],
      cwd: workspaceDirectory,
      stderr: data => {
        sendToSession(session, { type: 'info', data })
      },
      ...session.config,
      env: {
        PATH: process.env.PATH,
        ...(session.config.anthropicApiKey && {
          ANTHROPIC_API_KEY: session.config.anthropicApiKey,
        }),
        ...(process.env.CLAUDE_CODE_OAUTH_TOKEN && {
          CLAUDE_CODE_OAUTH_TOKEN: process.env.CLAUDE_CODE_OAUTH_TOKEN,
        }),
      },
    }

    session.stream = query({
      prompt: generateMessages(session),
      options,
    })

    for await (const message of session.stream) {
      sendToSession(session, { type: 'sdk_message', data: message })
    }
  } catch (error) {
    sendToSession(session, {
      type: 'error',
      error: error instanceof Error ? error.message : 'Unknown error',
    })
  }
}

function sendToSession(session: Session, output: WSOutputMessage): void {
  try {
    session.connection.send(JSON.stringify(output))
  } catch {
    // Connection may have closed
  }
}
```

Note: `workspaceDirectory` needs to be imported from `const.ts` (add the export there).

#### 2. Update `packages/server/const.ts`

Export the workspace directory path for use by the session manager:

```typescript
import { homedir } from 'os'
import { join } from 'path'

export const SERVER_PORT = 4000
export const WORKSPACE_DIR_NAME = 'agent-workspace'
export const workspaceDirectory = join(homedir(), WORKSPACE_DIR_NAME)
```

### Success Criteria:

#### Automated Verification:
- [ ] TypeScript compiles cleanly: `bunx tsc --noEmit`
- [ ] Session manager module exports all expected functions
- [ ] Unit tests pass for session creation, destruction, message routing: `bun test`

#### Manual Verification:
- [ ] Code review confirms no singleton state remains in session-manager.ts

---

## Phase 2: Update Message Types and Handler

### Overview
Update the WebSocket message types to support per-session interrupts and add types for session creation responses. Update the message handler to route messages through the session manager.

### Changes Required:

#### 1. `packages/server/message-types.ts`

Update the interrupt message to include an optional `session_id` and add a session-related output message:

```typescript
// Input: interrupt now targets a specific session
export type WSInputMessage =
  | {
      type: 'user_message'
      data: SDKUserMessage
    }
  | { type: 'interrupt'; session_id?: string }

// Output: add session_created and session_destroyed
export type WSOutputMessage =
  | { type: 'connected' }
  | { type: 'sdk_message'; data: SDKMessage }
  | { type: 'error'; error: string }
  | { type: 'info'; data: string }
```

#### 2. `packages/server/message-handler.ts`

Update to route through the session manager instead of using the singleton queue:

```typescript
import { type ServerWebSocket } from 'bun'
import * as sessionManager from './session-manager'
import { type WSInputMessage, type WSOutputMessage } from './message-types'

export async function handleMessage(
  ws: ServerWebSocket,
  message: string | Buffer,
) {
  try {
    const input = JSON.parse(message.toString()) as WSInputMessage

    if (input.type === 'user_message') {
      const sessionId = input.data.session_id
      if (!sessionId) {
        sendError(ws, 'user_message must include session_id')
        return
      }
      const session = sessionManager.getSession(sessionId)
      if (!session) {
        sendError(ws, `Session ${sessionId} not found. Create it via POST /sessions first.`)
        return
      }
      if (session.connection !== ws) {
        sendError(ws, `Session ${sessionId} belongs to a different connection`)
        return
      }
      sessionManager.pushMessage(sessionId, input.data)
    } else if (input.type === 'interrupt') {
      if (input.session_id) {
        sessionManager.interruptSession(input.session_id)
      }
    }
  } catch (error) {
    sendError(ws, `Invalid message format: ${error instanceof Error ? error.message : String(error)}`)
  }
}

function sendError(ws: ServerWebSocket, error: string) {
  ws.send(JSON.stringify({ type: 'error', error } as WSOutputMessage))
}
```

### Success Criteria:

#### Automated Verification:
- [ ] TypeScript compiles cleanly: `bunx tsc --noEmit`
- [ ] Message handler correctly validates session ownership
- [ ] Unit tests for message routing: `bun test`

#### Manual Verification:
- [ ] Sending a message to a non-existent session returns an error
- [ ] Sending a message to another connection's session returns an error

---

## Phase 3: Update Server Entry Point

### Overview
Rewrite `packages/server/index.ts` to remove all singleton state, allow multiple WebSocket connections, add the `POST /sessions` and `DELETE /sessions/:id` endpoints, and remove `POST /config`.

### Changes Required:

#### 1. `packages/server/index.ts`

Major changes:
- Remove: `activeConnection`, `messageQueue`, `activeStream`, `queryConfig`, `restartStream()`, `generateMessages()`, `processMessages()`
- Remove: `POST /config`, `GET /config` endpoints
- Add: `POST /sessions` - creates a session with config, returns `{ sessionId }`
- Add: `DELETE /sessions/:id` - destroys a session
- Update: WebSocket `open` to allow multiple connections via `registerConnection()`
- Update: WebSocket `close` to call `unregisterConnection()`
- Update: WebSocket `message` to call the updated `handleMessage()` (no context parameter needed)
- Keep: `GET /sessions`, `GET /sessions/:id`, `/health`, `/files/*` endpoints unchanged

New REST endpoints:

```typescript
// POST /sessions - Create a new session
if (url.pathname === '/sessions' && req.method === 'POST') {
  try {
    const body = await req.json() as { sessionId: string; config?: QueryConfig }
    if (!body.sessionId) {
      return Response.json({ error: 'sessionId is required' }, { status: 400 })
    }
    // Session will be attached to the next WebSocket that sends a message to it
    // For now, store the pending config and let the WS message handler attach it
    // OR: require a ws connection reference... but REST doesn't have one.
    //
    // Design note: Since we need to associate a session with a WebSocket connection,
    // and REST endpoints don't have access to the WebSocket, we need to handle this
    // by having the client provide a connection_id or by creating the session
    // when the first message arrives on the WebSocket.
    //
    // Approach: REST creates a "pending" session config. The first WebSocket message
    // with that session_id from any connection claims ownership.
    pendingSessions.set(body.sessionId, body.config || {})
    return Response.json({ sessionId: body.sessionId })
  } catch {
    return Response.json({ error: 'Invalid JSON' }, { status: 400 })
  }
}

// DELETE /sessions/:id - Destroy a session
if (url.pathname.startsWith('/sessions/') && req.method === 'DELETE') {
  const sessionId = url.pathname.slice('/sessions/'.length)
  sessionManager.destroySession(sessionId)
  return Response.json({ success: true })
}
```

**Key design refinement**: Since REST endpoints don't have access to the WebSocket connection, we need a two-step approach:
1. `POST /sessions` stores the session config in a `pendingSessions` map
2. When the first `user_message` arrives on a WebSocket with a `session_id` that's in `pendingSessions`, the session manager creates the session, attaches it to that WebSocket connection, and starts the stream

Update the message handler to handle this claim-on-first-message pattern:

```typescript
// In handleMessage, when session not found but pending:
if (!session) {
  const pendingConfig = pendingSessions.get(sessionId)
  if (pendingConfig) {
    pendingSessions.delete(sessionId)
    sessionManager.createSession(ws, sessionId, pendingConfig)
    sessionManager.pushMessage(sessionId, input.data)
  } else {
    sendError(ws, `Session ${sessionId} not found`)
  }
  return
}
```

WebSocket handler changes:

```typescript
websocket: {
  open(ws) {
    sessionManager.registerConnection(ws)
    ws.send(JSON.stringify({ type: 'connected' } as WSOutputMessage))
  },
  async message(ws, message) {
    await handleMessage(ws, message)
  },
  close(ws) {
    sessionManager.unregisterConnection(ws)
  },
}
```

### Success Criteria:

#### Automated Verification:
- [ ] TypeScript compiles cleanly: `bunx tsc --noEmit`
- [ ] No references to old singleton variables remain
- [ ] Server starts without errors: `bun run packages/server/index.ts`
- [ ] Health endpoint responds: `curl localhost:4000/health`

#### Manual Verification:
- [ ] Two separate WebSocket clients can connect simultaneously
- [ ] `POST /sessions` returns a session ID
- [ ] Sending a user_message with that session_id starts the SDK stream
- [ ] SDK responses arrive on the correct WebSocket
- [ ] Disconnecting one client doesn't affect the other
- [ ] `DELETE /sessions/:id` stops a running session

**Implementation Note**: After completing this phase and all automated verification passes, pause here for manual confirmation that multiple concurrent connections and sessions work correctly before proceeding to the next phase.

---

## Phase 4: Update Client Library

### Overview
Update the client library to work with the new per-session REST creation flow and support multiple concurrent sessions over a single WebSocket.

### Changes Required:

#### 1. `packages/client/src/types.ts`

Update types:
- Add `session_id` to interrupt input message
- Update `ClientOptions` to remove config fields that are now per-session
- Add a `SessionConfig` type for per-session options

```typescript
export type WSInputMessage =
  | { type: 'user_message'; data: SDKUserMessage }
  | { type: 'interrupt'; session_id?: string }

// Per-session configuration
export type SessionConfig = QueryConfig

// Client connection options (no longer includes query config)
export interface ClientOptions {
  connectionUrl: string
  debug?: boolean
  anthropicApiKey?: string
}
```

#### 2. `packages/client/src/index.ts`

Redesign the client to separate connection management from session management:

```typescript
export class ClaudeAgentClient {
  private ws?: WebSocket
  private options: ClientOptions
  private messageHandlers: Map<string, ((message: WSOutputMessage) => void)[]> = new Map()
  private globalHandlers: ((message: WSOutputMessage) => void)[] = []
  private baseUrl: string

  constructor(options: ClientOptions) { /* ... */ }

  // Connect WebSocket (no config POST)
  async connect(): Promise<void> { /* establish WS only */ }

  // Create a session via REST, returns session ID
  async createSession(sessionId: string, config?: SessionConfig): Promise<string> {
    const url = `${this.baseUrl}/sessions`
    const body: Record<string, unknown> = { sessionId, config: config || {} }
    if (this.options.anthropicApiKey) {
      body.config = { ...body.config as object, anthropicApiKey: this.options.anthropicApiKey }
    }
    const response = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    })
    if (!response.ok) throw new Error(`Failed to create session: ${await response.text()}`)
    return sessionId
  }

  // Destroy a session
  async destroySession(sessionId: string): Promise<void> {
    await fetch(`${this.baseUrl}/sessions/${encodeURIComponent(sessionId)}`, {
      method: 'DELETE',
    })
  }

  // Send message to a specific session
  send(sessionId: string, content: string): void { /* ... */ }

  // Interrupt a specific session
  interrupt(sessionId: string): void { /* ... */ }

  // Listen for messages on a specific session
  onSessionMessage(sessionId: string, handler: (msg: WSOutputMessage) => void): () => void { /* ... */ }

  // Listen for all messages (global)
  onMessage(handler: (msg: WSOutputMessage) => void): () => void { /* ... */ }

  // Disconnect (tears down all sessions server-side)
  async disconnect(): Promise<void> { /* ... */ }

  // File and session history methods remain unchanged
}
```

The key API change: `start()` becomes `connect()` + `createSession()`. Messages are sent with explicit `sessionId`. Handlers can be registered per-session or globally.

### Success Criteria:

#### Automated Verification:
- [ ] TypeScript compiles cleanly: `bunx tsc --noEmit`
- [ ] Client package builds successfully
- [ ] Unit tests pass: `bun test`

#### Manual Verification:
- [ ] Client can connect, create two sessions, send messages to each, and receive responses
- [ ] Interrupting one session doesn't affect the other
- [ ] Destroying a session stops its responses

**Implementation Note**: After completing this phase and all automated verification passes, pause here for manual testing of the full client-server flow with concurrent sessions.

---

## Phase 5: Update Standalone Clients and Examples

### Overview
Update `remote-claude.ts`, `standalone-client.ts`, `example-client.ts`, and `claude-client.py` to use the new API.

### Changes Required:

#### 1. `remote-claude.ts`
- Update to use `connect()` + `createSession()` flow
- When user types `/new`, destroy current session and create a new one
- Session ID still generated via `crypto.randomUUID()`

#### 2. `standalone-client.ts`
- Same pattern: connect, create session, interact

#### 3. `packages/client/example-client.ts`
- Update example to demonstrate creating multiple sessions

#### 4. `claude-client.py`
- Update to call `POST /sessions` before sending WebSocket messages
- Add session_id to interrupt messages

### Success Criteria:

#### Automated Verification:
- [ ] TypeScript compiles cleanly: `bunx tsc --noEmit`
- [ ] Python client has no syntax errors: `python -m py_compile claude-client.py`

#### Manual Verification:
- [ ] `remote-claude.ts` can start a session, chat, and create new sessions with `/new`
- [ ] `standalone-client.ts` works end-to-end
- [ ] `claude-client.py` works end-to-end

---

## Testing Strategy

### Unit Tests:
- Session manager: create, destroy, push message, register/unregister connection
- Message handler: routing, session ownership validation, pending session claim
- Edge cases: destroy non-existent session, message to non-existent session, double-create

### Integration Tests:
- Two WebSocket connections simultaneously, each with a session
- One connection with two concurrent sessions
- Disconnect one connection, verify other unaffected
- Create session via REST, claim via WebSocket message
- Resume a previous session via new session creation with `resume` config

### Manual Testing Steps:
1. Start server, connect two terminals with `remote-claude.ts`
2. Chat in both simultaneously, verify independent responses
3. Disconnect one, verify the other continues working
4. Create a session, chat, disconnect, reconnect, resume with same session ID
5. In one client, create two sessions and verify messages route correctly

## Performance Considerations

- Each session spawns its own `query()` stream - resource usage scales linearly with active sessions
- The 10ms polling loop in `generateMessages()` is per-session - with many sessions this could be improved with event-based signaling (e.g., `Bun.Semaphore` or a simple resolve/notify pattern)
- No limit on concurrent sessions per connection - may want to add a configurable cap later
- SDK streams consume API quota - concurrent sessions multiply API usage

## Migration Notes

- **Breaking change**: `POST /config` and `GET /config` endpoints are removed
- **Breaking change**: Client `start()` method replaced with `connect()` + `createSession()`
- **No data migration needed**: Session history files on disk are unchanged
- Existing single-session clients must update to the new two-step flow

## References

- Server entry point: `packages/server/index.ts`
- SDK query function: `node_modules/@anthropic-ai/claude-agent-sdk/sdk.d.ts:551-554`
- SDK Options type: `node_modules/@anthropic-ai/claude-agent-sdk/sdk.d.ts:487-550`
- SDK Query interface: `node_modules/@anthropic-ai/claude-agent-sdk/sdk.d.ts:430-453`
