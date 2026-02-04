import { homedir } from 'os'
import { join } from 'path'
import { readdir } from 'node:fs/promises'
import {
  query,
  type Options,
  type SDKUserMessage,
} from '@anthropic-ai/claude-agent-sdk'
import { type ServerWebSocket } from 'bun'

import { SERVER_PORT, WORKSPACE_DIR_NAME } from './const'
import * as docManager from './document-manager'
import {
  handleYjsOpen,
  handleYjsMessage,
  handleYjsClose,
  type YjsWSData,
} from './yjs-sync'
import { handleMessage } from './message-handler'
import { type QueryConfig, type WSOutputMessage } from './message-types'
import { documentToolsServer } from './document-tools'

// WebSocket data type union
type WSData =
  | { type: 'sdk' }
  | YjsWSData

const workspaceDirectory = join(homedir(), WORKSPACE_DIR_NAME)
const claudeProjectsDir = join(homedir(), '.claude', 'projects')

// Find the sessions directory for the workspace cwd
async function getSessionsDir(): Promise<string | null> {
  try {
    const entries = await readdir(claudeProjectsDir)
    // The SDK slugifies the cwd by replacing / with -
    const slug = workspaceDirectory.replace(/\//g, '-')
    const match = entries.find(e => e === slug)
    if (match) return join(claudeProjectsDir, match)
    // Fallback: find any entry ending with the workspace dir name
    const fallback = entries.find(e => e.endsWith(WORKSPACE_DIR_NAME))
    if (fallback) return join(claudeProjectsDir, fallback)
    return null
  } catch {
    return null
  }
}

// Single WebSocket connection (only one allowed)
let activeConnection: ServerWebSocket<WSData> | null = null

// Message queue
const messageQueue: SDKUserMessage[] = []

// Stream reference for interrupts
let activeStream: ReturnType<typeof query> | null = null

// Stored query configuration
let queryConfig: QueryConfig = {}

// Restart the SDK stream with current config
function restartStream() {
  if (activeStream) {
    activeStream.interrupt()
    activeStream = null
  }
  messageQueue.length = 0
  processMessages()
}

// Create an async generator that yields messages from the queue
async function* generateMessages() {
  while (true) {
    // Wait for messages in the queue
    while (messageQueue.length > 0) {
      const message = messageQueue.shift()
      yield message!
    }

    // Small delay to prevent tight loop
    await new Promise(resolve => setTimeout(resolve, 10))
  }
}

// Process messages from the SDK and send to WebSocket client
async function processMessages() {
  try {
    const options: Options = {
      permissionMode: 'bypassPermissions',
      allowDangerouslySkipPermissions: true,
      settingSources: ['local'],
      cwd: workspaceDirectory,
      stderr: data => {
        if (activeConnection) {
          const output: WSOutputMessage = {
            type: 'info',
            data,
          }
          activeConnection.send(JSON.stringify(output))
        }
      },
      ...queryConfig,
      mcpServers: {
        ...queryConfig.mcpServers,
        documents: documentToolsServer,
      } as Options['mcpServers'],
      env: {
        PATH: process.env.PATH,
        ...(queryConfig.anthropicApiKey && {
          ANTHROPIC_API_KEY: queryConfig.anthropicApiKey,
        }),
        ...(process.env.CLAUDE_CODE_OAUTH_TOKEN && {
          CLAUDE_CODE_OAUTH_TOKEN: process.env.CLAUDE_CODE_OAUTH_TOKEN,
        }),
      },
    }

    console.info('Starting query with options', options)

    activeStream = query({
      prompt: generateMessages(),
      options,
    })

    for await (const message of activeStream) {
      if (activeConnection) {
        const output: WSOutputMessage = {
          type: 'sdk_message',
          data: message,
        }
        activeConnection.send(JSON.stringify(output))
      }
    }
  } catch (error) {
    console.error('Error processing messages:', error)
    if (activeConnection) {
      const output: WSOutputMessage = {
        type: 'error',
        error: error instanceof Error ? error.message : 'Unknown error',
      }
      activeConnection.send(JSON.stringify(output))
    }
  }
}

// Create WebSocket server
const server = Bun.serve<WSData>({
  port: SERVER_PORT,
  async fetch(req, server) {
    const url = new URL(req.url)

    // Configuration endpoint
    if (url.pathname === '/config' && req.method === 'POST') {
      return req
        .json()
        .then(config => {
          queryConfig = config as QueryConfig
          // Restart the stream if config changed and we have an active connection
          if (activeStream && activeConnection) {
            restartStream()
          }
          return Response.json({ success: true, config: queryConfig })
        })
        .catch(() => {
          return Response.json({ error: 'Invalid JSON' }, { status: 400 })
        })
    }

    // Get current configuration
    if (url.pathname === '/config' && req.method === 'GET') {
      return Response.json({ config: queryConfig })
    }

    // Health check endpoint
    if (url.pathname === '/health' && req.method === 'GET') {
      return Response.json({
        status: 'healthy',
        timestamp: new Date().toISOString(),
      })
    }

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

    // GET /docs/:id - Read document as markdown (or WebSocket upgrade for Yjs sync)
    if (url.pathname.match(/^\/docs\/[^/]+$/)) {
      const id = decodeURIComponent(url.pathname.slice('/docs/'.length))

      // WebSocket upgrade for Yjs sync
      if (req.headers.get('upgrade') === 'websocket') {
        if (!docManager.getDoc(id)) {
          return Response.json({ error: 'Document not found' }, { status: 404 })
        }
        const data: YjsWSData = { type: 'yjs', docId: id }
        if (server.upgrade(req, { data })) return
        return new Response('WebSocket upgrade failed', { status: 500 })
      }

      // GET - return markdown content
      if (req.method === 'GET') {
        const content = docManager.readDocAsText(id)
        if (content === null) {
          return Response.json({ error: 'Document not found' }, { status: 404 })
        }
        const info = docManager.getDocInfo(id)
        return Response.json({ id, name: info?.name, content })
      }

      // DELETE - delete a document
      if (req.method === 'DELETE') {
        docManager.deleteDoc(id)
        return Response.json({ success: true })
      }
    }

    // GET /sessions - List available sessions
    if (url.pathname === '/sessions' && req.method === 'GET') {
      try {
        const sessionsDir = await getSessionsDir()
        if (!sessionsDir) {
          return Response.json({ sessions: [] })
        }
        const entries = await readdir(sessionsDir)
        const sessions = entries
          .filter(e => e.endsWith('.jsonl'))
          .map(e => e.replace('.jsonl', ''))
          .filter(id => !id.startsWith('agent-'))
        return Response.json({ sessions })
      } catch (error) {
        return Response.json({ error: String(error) }, { status: 500 })
      }
    }

    // GET /sessions/:id - Get session message history
    if (url.pathname.startsWith('/sessions/') && req.method === 'GET') {
      const sessionId = url.pathname.slice('/sessions/'.length)
      if (!sessionId) {
        return Response.json({ error: 'Session ID is required' }, { status: 400 })
      }
      try {
        const sessionsDir = await getSessionsDir()
        if (!sessionsDir) {
          return Response.json({ error: 'No sessions directory found' }, { status: 404 })
        }
        const filePath = join(sessionsDir, `${sessionId}.jsonl`)
        const file = Bun.file(filePath)
        if (!(await file.exists())) {
          return Response.json({ error: 'Session not found' }, { status: 404 })
        }
        const text = await file.text()
        const messages = text
          .trim()
          .split('\n')
          .map(line => JSON.parse(line))
        return Response.json({ sessionId, messages })
      } catch (error) {
        return Response.json({ error: String(error) }, { status: 500 })
      }
    }

    // SDK WebSocket endpoint
    if (url.pathname === '/ws') {
      if (server.upgrade(req, { data: { type: 'sdk' } })) return
    }

    return new Response('Not Found', { status: 404 })
  },

  websocket: {
    open(ws: ServerWebSocket<WSData>) {
      if (ws.data.type === 'yjs') {
        handleYjsOpen(ws as ServerWebSocket<YjsWSData>)
        return
      }

      // SDK connection
      if (activeConnection) {
        const output: WSOutputMessage = {
          type: 'error',
          error: 'Server already has an active connection',
        }
        ws.send(JSON.stringify(output))
        ws.close()
        return
      }

      activeConnection = ws

      // Start processing messages when first connection is made
      if (!activeStream) {
        processMessages()
      }

      const output: WSOutputMessage = { type: 'connected' }
      ws.send(JSON.stringify(output))
    },

    async message(ws: ServerWebSocket<WSData>, message) {
      if (ws.data.type === 'yjs') {
        handleYjsMessage(ws as ServerWebSocket<YjsWSData>, message as unknown as ArrayBuffer)
        return
      }

      await handleMessage(ws, message, {
        messageQueue,
        getActiveStream: () => activeStream,
      })
    },

    close(ws: ServerWebSocket<WSData>) {
      if (ws.data.type === 'yjs') {
        handleYjsClose(ws as ServerWebSocket<YjsWSData>)
        return
      }

      if (activeConnection === ws) {
        activeConnection = null
      }
    },
  },
})

console.log(`🚀 WebSocket server running on http://localhost:${server.port}`)
console.log(`   Config endpoint: http://localhost:${server.port}/config`)
console.log(`   WebSocket endpoint: ws://localhost:${server.port}/ws`)
