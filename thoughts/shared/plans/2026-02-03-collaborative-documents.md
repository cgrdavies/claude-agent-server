# Collaborative Document Editing Implementation Plan

## Overview

Replace the filesystem-based files API with a collaborative document system built on Yjs CRDTs and Tiptap. Humans and Claude agents edit markdown documents in real-time through a shared document model. Changes from any participant (human in browser, Claude via tools) propagate instantly to all others via Yjs sync protocol over WebSocket.

## Current State Analysis

The server has a filesystem-based files API (`packages/server/file-handler.ts`) that resolves all paths relative to a single `~/agent-workspace` directory. All operations (read, write, list, etc.) are direct filesystem calls with no collaboration, versioning, or real-time sync.

### Key Discoveries:
- File handler at `packages/server/file-handler.ts:7` hardcodes `workspaceDirectory = join(homedir(), WORKSPACE_DIR_NAME)`
- All 6 REST endpoints (`/files/write`, `/files/read`, `/files/remove`, `/files/list`, `/files/mkdir`, `/files/exists`) are defined inline in `packages/server/index.ts:166-259`
- Client wraps these as async methods in `packages/client/src/index.ts:112-171`
- The server uses `Bun.serve()` with native WebSocket support (`packages/server/index.ts:130`)
- No database exists - all state is filesystem or in-memory
- Bun has built-in SQLite via `bun:sqlite`

## Desired End State

- Documents are Yjs CRDT documents stored in SQLite, not files on disk
- A WebSocket endpoint (`/docs/:id`) serves the Yjs sync protocol for any document
- REST endpoints provide document CRUD: create, read (as markdown), list, delete
- Claude interacts with documents via custom tools (`doc_create`, `doc_read`, `doc_edit`, `doc_append`, `doc_list`, `doc_delete`) that apply changes to Yjs documents server-side
- A Tiptap-based web frontend connects to the same Yjs documents for real-time collaborative editing
- When Claude edits a document, changes appear live in the human's editor and vice versa
- The old `/files/*` endpoints are removed

### Verification:
- Claude can create a document via tool, write content, and edit it
- A browser client connecting to the same document sees Claude's changes in real-time
- A human editing in the browser has their changes visible to Claude when it reads the document
- Document state persists across server restarts (SQLite)
- Multiple documents can exist simultaneously in a workspace

## What We're NOT Doing

- Concurrent sessions / multi-connection support (separate plan exists for that)
- Authentication or per-user identity
- Document permissions or access control
- Rich text beyond what Tiptap's markdown support provides
- File uploads or binary asset management
- Git-style version history (Yjs has undo/redo but not named versions)
- CSV-specific table editing (documents are markdown; CSV support can be added later)

## Implementation Approach

Build bottom-up: persistence layer → document manager → Yjs sync server → REST API → Claude tools → frontend spec.

The Yjs document model is the single source of truth. Both the Claude tools and the browser editor operate on the same `Y.Doc` instances. The server maintains in-memory `Y.Doc` objects that sync to SQLite on every update and to WebSocket clients via the Yjs sync protocol.

### Dependencies to add:
```
bun add yjs y-protocols lib0 zod
```

- `yjs`, `y-protocols`, `lib0`: Yjs CRDT and sync protocol
- `zod`: Schema validation for tool input definitions (may already be available as transitive dep of the SDK, but add explicitly for safety)
- `bun:sqlite`: Built into Bun, no install needed
- `@modelcontextprotocol/sdk`: NOT needed - the Claude Agent SDK provides `tool()` and `createSdkMcpServer()` which handle in-process MCP internally
- `y-websocket`: Only needed by the frontend (Phase 4), not the server

---

## Phase 1: Document Storage and Manager

### Overview
Create the SQLite persistence layer and a document manager that owns in-memory Yjs documents, handles persistence, and exposes operations for the rest of the system.

### Changes Required:

#### 1. Database initialization
**File**: `packages/server/db.ts` (new)
**Purpose**: Initialize SQLite database and provide typed query helpers

```typescript
import { Database } from 'bun:sqlite'
import { homedir } from 'os'
import { join } from 'path'
import { WORKSPACE_DIR_NAME } from './const'

const dbPath = join(homedir(), WORKSPACE_DIR_NAME, 'documents.db')

const db = new Database(dbPath, { create: true })

// Enable WAL mode for better concurrent read/write performance
db.run('PRAGMA journal_mode = WAL')

db.run(`
  CREATE TABLE IF NOT EXISTS documents (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    state BLOB NOT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
  )
`)

export default db
```

#### 2. Document manager
**File**: `packages/server/document-manager.ts` (new)
**Purpose**: Manage in-memory Y.Doc instances, persistence to SQLite, and provide an API for document operations

