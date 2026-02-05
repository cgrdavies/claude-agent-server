/**
 * WebSocket collaborative editing tests.
 *
 * Tests real-time document collaboration via WebSocket/Yjs:
 * - Multiple clients connecting to same document
 * - Concurrent edits syncing between clients
 * - CRDT conflict resolution
 * - Awareness state broadcasting
 * - Connection lifecycle (auth, disconnect, reconnect)
 */

import { describe, test, expect, beforeAll, beforeEach, afterAll, afterEach } from 'bun:test'
import type { Server } from 'bun'
import * as Y from 'yjs'
import * as syncProtocol from 'y-protocols/sync'
import * as awarenessProtocol from 'y-protocols/awareness'
import * as encoding from 'lib0/encoding'
import * as decoding from 'lib0/decoding'

import {
  setupTestEnvironment,
  resetAgentTables,
  closeTestConnections,
} from './setup'
import {
  createTestContext,
  createTestTeam,
  type TestContext,
} from './helpers/auth'
import { withAuth } from './helpers/api'

// Set up test environment before importing the app
setupTestEnvironment()

const TEST_PORT = 4444
const messageSync = 0
const messageAwareness = 1

// Server instance for WebSocket tests
let server: Server<unknown> | null = null

// Track WebSocket clients for cleanup
const activeClients: WebSocket[] = []

/**
 * Start the test server with WebSocket support.
 */
async function startServer(): Promise<Server<unknown>> {
  // Reset the Supabase client to ensure it uses test env vars
  const { resetSupabaseClient } = await import('../ws/yjs')
  resetSupabaseClient()

  const { app } = await import('../index')
  const { handleYjsUpgrade, yjsWebsocket } = await import('../ws/yjs')

  return Bun.serve({
    port: TEST_PORT,
    fetch(req, server) {
      const upgraded = handleYjsUpgrade(req, server)
      if (upgraded) return undefined
      return app.fetch(req)
    },
    websocket: yjsWebsocket,
  })
}

/**
 * Stop the test server.
 */
function stopServer() {
  if (server) {
    server.stop()
    server = null
  }
}

/**
 * Create a Yjs-aware WebSocket client that syncs with the server.
 */
let clientIdCounter = 0

class YjsClient {
  ws: WebSocket | null = null
  doc: Y.Doc
  awareness: awarenessProtocol.Awareness
  docId: string
  clientId: number
  connected = false
  synced = false
  private _onSync: (() => void) | null = null
  private _onUpdate: ((update: Uint8Array) => void) | null = null

  constructor(docId: string) {
    this.clientId = ++clientIdCounter
    this.docId = docId
    this.doc = new Y.Doc()
    this.awareness = new awarenessProtocol.Awareness(this.doc)
  }

  /**
   * Connect to the WebSocket server.
   */
  connect(token: string, workspaceId: string, projectId: string): Promise<void> {
    return new Promise((resolve, reject) => {
      const url = `ws://localhost:${TEST_PORT}/ws/documents/${this.docId}?token=${encodeURIComponent(token)}&workspace_id=${workspaceId}&project_id=${projectId}`
      this.ws = new WebSocket(url)
      activeClients.push(this.ws)

      this.ws.binaryType = 'arraybuffer'

      this.ws.onopen = () => {
        this.connected = true
        // Don't send SyncStep1 here - wait for server's first message
        // The server will send SyncStep1 after loading the doc
        resolve()
      }

      this.ws.onerror = (err) => {
        reject(new Error(`WebSocket error: ${err}`))
      }

      this.ws.onclose = (event) => {
        this.connected = false
        this.synced = false
        if (event.code !== 1000) {
          // Abnormal close
          console.warn(`WebSocket closed: ${event.code} ${event.reason}`)
        }
      }

      this.ws.onmessage = (event) => {
        this.handleMessage(event.data as ArrayBuffer)
      }
    })
  }

