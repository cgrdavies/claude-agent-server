# Frontend Spec: Collaborative Document Editing

## Context

The backend has been migrated from a filesystem-based files API to a collaborative document system built on Yjs CRDTs. Documents are Yjs documents stored in SQLite, editable in real-time by both humans (via browser) and Claude agents (via tools). The frontend needs to provide a collaborative markdown editor that connects to the Yjs sync protocol over WebSocket.

## What Changed on the Backend

### Removed

The entire `/files/*` REST API is gone:
- `POST /files/write`
- `GET /files/read`
- `DELETE /files/remove`
- `GET /files/list`
- `POST /files/mkdir`
- `GET /files/exists`

### Added

**REST endpoints** for document CRUD:

| Method | Path | Body | Response |
|--------|------|------|----------|
| `POST` | `/docs` | `{ name: string, content?: string, id?: string }` | `{ id: string, name: string }` |
| `GET` | `/docs` | — | `{ documents: DocumentInfo[] }` |
| `GET` | `/docs/:id` | — | `{ id: string, name: string, content: string }` |
| `DELETE` | `/docs/:id` | — | `{ success: true }` |

Where `DocumentInfo` is:
```ts
{
  id: string      // UUID
  name: string
  createdAt: string
  updatedAt: string
}
```

**Yjs WebSocket sync** on the same `/docs/:id` path:
- When a request to `GET /docs/:id` includes an `Upgrade: websocket` header, it upgrades to a Yjs binary sync protocol connection instead of returning JSON.
- The document content lives in a `Y.Text` type named `'default'` on the `Y.Doc`.

**Claude tools** (server-side, no frontend action needed):
- Claude now has `doc_create`, `doc_read`, `doc_edit`, `doc_append`, `doc_list`, `doc_delete` tools.
- When Claude edits a document, changes flow through the same Yjs doc and broadcast to all connected WebSocket clients automatically.

### Unchanged

- `GET /health` — still returns `{ status: 'healthy', timestamp: string }`
- `POST /config` / `GET /config` — session configuration
- `/ws` — SDK WebSocket for Claude agent communication
- `/sessions` / `/sessions/:id` — session history
- Server runs on port 4000 by default.

## Frontend Integration Points

### 1. Document List

Fetch documents via `GET /docs`. Create via `POST /docs`. Delete via `DELETE /docs/:id`.

### 2. Yjs Collaborative Editor

Connect to `ws://<host>/docs/:id` using a Yjs WebSocket provider (e.g. `y-websocket`'s `WebsocketProvider`). The shared type is `doc.getText('default')` — a `Y.Text` containing markdown.

```ts
import * as Y from 'yjs'
import { WebsocketProvider } from 'y-websocket'

const ydoc = new Y.Doc()
const provider = new WebsocketProvider(
  `ws://${window.location.host}`,
  `/docs/${documentId}`,  // room name doubles as the URL path
  ydoc,
)
const ytext = ydoc.getText('default')
```

Note: `y-websocket`'s `WebsocketProvider` constructor takes `(serverUrl, roomName, ydoc)`. The server expects the WebSocket connection at `/docs/:id`, so set `serverUrl` to the host and `roomName` to `/docs/${id}` — or construct the full URL manually depending on your provider setup.

### 3. Awareness / Presence

The server supports the Yjs awareness protocol on the same WebSocket connection. Set local awareness state to show your cursor/name to other users:

```ts
provider.awareness.setLocalStateField('user', {
  name: 'Human',
  color: '#3b82f6',
})
```

When Claude edits a document via its tools, those edits come through the Yjs doc (they'll appear as remote changes). Claude doesn't currently set awareness state, so there won't be a cursor for it — just content changes appearing.

### 4. Content Model

Documents are **plain markdown text** in a single `Y.Text` shared type named `'default'`. There is no rich-text ProseMirror/Tiptap structure on the backend — the Yjs doc just holds a string. The frontend can render that markdown however it wants (rich editor, code mirror, plain textarea, etc).

If using a rich text editor like Tiptap with `@tiptap/extension-collaboration`, note that Tiptap typically uses `Y.XmlFragment` not `Y.Text`. You'll need to either:
- Use a markdown-aware editor that operates on `Y.Text` directly
- Or do a conversion layer between `Y.Text('default')` and whatever structure your editor expects

The simplest approach is a markdown editor (like CodeMirror with `y-codemirror.next`) that binds directly to `Y.Text`.

### 5. Auto-save

No explicit save needed. All edits go through Yjs, which syncs to the server over WebSocket, and the server persists to SQLite on every update. Content survives server restarts.

## Design Goals

- Humans and Claude edit the same document simultaneously, seeing each other's changes in real-time
- Document list with create/delete
- Clean markdown editing experience
- Collaboration cursors when multiple browser tabs are open