```typescript
import * as Y from 'yjs'
import db from './db'

export type DocumentInfo = {
  id: string
  name: string
  createdAt: string
  updatedAt: string
}

// In-memory cache of active documents
const docs = new Map<string, Y.Doc>()

/**
 * Get or load a Y.Doc from cache/database.
 * Returns null if document doesn't exist.
 */
export function getDoc(id: string): Y.Doc | null {
  if (docs.has(id)) return docs.get(id)!

  const row = db.query('SELECT state FROM documents WHERE id = ?').get(id) as
    | { state: Buffer }
    | null
  if (!row) return null

  const doc = new Y.Doc()
  Y.applyUpdate(doc, new Uint8Array(row.state))

  // Listen for updates and persist
  doc.on('update', () => persistDoc(id, doc))

  docs.set(id, doc)
  return doc
}

/**
 * Create a new document with optional initial markdown content.
 */
export function createDoc(
  id: string,
  name: string,
  content?: string,
): Y.Doc {
  if (docs.has(id)) throw new Error(`Document ${id} already exists`)

  const existing = db.query('SELECT id FROM documents WHERE id = ?').get(id)
  if (existing) throw new Error(`Document ${id} already exists`)

  const doc = new Y.Doc()

  if (content) {
    const ytext = doc.getText('default')
    ytext.insert(0, content)
  }

  const state = Y.encodeStateAsUpdate(doc)
  db.query(
    'INSERT INTO documents (id, name, state) VALUES (?, ?, ?)',
  ).run(id, name, Buffer.from(state))

  doc.on('update', () => persistDoc(id, doc))
  docs.set(id, doc)

  return doc
}

/**
 * Delete a document.
 */
export function deleteDoc(id: string): void {
  const doc = docs.get(id)
  if (doc) {
    doc.destroy()
    docs.delete(id)
  }
  db.query('DELETE FROM documents WHERE id = ?').run(id)
}

/**
 * List all documents.
 */
export function listDocs(): DocumentInfo[] {
  const rows = db.query(
    'SELECT id, name, created_at as createdAt, updated_at as updatedAt FROM documents ORDER BY updated_at DESC',
  ).all() as DocumentInfo[]
  return rows
}

/**
 * Read document content as markdown string.
 */
export function readDocAsText(id: string): string | null {
  const doc = getDoc(id)
  if (!doc) return null
  return doc.getText('default').toString()
}

/**
 * Apply a find-and-replace edit to a document.
 * Returns true if the edit was applied, false if old_text was not found.
 */
export function editDoc(
  id: string,
  oldText: string,
  newText: string,
): boolean {
  const doc = getDoc(id)
  if (!doc) throw new Error(`Document ${id} not found`)

  const ytext = doc.getText('default')
  const content = ytext.toString()
  const index = content.indexOf(oldText)
  if (index === -1) return false

  doc.transact(() => {
    ytext.delete(index, oldText.length)
    ytext.insert(index, newText)
  })

  return true
}

/**
 * Append text to the end of a document.
 */
export function appendDoc(id: string, content: string): void {
  const doc = getDoc(id)
  if (!doc) throw new Error(`Document ${id} not found`)

  const ytext = doc.getText('default')
  ytext.insert(ytext.length, content)
}

/**
 * Persist a document's current state to SQLite.
 */
function persistDoc(id: string, doc: Y.Doc): void {
  const state = Y.encodeStateAsUpdate(doc)
  db.query(
    "UPDATE documents SET state = ?, updated_at = datetime('now') WHERE id = ?",
  ).run(Buffer.from(state), id)
}

/**
 * Get a document's info without loading the full Y.Doc.
 */
export function getDocInfo(id: string): DocumentInfo | null {
  return db.query(
    'SELECT id, name, created_at as createdAt, updated_at as updatedAt FROM documents WHERE id = ?',
  ).get(id) as DocumentInfo | null
}
```

### Success Criteria:

#### Automated Verification:
- [ ] TypeScript compiles cleanly: `bunx tsc --noEmit`
- [ ] Unit tests for document CRUD operations: `bun test packages/server/document-manager.test.ts`
  - Create a document with content, verify `readDocAsText` returns it
  - `editDoc` find-and-replace works correctly
  - `appendDoc` adds to end
  - `deleteDoc` removes from both memory and SQLite
  - `listDocs` returns all documents
  - Document survives cache eviction (remove from `docs` Map, reload from SQLite)
- [ ] Database file created at expected path

#### Manual Verification:
- [ ] Confirm SQLite WAL mode is active and DB is not corrupted after rapid writes

**Implementation Note**: After completing this phase and all automated verification passes, pause here for confirmation before proceeding.