  /**
   * Handle incoming Yjs sync messages.
   */
  private handleMessage(data: ArrayBuffer) {
    const buf = new Uint8Array(data)
    const decoder = decoding.createDecoder(buf)
    const messageType = decoding.readVarUint(decoder)

    switch (messageType) {
      case messageSync: {
        const encoder = encoding.createEncoder()
        encoding.writeVarUint(encoder, messageSync)
        const syncMessageType = syncProtocol.readSyncMessage(decoder, encoder, this.doc, this)

        // If we received SyncStep1, we should respond with SyncStep2
        if (encoding.length(encoder) > 1) {
          this.ws?.send(encoding.toUint8Array(encoder))
        }

        // After receiving server's SyncStep1 (type 0), send our own SyncStep1
        // to request the document content from the server
        if (syncMessageType === 0) {
          this.sendSyncStep1()
        }

        // SyncStep2 (syncMessageType === 1) or Update (type 2) means we've received content
        if (syncMessageType === 1 || syncMessageType === 2) {
          if (!this.synced) {
            this.synced = true
            this._onSync?.()
          }
        }
        break
      }
      case messageAwareness: {
        const update = decoding.readVarUint8Array(decoder)
        awarenessProtocol.applyAwarenessUpdate(this.awareness, update, this)
        break
      }
    }
  }

  /**
   * Send SyncStep1 to request document state from server.
   */
  sendSyncStep1() {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return

    const encoder = encoding.createEncoder()
    encoding.writeVarUint(encoder, messageSync)
    syncProtocol.writeSyncStep1(encoder, this.doc)
    this.ws.send(encoding.toUint8Array(encoder))
  }

  /**
   * Send a document update to the server.
   */
  sendUpdate(update: Uint8Array) {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return

    const encoder = encoding.createEncoder()
    encoding.writeVarUint(encoder, messageSync)
    syncProtocol.writeUpdate(encoder, update)
    this.ws.send(encoding.toUint8Array(encoder))
  }

  /**
   * Wait for initial sync to complete.
   */
  waitForSync(timeoutMs = 5000): Promise<void> {
    if (this.synced) return Promise.resolve()

    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        reject(new Error('Sync timeout'))
      }, timeoutMs)

      this._onSync = () => {
        clearTimeout(timeout)
        resolve()
      }
    })
  }

  /**
   * Subscribe to document updates.
   */
  onUpdate(callback: (update: Uint8Array) => void) {
    this._onUpdate = callback
    this.doc.on('update', callback)
  }

  /**
   * Set up automatic update broadcasting.
   */
  enableAutoSync() {
    this.doc.on('update', (update: Uint8Array, origin: unknown) => {
      if (origin !== this) {
        // Don't re-send updates we received from the server
        this.sendUpdate(update)
      }
    })
  }

  /**
   * Get the document content as text (from XmlFragment).
   */
  getContent(): string {
    const fragment = this.doc.getXmlFragment('default')
    // Simple text extraction - for testing purposes
    return this.fragmentToText(fragment)
  }

  private fragmentToText(fragment: Y.XmlFragment): string {
    let text = ''
    fragment.forEach((item) => {
      if (item instanceof Y.XmlText) {
        text += item.toString()
      } else if (item instanceof Y.XmlElement) {
        text += this.elementToText(item)
      }
    })
    return text
  }

  private elementToText(element: Y.XmlElement): string {
    let text = ''
    element.forEach((child) => {
      if (child instanceof Y.XmlText) {
        text += child.toString()
      } else if (child instanceof Y.XmlElement) {
        text += this.elementToText(child)
      }
    })
    // Add newline after block elements
    if (['paragraph', 'heading'].includes(element.nodeName)) {
      text += '\n'
    }
    return text
  }

  /**
   * Close the WebSocket connection.
   */
  close() {
    if (this.ws) {
      this.ws.close(1000)
      const idx = activeClients.indexOf(this.ws)
      if (idx !== -1) activeClients.splice(idx, 1)
      this.ws = null
    }
    this.doc.destroy()
  }
}

