import { homedir } from 'os'
import { join } from 'path'
import {
  query,
  type Options,
  type SDKUserMessage,
} from '@anthropic-ai/claude-agent-sdk'
import { type ServerWebSocket } from 'bun'

import { SERVER_PORT, WORKSPACE_DIR_NAME } from './const'
import * as fileHandler from './file-handler'
import { handleMessage } from './message-handler'
import { type QueryConfig, type WSOutputMessage } from './message-types'

const workspaceDirectory = join(homedir(), WORKSPACE_DIR_NAME)

// Single WebSocket connection (only one allowed)
let activeConnection: ServerWebSocket | null = null

// Message queue
const messageQueue: SDKUserMessage[] = []

// Stream reference for interrupts
let activeStream: ReturnType<typeof query> | null = null

// Stored query configuration
let queryConfig: QueryConfig = {}

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
const server = Bun.serve({
  port: SERVER_PORT,
  async fetch(req, server) {
    const url = new URL(req.url)

    // Configuration endpoint
    if (url.pathname === '/config' && req.method === 'POST') {
      return req
        .json()
        .then(config => {
          queryConfig = config as QueryConfig
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

    // File operations endpoints
    // POST /files/write - Write file
    if (url.pathname === '/files/write' && req.method === 'POST') {
      const path = url.searchParams.get('path')
      if (!path) {
        return Response.json({ error: 'Path is required' }, { status: 400 })
      }
      try {
        const contentType = req.headers.get('content-type') || ''
        let content: string | Blob
        if (contentType.includes('application/json')) {
          const body = (await req.json()) as { content: string }
          content = body.content
        } else {
          content = await req.blob()
        }
        await fileHandler.writeFile(path, content)
        return Response.json({ success: true })
      } catch (error) {
        return Response.json({ error: String(error) }, { status: 500 })
      }
    }

    // GET /files/read - Read file
    if (url.pathname === '/files/read' && req.method === 'GET') {
      const path = url.searchParams.get('path')
      const format = (url.searchParams.get('format') || 'text') as 'text' | 'blob'
      if (!path) {
        return Response.json({ error: 'Path is required' }, { status: 400 })
      }
      try {
        const content = await fileHandler.readFile(path, format)
        if (format === 'blob') {
          return new Response(content as Blob)
        }
        return new Response(content as string, {
          headers: { 'Content-Type': 'text/plain' },
        })
      } catch (error) {
        return Response.json({ error: String(error) }, { status: 404 })
      }
    }

    // DELETE /files/remove - Remove file/directory
    if (url.pathname === '/files/remove' && req.method === 'DELETE') {
      const path = url.searchParams.get('path')
      if (!path) {
        return Response.json({ error: 'Path is required' }, { status: 400 })
      }
      try {
        await fileHandler.removeFile(path)
        return Response.json({ success: true })
      } catch (error) {
        return Response.json({ error: String(error) }, { status: 500 })
      }
    }

    // GET /files/list - List directory contents
    if (url.pathname === '/files/list' && req.method === 'GET') {
      const path = url.searchParams.get('path') || '.'
      try {
        const entries = await fileHandler.listFiles(path)
        return Response.json({ entries })
      } catch (error) {
        return Response.json({ error: String(error) }, { status: 500 })
      }
    }

    // POST /files/mkdir - Create directory
    if (url.pathname === '/files/mkdir' && req.method === 'POST') {
      const path = url.searchParams.get('path')
      if (!path) {
        return Response.json({ error: 'Path is required' }, { status: 400 })
      }
      try {
        await fileHandler.makeDir(path)
        return Response.json({ success: true })
      } catch (error) {
        return Response.json({ error: String(error) }, { status: 500 })
      }
    }

    // GET /files/exists - Check if file/directory exists
    if (url.pathname === '/files/exists' && req.method === 'GET') {
      const path = url.searchParams.get('path')
      if (!path) {
        return Response.json({ error: 'Path is required' }, { status: 400 })
      }
      try {
        const exists = await fileHandler.exists(path)
        return Response.json({ exists })
      } catch (error) {
        return Response.json({ error: String(error) }, { status: 500 })
      }
    }

    // WebSocket endpoint
    if (url.pathname === '/ws') {
      if (server.upgrade(req)) return
    }

    return new Response('Not Found', { status: 404 })
  },

  websocket: {
    open(ws) {
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

    async message(ws, message) {
      await handleMessage(ws, message, {
        messageQueue,
        getActiveStream: () => activeStream,
      })
    },

    close(ws) {
      if (activeConnection === ws) {
        activeConnection = null
      }
    },
  },
})

console.log(`🚀 WebSocket server running on http://localhost:${server.port}`)
console.log(`   Config endpoint: http://localhost:${server.port}/config`)
console.log(`   WebSocket endpoint: ws://localhost:${server.port}/ws`)