---

## Phase 2: Yjs WebSocket Sync Server

### Overview
Add a Yjs sync protocol endpoint to the existing Bun server so browser clients can connect and receive real-time document updates.

### Changes Required:

#### 1. Yjs sync handler
**File**: `packages/server/yjs-sync.ts` (new)
**Purpose**: Handle the Yjs binary sync protocol over Bun WebSockets

The Yjs sync protocol uses binary messages with two top-level types:
- `0` = sync message (sub-types: SyncStep1, SyncStep2, Update)
- `1` = awareness message (cursor positions, presence)

```typescript
import * as Y from 'yjs'
import * as syncProtocol from 'y-protocols/sync'
import * as awarenessProtocol from 'y-protocols/awareness'
import * as encoding from 'lib0/encoding'
import * as decoding from 'lib0/decoding'
import { type ServerWebSocket } from 'bun'
import * as docManager from './document-manager'

const messageSync = 0
const messageAwareness = 1

// Awareness instances per document
const awarenessInstances = new Map<string, awarenessProtocol.Awareness>()

// Track which WebSocket connections are subscribed to which document
const docConnections = new Map<string, Set<ServerWebSocket>>()

export type YjsWSData = {
  type: 'yjs'
  docId: string
}

function getAwareness(docId: string, doc: Y.Doc): awarenessProtocol.Awareness {
  if (!awarenessInstances.has(docId)) {
    awarenessInstances.set(docId, new awarenessProtocol.Awareness(doc))
  }
  return awarenessInstances.get(docId)!
}

function broadcast(docId: string, message: Uint8Array, exclude?: ServerWebSocket): void {
  const conns = docConnections.get(docId)
  if (!conns) return
  for (const ws of conns) {
    if (ws !== exclude) {
      try {
        ws.send(message)
      } catch {
        // Connection may have closed
      }
    }
  }
}

/**
 * Called when a WebSocket connection opens for Yjs sync.
 */
export function handleYjsOpen(ws: ServerWebSocket<YjsWSData>): void {
  const { docId } = ws.data
  const doc = docManager.getDoc(docId)
  if (!doc) {
    ws.close(4004, `Document ${docId} not found`)
    return
  }

  // Track connection
  if (!docConnections.has(docId)) {
    docConnections.set(docId, new Set())
  }
  docConnections.get(docId)!.add(ws)

  // Set up update listener to broadcast to this client
  const updateHandler = (update: Uint8Array, origin: unknown) => {
    if (origin === ws) return
    const encoder = encoding.createEncoder()
    encoding.writeVarUint(encoder, messageSync)
    syncProtocol.writeUpdate(encoder, update)
    try {
      ws.send(encoding.toUint8Array(encoder))
    } catch {
      // Connection may have closed
    }
  }
  // Store handler reference for cleanup - attach to ws.data
  ;(ws.data as any)._updateHandler = updateHandler
  doc.on('update', updateHandler)

  // Send SyncStep1 to initiate sync
  const encoder = encoding.createEncoder()
  encoding.writeVarUint(encoder, messageSync)
  syncProtocol.writeSyncStep1(encoder, doc)
  ws.send(encoding.toUint8Array(encoder))

  // Send current awareness state
  const awareness = getAwareness(docId, doc)
  const awarenessStates = awareness.getStates()
  if (awarenessStates.size > 0) {
    const encoder = encoding.createEncoder()
    encoding.writeVarUint(encoder, messageAwareness)
    encoding.writeVarUint8Array(
      encoder,
      awarenessProtocol.encodeAwarenessUpdate(
        awareness,
        Array.from(awarenessStates.keys()),
      ),
    )
    ws.send(encoding.toUint8Array(encoder))
  }
}

/**
 * Called when a Yjs sync WebSocket receives a message.
 */
export function handleYjsMessage(
  ws: ServerWebSocket<YjsWSData>,
  message: ArrayBuffer | Buffer,
): void {
  const { docId } = ws.data
  const doc = docManager.getDoc(docId)
  if (!doc) return

  const buf = new Uint8Array(message instanceof ArrayBuffer ? message : message.buffer)
  const decoder = decoding.createDecoder(buf)
  const encoder = encoding.createEncoder()
  const messageType = decoding.readVarUint(decoder)

  switch (messageType) {
    case messageSync: {
      encoding.writeVarUint(encoder, messageSync)
      syncProtocol.readSyncMessage(decoder, encoder, doc, ws)
      if (encoding.length(encoder) > 1) {
        ws.send(encoding.toUint8Array(encoder))
      }
      break
    }
    case messageAwareness: {
      const awareness = getAwareness(docId, doc)
      const update = decoding.readVarUint8Array(decoder)
      awarenessProtocol.applyAwarenessUpdate(awareness, update, ws)
      // Broadcast awareness to other clients
      const broadcastEncoder = encoding.createEncoder()
      encoding.writeVarUint(broadcastEncoder, messageAwareness)
      encoding.writeVarUint8Array(broadcastEncoder, update)
      broadcast(docId, encoding.toUint8Array(broadcastEncoder), ws)
      break
    }
  }
}

/**
 * Called when a Yjs sync WebSocket closes.
 */
export function handleYjsClose(ws: ServerWebSocket<YjsWSData>): void {
  const { docId } = ws.data
  const doc = docManager.getDoc(docId)

  // Remove update listener
  if (doc) {
    const handler = (ws.data as any)._updateHandler
    if (handler) doc.off('update', handler)
  }

  // Remove from connection tracking
  const conns = docConnections.get(docId)
  if (conns) {
    conns.delete(ws)
    if (conns.size === 0) {
      docConnections.delete(docId)
      // Optionally clean up awareness
      awarenessInstances.delete(docId)
    }
  }
}
```