/**
 * Helper to wait for updates to propagate between clients.
 */
function waitForPropagation(ms = 100): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

/**
 * Dynamic import for clearCache to avoid DB timing issues.
 */
async function getClearCache() {
  const { clearCache } = await import('../document-manager')
  return clearCache
}

describe('Collaborative WebSocket Tests', () => {
  beforeAll(async () => {
    server = await startServer()
  })

  afterAll(async () => {
    // Close all active WebSocket clients
    for (const ws of activeClients) {
      try {
        ws.close(1000)
      } catch {
        // Ignore close errors
      }
    }
    activeClients.length = 0

    stopServer()
    await closeTestConnections()
  })

  beforeEach(async () => {
    await resetAgentTables()
    const clearCache = await getClearCache()
    clearCache()
  })

  // ==========================================================================
  // Connection & Authentication
  // ==========================================================================

  describe('Connection & Authentication', () => {
    test('client can connect to document WebSocket with valid auth', async () => {
      const ctx = await createTestContext()
      const api = withAuth(ctx.token, ctx.workspace.id)

      // Create a document via API
      const createRes = await api.post<{ document: { id: string } }>('/api/documents', {
        body: { name: 'WS Test Doc', content: '# Hello', project_id: ctx.project.id },
      })
      const docId = createRes.data.document.id

      // Connect via WebSocket
      const client = new YjsClient(docId)
      await client.connect(ctx.token, ctx.workspace.id, ctx.project.id)

      expect(client.connected).toBe(true)

      // Wait for sync
      await client.waitForSync()
      expect(client.synced).toBe(true)

      // Content should match
      const content = client.getContent()
      expect(content).toContain('Hello')

      client.close()
    })

    test('connection rejected with invalid token', async () => {
      const ctx = await createTestContext()
      const api = withAuth(ctx.token, ctx.workspace.id)

      const createRes = await api.post<{ document: { id: string } }>('/api/documents', {
        body: { name: 'Auth Test Doc', project_id: ctx.project.id },
      })
      const docId = createRes.data.document.id

      const client = new YjsClient(docId)

      // Use invalid token
      await expect(
        client.connect('invalid-token', ctx.workspace.id, ctx.project.id)
      ).resolves.toBeUndefined() // WebSocket connects but...

      // Wait a bit for server to verify and close
      await waitForPropagation(200)

      // Should be disconnected
      expect(client.connected).toBe(false)

      client.close()
    })

    test('connection rejected for document in different workspace', async () => {
      const ctx1 = await createTestContext({ workspaceName: 'Workspace A' })
      const ctx2 = await createTestContext({ workspaceName: 'Workspace B' })

      // Create doc in workspace A
      const api = withAuth(ctx1.token, ctx1.workspace.id)
      const createRes = await api.post<{ document: { id: string } }>('/api/documents', {
        body: { name: 'Private Doc', project_id: ctx1.project.id },
      })
      const docId = createRes.data.document.id

      // Try to connect from workspace B (with their own project)
      const client = new YjsClient(docId)
      await client.connect(ctx2.token, ctx2.workspace.id, ctx2.project.id)

      // Wait for server to verify and close
      await waitForPropagation(200)

      // Should be disconnected (doc not found in their project)
      expect(client.connected).toBe(false)

      client.close()
    })
  })

  // ==========================================================================
  // Multi-Client Sync
  // ==========================================================================

  describe('Multi-Client Sync', () => {
    test('two clients receive same initial document state', async () => {
      const { workspace, project, members } = await createTestTeam(2)
      const [user1, user2] = members

      // Create document via user1's API
      const api = withAuth(user1!.token, workspace.id)
      const createRes = await api.post<{ document: { id: string } }>('/api/documents', {
        body: { name: 'Shared Doc', content: '# Shared Document\n\nInitial content.', project_id: project.id },
      })
      const docId = createRes.data.document.id

      // Clear cache so both clients load fresh
      const clearCache = await getClearCache()
      clearCache()

      // Connect both clients
      const client1 = new YjsClient(docId)
      const client2 = new YjsClient(docId)

      await client1.connect(user1!.token, workspace.id, project.id)
      await client2.connect(user2!.token, workspace.id, project.id)

      await client1.waitForSync()
      await client2.waitForSync()

      // Both should have same content
      const content1 = client1.getContent()
      const content2 = client2.getContent()

      expect(content1).toContain('Shared Document')
      expect(content1).toContain('Initial content')
      expect(content1).toBe(content2)

      client1.close()
      client2.close()
    })

    test('edit from one client propagates to another', async () => {
      const { workspace, project, members } = await createTestTeam(2)
      const [user1, user2] = members

      // Create document
      const api = withAuth(user1!.token, workspace.id)
      const createRes = await api.post<{ document: { id: string } }>('/api/documents', {
        body: { name: 'Sync Test', content: 'Original', project_id: project.id },
      })
      const docId = createRes.data.document.id

      const clearCache = await getClearCache()
      clearCache()

      // Connect both clients
      const client1 = new YjsClient(docId)
      const client2 = new YjsClient(docId)

      await client1.connect(user1!.token, workspace.id, project.id)
      await client2.connect(user2!.token, workspace.id, project.id)

      client1.enableAutoSync()
      client2.enableAutoSync()

      await client1.waitForSync()
      await client2.waitForSync()

      // Track updates on client2
      let client2Updated = false
      client2.doc.on('update', () => {
        client2Updated = true
      })

      // Client1 makes an edit
      const fragment1 = client1.doc.getXmlFragment('default')
      client1.doc.transact(() => {
        // Clear and add new content
        while (fragment1.length > 0) {
          fragment1.delete(0, 1)
        }
        const paragraph = new Y.XmlElement('paragraph')
        const text = new Y.XmlText()
        text.insert(0, 'Edited by client 1')
        paragraph.insert(0, [text])
        fragment1.insert(0, [paragraph])
      })

      // Wait for propagation
      await waitForPropagation(300)

      // Client2 should have received the update
      expect(client2Updated).toBe(true)

      const content2 = client2.getContent()
      expect(content2).toContain('Edited by client 1')

      client1.close()
      client2.close()
    })

    test('concurrent edits merge via CRDT', async () => {
      const { workspace, project, members } = await createTestTeam(2)
      const [user1, user2] = members

      // Create document with list structure
      const api = withAuth(user1!.token, workspace.id)
      const createRes = await api.post<{ document: { id: string } }>('/api/documents', {
        body: { name: 'Concurrent Test', content: '# Items\n\n- Item A\n- Item B', project_id: project.id },
      })
      const docId = createRes.data.document.id

      const clearCache = await getClearCache()
      clearCache()

      const client1 = new YjsClient(docId)
      const client2 = new YjsClient(docId)

      await client1.connect(user1!.token, workspace.id, project.id)
      await client2.connect(user2!.token, workspace.id, project.id)

      client1.enableAutoSync()
      client2.enableAutoSync()

      await client1.waitForSync()
      await client2.waitForSync()

      // Both clients make concurrent edits
      // Client1 adds to the beginning, Client2 adds to the end
      const fragment1 = client1.doc.getXmlFragment('default')
      const fragment2 = client2.doc.getXmlFragment('default')

      // Make concurrent transactions with small stagger to ensure both propagate
      client1.doc.transact(() => {
        const paragraph = new Y.XmlElement('paragraph')
        const text = new Y.XmlText()
        text.insert(0, 'Client 1 was here')
        paragraph.insert(0, [text])
        fragment1.insert(0, [paragraph])
      })

      // Small delay to let first edit start propagating
      await waitForPropagation(50)

      client2.doc.transact(() => {
        const paragraph = new Y.XmlElement('paragraph')
        const text = new Y.XmlText()
        text.insert(0, 'Client 2 was here')
        paragraph.insert(0, [text])
        fragment2.push([paragraph])
      })

      // Wait for full sync
      await waitForPropagation(600)

      // Both clients should converge to same state with both edits
      const content1 = client1.getContent()
      const content2 = client2.getContent()

      expect(content1).toContain('Client 1 was here')
      expect(content1).toContain('Client 2 was here')
      expect(content1).toBe(content2)

      client1.close()
      client2.close()
    })
  })

  // ==========================================================================
  // Persistence
  // ==========================================================================

  describe('Persistence', () => {
    test('WebSocket edits are persisted to database', async () => {
      const ctx = await createTestContext()
      const api = withAuth(ctx.token, ctx.workspace.id)

      // Create document
      const createRes = await api.post<{ document: { id: string } }>('/api/documents', {
        body: { name: 'Persist Test', content: 'Before edit', project_id: ctx.project.id },
      })
      const docId = createRes.data.document.id

      const clearCache = await getClearCache()
      clearCache()

      // Connect and edit via WebSocket
      const client = new YjsClient(docId)
      await client.connect(ctx.token, ctx.workspace.id, ctx.project.id)
      client.enableAutoSync()
      await client.waitForSync()

      const fragment = client.doc.getXmlFragment('default')
      client.doc.transact(() => {
        while (fragment.length > 0) {
          fragment.delete(0, 1)
        }
        const paragraph = new Y.XmlElement('paragraph')
        const text = new Y.XmlText()
        text.insert(0, 'WebSocket edit')
        paragraph.insert(0, [text])
        fragment.insert(0, [paragraph])
      })

      // Wait for debounced persist (500ms + buffer)
      await waitForPropagation(800)

      client.close()

      // Clear cache to force DB read
      clearCache()

      // Read via API - should see the WebSocket edit
      const getRes = await api.get<{ document: { content: string } }>(`/api/documents/${docId}?project_id=${ctx.project.id}`)
      expect(getRes.data.document.content).toContain('WebSocket edit')
    })

    test('new client receives persisted state after original client disconnects', async () => {
      const { workspace, project, members } = await createTestTeam(2)
      const [user1, user2] = members
      const api = withAuth(user1!.token, workspace.id)

      // Create and edit via first client
      const createRes = await api.post<{ document: { id: string } }>('/api/documents', {
        body: { name: 'Handoff Test', content: 'Initial', project_id: project.id },
      })
      const docId = createRes.data.document.id

      const clearCache = await getClearCache()
      clearCache()

      const client1 = new YjsClient(docId)
      await client1.connect(user1!.token, workspace.id, project.id)
      client1.enableAutoSync()
      await client1.waitForSync()

      // Edit the document
      const fragment1 = client1.doc.getXmlFragment('default')
      client1.doc.transact(() => {
        while (fragment1.length > 0) {
          fragment1.delete(0, 1)
        }
        const paragraph = new Y.XmlElement('paragraph')
        const text = new Y.XmlText()
        text.insert(0, 'Edited and left')
        paragraph.insert(0, [text])
        fragment1.insert(0, [paragraph])
      })

      // Wait for persist
      await waitForPropagation(800)

      // Disconnect first client
      client1.close()

      // Clear cache to ensure fresh load
      clearCache()

      // Second client connects later
      const client2 = new YjsClient(docId)
      await client2.connect(user2!.token, workspace.id, project.id)
      await client2.waitForSync()

      // Should see the persisted edit
      const content2 = client2.getContent()
      expect(content2).toContain('Edited and left')

      client2.close()
    })
  })

  // ==========================================================================
  // Edge Cases
  // ==========================================================================

  describe('Edge Cases', () => {
    test('handles rapid successive edits', async () => {
      const ctx = await createTestContext()
      const api = withAuth(ctx.token, ctx.workspace.id)

      const createRes = await api.post<{ document: { id: string } }>('/api/documents', {
        body: { name: 'Rapid Edit Test', content: '', project_id: ctx.project.id },
      })
      const docId = createRes.data.document.id

      const clearCache = await getClearCache()
      clearCache()

      const client = new YjsClient(docId)
      await client.connect(ctx.token, ctx.workspace.id, ctx.project.id)
      client.enableAutoSync()
      await client.waitForSync()

      // Make many rapid edits
      const fragment = client.doc.getXmlFragment('default')
      for (let i = 0; i < 10; i++) {
        client.doc.transact(() => {
          const paragraph = new Y.XmlElement('paragraph')
          const text = new Y.XmlText()
          text.insert(0, `Line ${i}`)
          paragraph.insert(0, [text])
          fragment.push([paragraph])
        })
      }

      // Wait for all to sync
      await waitForPropagation(500)

      // Should have all 10 lines
      const content = client.getContent()
      for (let i = 0; i < 10; i++) {
        expect(content).toContain(`Line ${i}`)
      }

      client.close()
    })

    test('client reconnection after disconnect', async () => {
      const ctx = await createTestContext()
      const api = withAuth(ctx.token, ctx.workspace.id)

      const createRes = await api.post<{ document: { id: string } }>('/api/documents', {
        body: { name: 'Reconnect Test', content: 'Initial content', project_id: ctx.project.id },
      })
      const docId = createRes.data.document.id

      const clearCache = await getClearCache()
      clearCache()

      // First connection
      const client1 = new YjsClient(docId)
      await client1.connect(ctx.token, ctx.workspace.id, ctx.project.id)
      client1.enableAutoSync()
      await client1.waitForSync()

      expect(client1.getContent()).toContain('Initial content')

      // Disconnect
      client1.close()
      await waitForPropagation(100)

      // Reconnect with new client
      clearCache()
      const client2 = new YjsClient(docId)
      await client2.connect(ctx.token, ctx.workspace.id, ctx.project.id)
      await client2.waitForSync()

      // Should still have the content
      expect(client2.getContent()).toContain('Initial content')

      client2.close()
    })

    test('three or more clients stay in sync', async () => {
      const { workspace, project, members } = await createTestTeam(3)
      const api = withAuth(members[0]!.token, workspace.id)

      const createRes = await api.post<{ document: { id: string } }>('/api/documents', {
        body: { name: 'Multi-Client Test', content: 'Start', project_id: project.id },
      })
      const docId = createRes.data.document.id

      const clearCache = await getClearCache()
      clearCache()

      // Connect all three clients
      const clients = await Promise.all(
        members.map(async (m) => {
          const client = new YjsClient(docId)
          await client.connect(m.token, workspace.id, project.id)
          client.enableAutoSync()
          await client.waitForSync()
          return client
        })
      )

      // Each client makes an edit
      clients.forEach((client, i) => {
        const fragment = client.doc.getXmlFragment('default')
        client.doc.transact(() => {
          const paragraph = new Y.XmlElement('paragraph')
          const text = new Y.XmlText()
          text.insert(0, `Edit from client ${i}`)
          paragraph.insert(0, [text])
          fragment.push([paragraph])
        })
      })

      // Wait for all edits to propagate
      await waitForPropagation(600)

      // All clients should have all edits
      const contents = clients.map(c => c.getContent())

      for (let i = 0; i < 3; i++) {
        expect(contents[0]).toContain(`Edit from client ${i}`)
        expect(contents[1]).toContain(`Edit from client ${i}`)
        expect(contents[2]).toContain(`Edit from client ${i}`)
      }

      // All clients should have identical content
      expect(contents[0]).toBe(contents[1])
      expect(contents[1]).toBe(contents[2])

      clients.forEach(c => c.close())
    })
  })
})
