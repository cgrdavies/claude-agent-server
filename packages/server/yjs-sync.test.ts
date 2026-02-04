import { test, expect, beforeAll, afterAll, beforeEach } from 'bun:test'
import * as Y from 'yjs'
import * as syncProtocol from 'y-protocols/sync'
import * as encoding from 'lib0/encoding'
import * as decoding from 'lib0/decoding'

import * as docManager from './document-manager'

const PORT = 4111 // Use a different port for tests
const BASE_URL = `http://localhost:${PORT}`
const WS_URL = `ws://localhost:${PORT}`

// Minimal Yjs WebSocket sync client for testing
class TestYjsClient {
  ws: WebSocket
  doc: Y.Doc
  connected: Promise<void>
  synced: Promise<void>
  private resolveConnected!: () => void
  private resolveSynced!: () => void
  private _synced = false

  constructor(docId: string) {
    this.doc = new Y.Doc()
    this.connected = new Promise(resolve => {
      this.resolveConnected = resolve
    })
    this.synced = new Promise(resolve => {
      this.resolveSynced = resolve
    })

    this.ws = new WebSocket(`${WS_URL}/docs/${docId}`)
    this.ws.binaryType = 'arraybuffer'

    this.ws.onopen = () => {
      this.resolveConnected()
      // Send our own SyncStep1 to request the server's state
      const encoder = encoding.createEncoder()
      encoding.writeVarUint(encoder, 0) // messageSync
      syncProtocol.writeSyncStep1(encoder, this.doc)
      this.ws.send(encoding.toUint8Array(encoder))
    }

    this.ws.onmessage = (event: MessageEvent) => {
      const data = new Uint8Array(event.data as ArrayBuffer)
      const decoder = decoding.createDecoder(data)
      const messageType = decoding.readVarUint(decoder)

      if (messageType === 0) {
        // Sync message
        const encoder = encoding.createEncoder()
        encoding.writeVarUint(encoder, 0)
        const msgType = syncProtocol.readSyncMessage(decoder, encoder, this.doc, this)
        if (encoding.length(encoder) > 1) {
          this.ws.send(encoding.toUint8Array(encoder))
        }
        // SyncStep2 (msgType 1) means we received the server's full state
        if (msgType === 1 && !this._synced) {
          this._synced = true
          this.resolveSynced()
        }
      }
      // Ignore awareness messages for now
    }

    // Also listen for local updates to send to server
    this.doc.on('update', (update: Uint8Array, origin: unknown) => {
      if (origin === 'local') {
        const encoder = encoding.createEncoder()
        encoding.writeVarUint(encoder, 0)
        syncProtocol.writeUpdate(encoder, update)
        if (this.ws.readyState === WebSocket.OPEN) {
          this.ws.send(encoding.toUint8Array(encoder))
        }
      }
    })
  }

  getText(): string {
    return this.doc.getText('default').toString()
  }

  insertText(index: number, text: string): void {
    this.doc.transact(() => {
      this.doc.getText('default').insert(index, text)
    }, 'local')
  }

  close(): void {
    this.ws.close()
  }
}

// Start a minimal test server
let server: ReturnType<typeof Bun.serve>

// Dynamic import to avoid circular issues with db initialization
let yjsSync: typeof import('./yjs-sync')

beforeAll(async () => {
  yjsSync = await import('./yjs-sync')

  type WSData = { type: 'sdk' } | import('./yjs-sync').YjsWSData

  server = Bun.serve<WSData>({
    port: PORT,
    async fetch(req, server) {
      const url = new URL(req.url)

      // POST /docs - create
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

      // GET /docs - list
      if (url.pathname === '/docs' && req.method === 'GET') {
        return Response.json({ documents: docManager.listDocs() })
      }

      // GET/DELETE /docs/:id
      if (url.pathname.match(/^\/docs\/[^/]+$/)) {
        const id = decodeURIComponent(url.pathname.slice('/docs/'.length))

        if (req.headers.get('upgrade') === 'websocket') {
          if (!docManager.getDoc(id)) {
            return Response.json({ error: 'Document not found' }, { status: 404 })
          }
          const data: import('./yjs-sync').YjsWSData = { type: 'yjs', docId: id }
          if (server.upgrade(req, { data })) return
          return new Response('WebSocket upgrade failed', { status: 500 })
        }

        if (req.method === 'GET') {
          const content = docManager.readDocAsText(id)
          if (content === null) {
            return Response.json({ error: 'Document not found' }, { status: 404 })
          }
          const info = docManager.getDocInfo(id)
          return Response.json({ id, name: info?.name, content })
        }

        if (req.method === 'DELETE') {
          docManager.deleteDoc(id)
          return Response.json({ success: true })
        }
      }

      return new Response('Not Found', { status: 404 })
    },
    websocket: {
      open(ws) {
        if ((ws.data as WSData).type === 'yjs') {
          yjsSync.handleYjsOpen(ws as any)
        }
      },
      message(ws, message) {
        if ((ws.data as WSData).type === 'yjs') {
          yjsSync.handleYjsMessage(ws as any, message as unknown as ArrayBuffer)
        }
      },
      close(ws) {
        if ((ws.data as WSData).type === 'yjs') {
          yjsSync.handleYjsClose(ws as any)
        }
      },
    },
  })
})