#### 2. Update server to add Yjs sync endpoint and document REST API
**File**: `packages/server/index.ts`
**Changes**:
- Add Yjs WebSocket upgrade for `/docs/:id` path
- Add document REST endpoints replacing the `/files/*` endpoints
- Update WebSocket handler to dispatch between Yjs sync and SDK message connections

The WebSocket handler needs to distinguish between two types of connections:
1. **SDK connections** on `/ws` - the existing Claude Agent SDK relay
2. **Yjs sync connections** on `/docs/:id` - document sync for browser editors

Use `ws.data` to store connection type and route accordingly:

```typescript
import * as docManager from './document-manager'
import {
  handleYjsOpen,
  handleYjsMessage,
  handleYjsClose,
  type YjsWSData,
} from './yjs-sync'

// WebSocket data type union
type WSData =
  | { type: 'sdk' }
  | YjsWSData

// In fetch():

// Document REST endpoints

// POST /docs - Create a new document
if (url.pathname === '/docs' && req.method === 'POST') {
  try {
    const body = (await req.json()) as { id?: string; name: string; content?: string }
    if (!body.name) {
      return Response.json({ error: 'name is required' }, { status: 400 })
    }
    const id = body.id || crypto.randomUUID()
    docManager.createDoc(id, body.name, body.content)
    return Response.json({ id, name: body.name })
  } catch (error) {
    return Response.json({ error: String(error) }, { status: 400 })
  }
}

// GET /docs - List all documents
if (url.pathname === '/docs' && req.method === 'GET') {
  return Response.json({ documents: docManager.listDocs() })
}

// GET /docs/:id - Read document as markdown
if (url.pathname.match(/^\/docs\/[^/]+$/) && req.method === 'GET') {
  const id = url.pathname.slice('/docs/'.length)
  // If WebSocket upgrade, handle Yjs sync
  if (req.headers.get('upgrade') === 'websocket') {
    if (!docManager.getDoc(id)) {
      return Response.json({ error: 'Document not found' }, { status: 404 })
    }
    const data: YjsWSData = { type: 'yjs', docId: id }
    if (server.upgrade(req, { data })) return
    return new Response('WebSocket upgrade failed', { status: 500 })
  }
  // Otherwise return markdown content
  const content = docManager.readDocAsText(id)
  if (content === null) {
    return Response.json({ error: 'Document not found' }, { status: 404 })
  }
  const info = docManager.getDocInfo(id)
  return Response.json({ id, name: info?.name, content })
}

// DELETE /docs/:id - Delete a document
if (url.pathname.match(/^\/docs\/[^/]+$/) && req.method === 'DELETE') {
  const id = url.pathname.slice('/docs/'.length)
  docManager.deleteDoc(id)
  return Response.json({ success: true })
}

// Existing /ws endpoint
if (url.pathname === '/ws') {
  if (server.upgrade(req, { data: { type: 'sdk' } })) return
}

// WebSocket handlers - dispatch by type:
websocket: {
  open(ws: ServerWebSocket<WSData>) {
    if (ws.data.type === 'yjs') {
      handleYjsOpen(ws as ServerWebSocket<YjsWSData>)
      return
    }
    // Existing SDK WebSocket open logic...
  },
  message(ws: ServerWebSocket<WSData>, message) {
    if (ws.data.type === 'yjs') {
      handleYjsMessage(ws as ServerWebSocket<YjsWSData>, message as ArrayBuffer)
      return
    }
    // Existing SDK message handling...
  },
  close(ws: ServerWebSocket<WSData>) {
    if (ws.data.type === 'yjs') {
      handleYjsClose(ws as ServerWebSocket<YjsWSData>)
      return
    }
    // Existing SDK close logic...
  },
}
```

