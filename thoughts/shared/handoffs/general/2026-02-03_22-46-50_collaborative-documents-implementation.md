---
date: 2026-02-03T22:46:50-0500
researcher: claude
git_commit: e2d22ea8e54b63d938021fab913e81b277126a20
branch: main
repository: claude-agent-server
topic: "Collaborative Document Editing Implementation"
tags: [implementation, yjs, crdt, websocket, documents, tiptap]
status: complete
last_updated: 2026-02-03
last_updated_by: claude
type: implementation_strategy
---

# Handoff: Collaborative Documents Implementation

## Task(s)

Implementing the collaborative document editing system per the plan at `thoughts/shared/plans/2026-02-03-collaborative-documents.md`. The plan has 4 phases:

1. **Phase 1: Document Storage and Manager** - COMPLETED
   - Created SQLite persistence layer (`db.ts`) and document manager (`document-manager.ts`) with Yjs CRDT support
   - All 17 unit tests pass

2. **Phase 2: Yjs WebSocket Sync Server** - COMPLETED
   - Created Yjs sync protocol handler (`yjs-sync.ts`)
   - Updated `index.ts` to replace `/files/*` endpoints with `/docs/*` REST endpoints and add Yjs WebSocket dispatch
   - All 6 integration tests pass, manual REST API verification passed
   - Note: old `/files/*` endpoints removed from `index.ts`, but `file-handler.ts` not yet deleted

3. **Phase 3: Custom Claude Tools** - NOT STARTED (was about to begin)
   - Need to create `document-tools.ts` with `tool()` and `createSdkMcpServer()` from the SDK
   - Need to register tools in `processMessages()` options
   - Need to update client library to replace file methods with document methods

4. **Phase 4: Tiptap Frontend** - NOT STARTED (spec only in plan)

## Critical References
- Implementation plan: `thoughts/shared/plans/2026-02-03-collaborative-documents.md` (has checkboxes tracking progress)
- SDK type definitions for `tool()` and `createSdkMcpServer()`: `node_modules/@anthropic-ai/claude-agent-sdk/sdk.d.ts:454-472`

## Recent changes

All changes are uncommitted on `main`. Files created/modified:

- `packages/server/db.ts` - NEW: SQLite database initialization with WAL mode, documents table
- `packages/server/document-manager.ts` - NEW: Yjs document manager with CRUD, edit, append, persistence, cache management
- `packages/server/document-manager.test.ts` - NEW: 17 unit tests for document manager
- `packages/server/yjs-sync.ts` - NEW: Yjs binary sync protocol handler over Bun WebSockets, awareness support, connection tracking
- `packages/server/yjs-sync.test.ts` - NEW: 6 integration tests (REST CRUD, Yjs sync, bidirectional edits, multi-client)
- `packages/server/index.ts` - MODIFIED: Replaced `/files/*` endpoints with `/docs/*` REST + Yjs WS upgrade, added `WSData` type union for dispatching between SDK and Yjs WebSocket connections
- `packages/server/message-handler.ts:12` - MODIFIED: Changed `ServerWebSocket` to `ServerWebSocket<unknown>` for type compatibility
- `packages/client/example-client.ts` - MODIFIED: Fixed pre-existing TS errors (removed `FilesystemEventType`, added `connectionUrl`, removed `watchDir`)
- `remote-claude.ts:76` - MODIFIED: Added optional chaining for null check on `client`
- `packages/server/package.json` - MODIFIED: Added `yjs`, `y-protocols`, `lib0`, `zod` dependencies

## Learnings

- **Bun WebSocket typing**: `Bun.serve()` needs a generic type parameter for WebSocket data (`Bun.serve<WSData>({...})`). The `ServerWebSocket` type is `ServerWebSocket<T>` where T defaults to `undefined`, causing type mismatches if you mix typed and untyped connections. Had to update `activeConnection` and `handleMessage` to use `WSData`/`unknown` generics.
- **Yjs sync protocol**: The client must send its own `SyncStep1` to the server during connection to trigger the server sending back `SyncStep2` with the full document state. Just receiving the server's `SyncStep1` isn't enough for the client to get the document content.
- **Yjs client updates**: When sending updates from a Yjs client to the server, use `doc.transact(() => {...}, 'local')` with an origin, then in the `doc.on('update')` handler check for that origin to avoid echo loops. Don't use `Y.encodeStateAsUpdate()` (full state) as the update message - use the incremental update from the handler.
- **Map iterator TS issue**: `for...of` on `Map.values()` requires `downlevelIteration` in TS config. Use `.forEach()` instead to avoid the error.
- **Pre-existing TS errors**: `file-handler.ts` has a TS error but will be deleted. All other pre-existing errors in `example-client.ts` and `remote-claude.ts` have been fixed.

## Artifacts

- `thoughts/shared/plans/2026-02-03-collaborative-documents.md` - Implementation plan with progress checkboxes
- `packages/server/db.ts` - SQLite initialization
- `packages/server/document-manager.ts` - Document manager (core business logic)
- `packages/server/document-manager.test.ts` - Document manager tests
- `packages/server/yjs-sync.ts` - Yjs WebSocket sync handler
- `packages/server/yjs-sync.test.ts` - Yjs sync integration tests
- `packages/server/index.ts` - Updated server with docs endpoints

## Action Items & Next Steps

1. **Phase 3: Create document tools** (`packages/server/document-tools.ts`)
   - Define 6 tools: `doc_create`, `doc_read`, `doc_edit`, `doc_append`, `doc_list`, `doc_delete`
   - Use `tool()` and `createSdkMcpServer()` from `@anthropic-ai/claude-agent-sdk`
   - See plan Phase 3 for exact tool signatures and handler implementations
   - The plan has detailed code for this at `thoughts/shared/plans/2026-02-03-collaborative-documents.md:618-748`

2. **Phase 3: Register tools with SDK query** (`packages/server/index.ts`)
   - Import `documentToolsServer` and add to `Options.mcpServers` in `processMessages()`
   - See plan at line 755-771

3. **Phase 3: Update client library** (`packages/client/src/index.ts`)
   - Remove file operation methods (`writeFile`, `readFile`, `removeFile`, `listFiles`, `mkdir`, `exists`)
   - Add document methods (`createDocument`, `readDocument`, `listDocuments`, `deleteDocument`)
   - Update types in `packages/client/src/types.ts` (remove `EntryInfo`, add `DocumentInfo`)

4. **Phase 3: Write tests** for tool definitions and integration

5. **Delete `packages/server/file-handler.ts`** - no longer imported by `index.ts`

6. **Phase 4: Tiptap Frontend** - specification is in the plan, to be implemented in a separate session

## Other Notes

- The `QueryConfig` type in `packages/server/message-types.ts:44` has `mcpServers` typed as `Record<string, McpRemoteServerConfig>`. The document tools server is `McpSdkServerConfigWithInstance` (type `'sdk'`), not a remote server. You may need to widen this type or handle it differently when adding the SDK MCP server to options - the plan notes this at line 765 where it spreads `queryConfig.mcpServers` alongside the document tools server.
- The database is stored at `~/agent-workspace/documents.db`. Tests share this database, so test documents may be visible when running the server manually.
- `zod` was already a transitive dep of the SDK but was added explicitly to the server package for safety.