afterAll(() => {
  server?.stop()
})

beforeEach(() => {
  // Clean up documents
  const docs = docManager.listDocs()
  for (const doc of docs) {
    docManager.deleteDoc(doc.id)
  }
})

// Helper to wait for sync propagation
function waitForSync(ms = 200): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms))
}

test('Document CRUD via REST', async () => {
  // Create
  const createRes = await fetch(`${BASE_URL}/docs`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: 'test', content: '# Hello' }),
  })
  expect(createRes.ok).toBe(true)
  const { id, name } = (await createRes.json()) as { id: string; name: string }
  expect(name).toBe('test')
  expect(id).toBeTruthy()

  // List
  const listRes = await fetch(`${BASE_URL}/docs`)
  const listData = (await listRes.json()) as { documents: any[] }
  expect(listData.documents.length).toBe(1)
  expect(listData.documents[0]!.name).toBe('test')

  // Read
  const readRes = await fetch(`${BASE_URL}/docs/${id}`)
  const readData = (await readRes.json()) as { id: string; name: string; content: string }
  expect(readData.content).toBe('# Hello')
  expect(readData.name).toBe('test')

  // Delete
  const delRes = await fetch(`${BASE_URL}/docs/${id}`, { method: 'DELETE' })
  expect(delRes.ok).toBe(true)

  // Verify deleted
  const readRes2 = await fetch(`${BASE_URL}/docs/${id}`)
  expect(readRes2.status).toBe(404)
})

test('Yjs client syncs initial document content', async () => {
  // Create document with content
  const res = await fetch(`${BASE_URL}/docs`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ id: 'sync-test', name: 'Sync Test', content: '# Sync Test' }),
  })
  expect(res.ok).toBe(true)

  // Connect Yjs client
  const client = new TestYjsClient('sync-test')
  await client.synced

  // Client should have the document content
  expect(client.getText()).toBe('# Sync Test')

  client.close()
})

test('Server-side edits propagate to Yjs client', async () => {
  // Create document
  await fetch(`${BASE_URL}/docs`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ id: 'server-edit', name: 'Server Edit', content: 'Original' }),
  })

  // Connect client
  const client = new TestYjsClient('server-edit')
  await client.synced
  expect(client.getText()).toBe('Original')

  // Edit via document manager (simulating Claude tool)
  docManager.editDoc('server-edit', 'Original', 'Modified')
  await waitForSync()

  // Client should see the change
  expect(client.getText()).toBe('Modified')

  client.close()
})

test('Yjs client edits propagate to server (readable via REST)', async () => {
  // Create document
  await fetch(`${BASE_URL}/docs`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ id: 'client-edit', name: 'Client Edit', content: 'Start' }),
  })

  // Connect client
  const client = new TestYjsClient('client-edit')
  await client.synced

  // Edit from client
  client.insertText(5, ' Here')
  await waitForSync()

  // Read via REST
  const readRes = await fetch(`${BASE_URL}/docs/client-edit`)
  const data = (await readRes.json()) as { content: string }
  expect(data.content).toBe('Start Here')

  client.close()
})