Remove the old `/files/*` endpoints and `file-handler.ts` import. The old file handler module can be deleted or kept for backwards compatibility during migration.

### Success Criteria:

#### Automated Verification:
- [ ] `bun add yjs y-protocols lib0` installs successfully
- [ ] TypeScript compiles cleanly: `bunx tsc --noEmit`
- [ ] Server starts without errors: `bun run packages/server/index.ts`
- [ ] Health endpoint responds: `curl localhost:4000/health`
- [ ] Document CRUD via REST:
  - `curl -X POST localhost:4000/docs -H 'Content-Type: application/json' -d '{"name":"test","content":"# Hello"}'` returns `{id, name}`
  - `curl localhost:4000/docs` returns document list
  - `curl localhost:4000/docs/<id>` returns `{id, name, content: "# Hello"}`
  - `curl -X DELETE localhost:4000/docs/<id>` returns `{success: true}`
- [ ] Integration test for Yjs sync: `bun test packages/server/yjs-sync.test.ts`
  - Connect a y-websocket `WebsocketProvider` to `ws://localhost:4000/docs/<id>`
  - Verify initial document content syncs to client
  - Verify client edits propagate to server (readable via REST)
  - Verify server-side edits (via `docManager.editDoc`) propagate to client

#### Manual Verification:
- [ ] Yjs WebSocket connection establishes successfully (check with a simple HTML page using y-websocket client)
- [ ] Two browser tabs connecting to the same document see each other's changes

**Implementation Note**: After completing this phase and all automated verification passes, pause here for manual confirmation before proceeding.

---

## Phase 3: Custom Claude Tools

### Overview
Define document operation tools using the Claude Agent SDK's `tool()` and `createSdkMcpServer()` functions. These run in-process (same process as the server), so tool handlers have direct access to the in-memory `Y.Doc` instances. When Claude calls `doc_edit`, the handler modifies the Yjs document, which immediately triggers update broadcasts to all connected WebSocket editors and persists to SQLite.

### Changes Required:

#### 1. Tool definitions
**File**: `packages/server/document-tools.ts` (new)
**Purpose**: Define document tools using the SDK's `tool()` helper and `createSdkMcpServer()`

The SDK provides two functions (`sdk.d.ts:460, 472`):
- `tool(name, description, inputSchema, handler)` - creates a `SdkMcpToolDefinition` object
- `createSdkMcpServer({ name, tools })` - wraps tools into an in-process MCP server (`McpSdkServerConfigWithInstance`)

The returned server config has `type: 'sdk'` and includes the MCP server `instance`. It's passed directly into `Options.mcpServers` alongside any external MCP servers. No subprocess, no stdio - the handlers execute in the server's event loop with full access to shared state.

Tool handler signature: `(args: z.infer<Schema>, extra: unknown) => Promise<CallToolResult>`

`CallToolResult` shape: `{ content: Array<{ type: 'text', text: string }>, isError?: boolean }`

