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
const docConnections = new Map<string, Set<ServerWebSocket<YjsWSData>>>()

export type YjsWSData = {
  type: 'yjs'
  docId: string
  _updateHandler?: (update: Uint8Array, origin: unknown) => void
}

export function getAwareness(docId: string, doc: Y.Doc): awarenessProtocol.Awareness {
  if (!awarenessInstances.has(docId)) {
    awarenessInstances.set(docId, new awarenessProtocol.Awareness(doc))
  }
  return awarenessInstances.get(docId)!
}

function broadcast(docId: string, message: Uint8Array, exclude?: ServerWebSocket<YjsWSData>): void {
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
  // Store handler reference for cleanup
  ws.data._updateHandler = updateHandler
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
    const awarenessEncoder = encoding.createEncoder()
    encoding.writeVarUint(awarenessEncoder, messageAwareness)
    encoding.writeVarUint8Array(
      awarenessEncoder,
      awarenessProtocol.encodeAwarenessUpdate(
        awareness,
        Array.from(awarenessStates.keys()),
      ),
    )
    ws.send(encoding.toUint8Array(awarenessEncoder))
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
  if (doc && ws.data._updateHandler) {
    doc.off('update', ws.data._updateHandler)
  }

  // Remove from connection tracking
  const conns = docConnections.get(docId)
  if (conns) {
    conns.delete(ws)
    if (conns.size === 0) {
      docConnections.delete(docId)
      // Clean up awareness
      awarenessInstances.delete(docId)
    }
  }
}