test('Two Yjs clients see each others changes', async () => {
  // Create document
  await fetch(`${BASE_URL}/docs`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ id: 'multi-client', name: 'Multi Client', content: 'Base' }),
  })

  // Connect two clients
  const client1 = new TestYjsClient('multi-client')
  const client2 = new TestYjsClient('multi-client')
  await client1.synced
  await client2.synced

  expect(client1.getText()).toBe('Base')
  expect(client2.getText()).toBe('Base')

  // Client 1 edits
  client1.insertText(4, ' Text')
  await waitForSync(300)

  // Both clients should see the change
  expect(client1.getText()).toBe('Base Text')
  expect(client2.getText()).toBe('Base Text')

  client1.close()
  client2.close()
})

test('WebSocket connection to non-existent document gets 404', async () => {
  const readRes = await fetch(`${BASE_URL}/docs/nonexistent`)
  expect(readRes.status).toBe(404)
})

// --- REST endpoint edge cases ---

test('POST /docs without name returns 400', async () => {
  const res = await fetch(`${BASE_URL}/docs`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ content: 'no name provided' }),
  })
  expect(res.status).toBe(400)
  const data = (await res.json()) as { error: string }
  expect(data.error).toBe('name is required')
})

test('POST /docs with explicit id uses that id', async () => {
  const res = await fetch(`${BASE_URL}/docs`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ id: 'custom-id-123', name: 'Custom ID Doc', content: 'test' }),
  })
  expect(res.ok).toBe(true)
  const data = (await res.json()) as { id: string; name: string }
  expect(data.id).toBe('custom-id-123')

  // Verify readable by that id
  const readRes = await fetch(`${BASE_URL}/docs/custom-id-123`)
  expect(readRes.ok).toBe(true)
  const readData = (await readRes.json()) as { content: string }
  expect(readData.content).toBe('test')
})

test('POST /docs with duplicate id returns error', async () => {
  await fetch(`${BASE_URL}/docs`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ id: 'dup-rest', name: 'First' }),
  })
  const res = await fetch(`${BASE_URL}/docs`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ id: 'dup-rest', name: 'Second' }),
  })
  expect(res.ok).toBe(false)
})

test('DELETE /docs/:id on non-existent doc succeeds', async () => {
  const res = await fetch(`${BASE_URL}/docs/does-not-exist`, { method: 'DELETE' })
  expect(res.ok).toBe(true)
  const data = (await res.json()) as { success: boolean }
  expect(data.success).toBe(true)
})

test('GET /docs/:id with URL-encoded id works', async () => {
  const id = 'doc with spaces & special=chars'
  docManager.createDoc(id, 'Special ID', 'content here')

  const readRes = await fetch(`${BASE_URL}/docs/${encodeURIComponent(id)}`)
  expect(readRes.ok).toBe(true)
  const data = (await readRes.json()) as { id: string; content: string }
  expect(data.content).toBe('content here')

  // Delete with encoded id
  const delRes = await fetch(`${BASE_URL}/docs/${encodeURIComponent(id)}`, { method: 'DELETE' })
  expect(delRes.ok).toBe(true)
})

test('GET /docs returns empty list when no documents', async () => {
  const res = await fetch(`${BASE_URL}/docs`)
  const data = (await res.json()) as { documents: any[] }
  expect(data.documents).toEqual([])
})

test('POST /docs without content creates empty document', async () => {
  const res = await fetch(`${BASE_URL}/docs`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: 'Empty' }),
  })
  expect(res.ok).toBe(true)
  const { id } = (await res.json()) as { id: string }

  const readRes = await fetch(`${BASE_URL}/docs/${id}`)
  const data = (await readRes.json()) as { content: string }
  expect(data.content).toBe('')
})

test('Yjs client disconnect cleans up connection tracking', async () => {
  // Create doc and connect
  docManager.createDoc('cleanup-test', 'Cleanup', 'data')
  const client = new TestYjsClient('cleanup-test')
  await client.synced

  // Close and wait for cleanup
  client.close()
  await waitForSync()

  // Doc should still be readable via REST (not destroyed, just connection removed)
  const content = docManager.readDocAsText('cleanup-test')
  expect(content).toBe('data')
})

test('Server-side edit without connected clients persists', async () => {
  docManager.createDoc('no-client', 'No Client', 'before')

  // Edit with no WebSocket clients connected
  docManager.editDoc('no-client', 'before', 'after')

  const content = docManager.readDocAsText('no-client')
  expect(content).toBe('after')

  // Verify via REST
  const res = await fetch(`${BASE_URL}/docs/no-client`)
  const data = (await res.json()) as { content: string }
  expect(data.content).toBe('after')
})