```typescript
import { tool, createSdkMcpServer } from '@anthropic-ai/claude-agent-sdk'
import { z } from 'zod'
import * as docManager from './document-manager'

const docCreate = tool(
  'doc_create',
  'Create a new markdown document in the workspace',
  {
    name: z.string().describe('Document name/title'),
    content: z.string().optional().describe('Initial markdown content'),
  },
  async ({ name, content }) => {
    const id = crypto.randomUUID()
    docManager.createDoc(id, name, content)
    return {
      content: [{ type: 'text' as const, text: JSON.stringify({ id, name }) }],
    }
  },
)

const docRead = tool(
  'doc_read',
  'Read a document as markdown. Returns the full document content.',
  {
    id: z.string().describe('Document ID'),
  },
  async ({ id }) => {
    const content = docManager.readDocAsText(id)
    if (content === null) {
      return {
        content: [{ type: 'text' as const, text: JSON.stringify({ error: 'Document not found' }) }],
        isError: true,
      }
    }
    const info = docManager.getDocInfo(id)
    return {
      content: [{ type: 'text' as const, text: JSON.stringify({ id, name: info?.name, content }) }],
    }
  },
)

const docEdit = tool(
  'doc_edit',
  'Find and replace text in a document. The old_text must match exactly. The edit is applied as a Yjs transaction, so connected editors see the change atomically.',
  {
    id: z.string().describe('Document ID'),
    old_text: z.string().describe('Text to find (must match exactly)'),
    new_text: z.string().describe('Text to replace it with'),
  },
  async ({ id, old_text, new_text }) => {
    try {
      const success = docManager.editDoc(id, old_text, new_text)
      if (!success) {
        return {
          content: [{
            type: 'text' as const,
            text: JSON.stringify({ success: false, error: 'old_text not found in document' }),
          }],
        }
      }
      return {
        content: [{ type: 'text' as const, text: JSON.stringify({ success: true }) }],
      }
    } catch (error) {
      return {
        content: [{ type: 'text' as const, text: JSON.stringify({ error: String(error) }) }],
        isError: true,
      }
    }
  },
)

const docAppend = tool(
  'doc_append',
  'Append markdown content to the end of a document. Useful for building a document incrementally.',
  {
    id: z.string().describe('Document ID'),
    content: z.string().describe('Markdown content to append'),
  },
  async ({ id, content }) => {
    try {
      docManager.appendDoc(id, content)
      return {
        content: [{ type: 'text' as const, text: JSON.stringify({ success: true }) }],
      }
    } catch (error) {
      return {
        content: [{ type: 'text' as const, text: JSON.stringify({ error: String(error) }) }],
        isError: true,
      }
    }
  },
)

const docList = tool(
  'doc_list',
  'List all documents in the workspace with their IDs, names, and timestamps.',
  {},
  async () => {
    const documents = docManager.listDocs()
    return {
      content: [{ type: 'text' as const, text: JSON.stringify({ documents }) }],
    }
  },
)

const docDelete = tool(
  'doc_delete',
  'Delete a document permanently. This cannot be undone.',
  {
    id: z.string().describe('Document ID'),
  },
  async ({ id }) => {
    docManager.deleteDoc(id)
    return {
      content: [{ type: 'text' as const, text: JSON.stringify({ success: true }) }],
    }
  },
)

/**
 * Create the in-process MCP server for document tools.
 * Pass the return value into Options.mcpServers when calling query().
 */
export const documentToolsServer = createSdkMcpServer({
  name: 'document-tools',
  tools: [docCreate, docRead, docEdit, docAppend, docList, docDelete],
})
```

#### 2. Register tools with the SDK query
**File**: `packages/server/index.ts`
**Changes**: Import the document tools server and add it to `Options.mcpServers` in `processMessages()`

```typescript
import { documentToolsServer } from './document-tools'

// In processMessages(), when building the options:
const options: Options = {
  permissionMode: 'bypassPermissions',
  allowDangerouslySkipPermissions: true,
  settingSources: ['local'],
  cwd: workspaceDirectory,
  stderr: data => { /* ... existing ... */ },
  ...queryConfig,
  mcpServers: {
    ...queryConfig.mcpServers,
    documents: documentToolsServer,
  },
  env: { /* ... existing ... */ },
}
```

The SDK handles tool discovery, calling, and result routing automatically. When Claude decides to use `doc_edit`, the SDK invokes the handler in-process and feeds the result back into the conversation. No additional message handling needed.

#### 3. Update client library
**File**: `packages/client/src/index.ts`
**Changes**: Replace file operation methods with document operation methods

```typescript
// Remove: writeFile, readFile, removeFile, listFiles, mkdir, exists

// Add:
async createDocument(name: string, content?: string): Promise<{ id: string; name: string }> {
  const url = `${this.baseUrl}/docs`
  const response = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name, content }),
  })
  if (!response.ok) throw new Error(`Failed to create document: ${await response.text()}`)
  return response.json() as Promise<{ id: string; name: string }>
}

async readDocument(id: string): Promise<{ id: string; name: string; content: string }> {
  const url = `${this.baseUrl}/docs/${encodeURIComponent(id)}`
  const response = await fetch(url)
  if (!response.ok) throw new Error(`Failed to read document: ${await response.text()}`)
  return response.json() as Promise<{ id: string; name: string; content: string }>
}

async listDocuments(): Promise<DocumentInfo[]> {
  const url = `${this.baseUrl}/docs`
  const response = await fetch(url)
  if (!response.ok) throw new Error(`Failed to list documents: ${await response.text()}`)
  const data = await response.json() as { documents: DocumentInfo[] }
  return data.documents
}

async deleteDocument(id: string): Promise<void> {
  const url = `${this.baseUrl}/docs/${encodeURIComponent(id)}`
  const response = await fetch(url, { method: 'DELETE' })
  if (!response.ok) throw new Error(`Failed to delete document: ${await response.text()}`)
}
```

#### 4. Update client types
**File**: `packages/client/src/types.ts`
**Changes**: Remove `EntryInfo`, add `DocumentInfo`

```typescript
export type DocumentInfo = {
  id: string
  name: string
  createdAt: string
  updatedAt: string
}
```

### Success Criteria:

#### Automated Verification:
- [ ] `zod` is already a transitive dependency of the SDK; verify it's available or add explicitly: `bun add zod`
- [ ] TypeScript compiles cleanly: `bunx tsc --noEmit`
- [ ] Server starts with document tools available: `bun run packages/server/index.ts`
- [ ] Unit test for tool definitions: `bun test packages/server/document-tools.test.ts`
  - Call each tool handler directly and verify return values
  - Verify `doc_edit` returns `success: false` when `old_text` not found
  - Verify `doc_read` returns `isError: true` for non-existent document
- [ ] Integration test: start a Claude session with document tools, send a prompt asking Claude to create and edit a document, verify the document exists and has correct content via REST API: `bun test packages/server/integration.test.ts`
- [ ] Client library compiles and document methods work: `bun test packages/client`

#### Manual Verification:
- [ ] Start a Claude session, ask it to create a document and write content
- [ ] While Claude writes, connect a Yjs client to the same document and observe real-time updates
- [ ] Ask Claude to read a document that a human has edited, verify it sees the latest content

**Implementation Note**: After completing this phase, pause for manual testing of the full Claude-to-document flow before proceeding to the frontend.

---

## Phase 4: Tiptap Frontend (Specification)

### Overview
This phase describes the web frontend for collaborative document editing. It is written as a specification for a separate implementation session.

### What to Build

A single-page web application served by the existing Bun server that provides a Notion-like collaborative markdown editing experience. The app connects to the server's document REST API and Yjs WebSocket sync.

### Technology Stack

- **Editor**: Tiptap 3.x with ProseMirror-based rich text editing
- **Collaboration**: `@tiptap/extension-collaboration` + `@tiptap/extension-collaboration-caret`
- **Yjs Client**: `y-websocket` `WebsocketProvider` connecting to `ws://<server>/docs/:id`
- **Markdown**: `@tiptap/markdown` for markdown import/export
- **Framework**: React (Bun's HTML imports support React out of the box)
- **Styling**: Tailwind CSS or plain CSS - keep it minimal and clean

### Required Packages
```
bun add @tiptap/react @tiptap/starter-kit @tiptap/extension-collaboration @tiptap/extension-collaboration-caret @tiptap/markdown y-websocket react react-dom
```

### Application Structure

```
packages/server/
  frontend/
    index.html          # Entry point, loaded by Bun.serve() routes
    app.tsx             # React app root
    components/
      document-list.tsx  # Sidebar listing all documents
      editor.tsx         # Tiptap editor component
      toolbar.tsx        # Formatting toolbar (optional)
    styles/
      editor.css         # Editor styles (Tiptap content styling)
```

### Pages / Views

**1. Document List (Sidebar)**
- Fetches documents from `GET /docs`
- Shows document name and last updated time
- Click to open a document in the editor
- "New Document" button that calls `POST /docs` and opens the new document
- Delete button per document (with confirmation)

**2. Editor**
- Full-screen Tiptap editor for the selected document
- Connects a `WebsocketProvider` to `ws://<host>/docs/:id` for Yjs sync
- Renders markdown as rich text (headings, lists, bold, italic, links, code blocks, tables)
- Shows collaboration cursors with names/colors for other connected users
- Claude's cursor/edits should be visually distinguishable (e.g., labeled "Claude", distinct color)
- Content auto-saves via Yjs (no explicit save button needed)

### Editor Configuration

```tsx
import { useEditor, EditorContent } from '@tiptap/react'
import StarterKit from '@tiptap/starter-kit'
import Collaboration from '@tiptap/extension-collaboration'
import CollaborationCaret from '@tiptap/extension-collaboration-caret'
import { Markdown } from '@tiptap/markdown'
import * as Y from 'yjs'
import { WebsocketProvider } from 'y-websocket'

function Editor({ documentId }: { documentId: string }) {
  const ydoc = useMemo(() => new Y.Doc(), [documentId])

  const provider = useMemo(
    () =>
      new WebsocketProvider(
        `ws://${window.location.host}/docs/${documentId}`,
        documentId,
        ydoc,
      ),
    [documentId, ydoc],
  )

  const editor = useEditor({
    extensions: [
      StarterKit.configure({ history: false }),
      Markdown,
      Collaboration.configure({ document: ydoc }),
      CollaborationCaret.configure({
        provider,
        user: { name: 'Human', color: '#3b82f6' },
      }),
    ],
  })

  return <EditorContent editor={editor} />
}
```

### Server Integration

Add a route in `packages/server/index.ts` to serve the frontend:

```typescript
import index from './frontend/index.html'

// In fetch():
if (url.pathname === '/' || url.pathname === '/app') {
  return new Response(index)
}
```

Bun's HTML imports automatically bundle the React app, CSS, and all dependencies.

### Awareness / Presence

When Claude is editing a document via tools, the server should inject awareness state so the frontend shows Claude's presence. In `document-manager.ts`, when a tool modifies a document, briefly set awareness on that document:

```typescript
// When Claude edits via tools, broadcast awareness
const awareness = getAwareness(docId, doc)
// Set a synthetic client state for Claude
awareness.setLocalStateField('user', {
  name: 'Claude',
  color: '#f97316', // orange
})
```

This requires the awareness instance to be accessible from the document tools. The exact mechanism depends on Phase 3's integration approach.

### Design Requirements

- Clean, minimal interface - not cluttered
- The editor should feel like writing in Notion or a good markdown editor
- Document content area should be centered with comfortable max-width (~720px)
- Collaboration cursors should show the user's name as a small label
- Claude's edits should be visually trackable (cursor label + color)
- Responsive - should work on tablet-sized screens at minimum

### What NOT to Build
- User authentication or login screen
- File upload / image embedding
- Version history UI
- Export to PDF/HTML
- Mobile-optimized layout
- Search across documents
- Folders or document organization beyond a flat list

### Success Criteria:
- [ ] Frontend loads at `http://localhost:4000/`
- [ ] Can create a new document from the UI
- [ ] Can type in the editor and see content persisted (refresh page, content remains)
- [ ] Open same document in two browser tabs - edits sync in real-time
- [ ] Start a Claude session, ask it to edit a document - see edits appear in the browser
- [ ] Edit a document in the browser, ask Claude to read it - Claude sees the latest content
- [ ] Collaboration cursors visible when multiple tabs are open
- [ ] Claude's presence/cursor distinguishable from human users

---

## Testing Strategy

### Unit Tests:
- `document-manager.test.ts`: CRUD operations, edit find-and-replace, persistence across reload
- `yjs-sync.test.ts`: Sync protocol message handling, multi-client sync

### Integration Tests:
- Create document via REST, connect Yjs client, verify content syncs
- Modify document via `docManager.editDoc()`, verify connected Yjs client receives update
- Yjs client modifies document, verify `readDocAsText()` returns updated content
- Claude session uses `doc_create` + `doc_edit`, verify via REST and Yjs client
- Two Yjs clients connect to same document, both see each other's changes

### Manual Testing Steps:
1. Start server, open browser to `http://localhost:4000`
2. Create a document, type some markdown, verify it renders as rich text
3. Open same document in second tab, verify sync works
4. Start a Claude session (via existing client), ask Claude to create a document and write a draft
5. Open that document in the browser while Claude is writing - verify live updates
6. Edit the document in the browser, then ask Claude to read it and make changes
7. Verify Claude sees the human's edits and its changes appear in the browser

## Performance Considerations

- Yjs documents are kept in memory for active documents. For a small number of documents (< 100), this is fine. For larger deployments, add eviction of inactive documents from memory (they reload from SQLite on next access).
- The `doc.on('update', ...)` handler persists to SQLite on every Yjs transaction. For high-frequency edits (typing), this could be a lot of writes. Consider debouncing persistence (e.g., persist at most once per second) while keeping Yjs in-memory state authoritative.
- SQLite WAL mode handles concurrent reads well but writes are serialized. This is fine for a single-server deployment.
- Yjs document size grows over time as it tracks edit history. Periodically compacting via `Y.encodeStateAsUpdate()` and replacing the stored state keeps size manageable.

## Migration Notes

- The `/files/*` REST endpoints are removed and replaced with `/docs/*`
- The client library's file methods (`writeFile`, `readFile`, etc.) are removed and replaced with document methods
- No data migration needed - the old filesystem workspace is independent. Documents start fresh in SQLite.
- `file-handler.ts` can be deleted after migration
- The `~/agent-workspace` directory is no longer used by the document system (but may still be used as the Claude SDK `cwd` for any shell operations)
- Docker `workspace-data` volume is still useful for the SDK's working directory. Add a new volume or use a path within `claude-data` for the SQLite database.

## References

- Existing server: `packages/server/index.ts`
- Existing file handler (to be replaced): `packages/server/file-handler.ts`
- Concurrent sessions plan (to layer on later): `thoughts/shared/plans/2026-02-03-concurrent-sessions.md`
- Yjs docs: https://docs.yjs.dev/
- Tiptap collaboration docs: https://tiptap.dev/docs/editor/extensions/functionality/collaboration
- y-protocols sync: https://github.com/yjs/y-protocols
- Bun SQLite: https://bun.sh/docs/api/sqlite
- Bun HTML imports: https://bun.sh/docs/bundler/html
