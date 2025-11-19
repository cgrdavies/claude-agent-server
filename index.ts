import { readdir, readFile, unlink, writeFile } from 'fs/promises'
import { homedir } from 'os'
import { join } from 'path'
import {
  query,
  type AgentDefinition,
  type Options,
  type SDKMessage,
  type SDKUserMessage,
} from '@anthropic-ai/claude-agent-sdk'
import { type ServerWebSocket } from 'bun'

// WebSocket message types
export type WSInputMessage =
  | {
      type: 'user_message'
      data: SDKUserMessage
    }
  | { type: 'interrupt' }
  | {
      type: 'create_file'
      path: string
      content: string
      encoding?: 'utf-8' | 'base64'
    }
  | { type: 'read_file'; path: string; encoding?: 'utf-8' | 'base64' }
  | { type: 'delete_file'; path: string }
  | { type: 'list_files'; path?: string }

export type WSOutputMessage =
  | { type: 'connected' }
  | { type: 'sdk_message'; data: SDKMessage }
  | { type: 'error'; error: string }
  | {
      type: 'file_result'
      operation: 'create_file' | 'delete_file'
      result: 'success'
    }
  | {
      type: 'file_result'
      operation: 'read_file'
      result: string
      encoding: 'utf-8' | 'base64'
    }
  | { type: 'file_result'; operation: 'list_files'; result: string[] }

// Configuration type for the query options
export type QueryConfig = {
  agents?: Record<string, AgentDefinition>
  allowedTools?: string[]
  systemPrompt?:
    | string
    | {
        type: 'preset'
        preset: 'claude_code'
        append?: string
      }
}

const workspaceDirectory = join(homedir(), 'agent-workspace')

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
      ...queryConfig,
    }

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
  port: 3000,
  fetch(req, server) {
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
      const input = JSON.parse(message.toString()) as WSInputMessage
      if (input.type === 'user_message') {
        messageQueue.push(input.data)
      } else if (input.type === 'interrupt') {
        activeStream?.interrupt()
      } else if (input.type === 'create_file') {
        const targetPath = join(workspaceDirectory, input.path)
        const encoding = input.encoding || 'utf-8'
        const content =
          encoding === 'base64'
            ? Buffer.from(input.content, 'base64')
            : input.content

        writeFile(targetPath, content)
          .then(() => {
            ws.send(
              JSON.stringify({
                type: 'file_result',
                operation: 'create_file',
                result: 'success',
              }),
            )
          })
          .catch(err => {
            ws.send(
              JSON.stringify({
                type: 'error',
                error: `Failed to create file: ${err.message}`,
              }),
            )
          })
      } else if (input.type === 'read_file') {
        const targetPath = join(workspaceDirectory, input.path)
        const encoding = input.encoding || 'utf-8'

        readFile(targetPath, encoding === 'base64' ? 'base64' : 'utf-8')
          .then(content => {
            ws.send(
              JSON.stringify({
                type: 'file_result',
                operation: 'read_file',
                result: content,
                encoding,
              }),
            )
          })
          .catch(err => {
            ws.send(
              JSON.stringify({
                type: 'error',
                error: `Failed to read file: ${err.message}`,
              }),
            )
          })
      } else if (input.type === 'delete_file') {
        const targetPath = join(workspaceDirectory, input.path)
        unlink(targetPath)
          .then(() => {
            ws.send(
              JSON.stringify({
                type: 'file_result',
                operation: 'delete_file',
                result: 'success',
              }),
            )
          })
          .catch(err => {
            ws.send(
              JSON.stringify({
                type: 'error',
                error: `Failed to delete file: ${err.message}`,
              }),
            )
          })
      } else if (input.type === 'list_files') {
        const targetPath = input.path
          ? join(workspaceDirectory, input.path)
          : workspaceDirectory
        readdir(targetPath)
          .then(files => {
            ws.send(
              JSON.stringify({
                type: 'file_result',
                operation: 'list_files',
                result: files,
              }),
            )
          })
          .catch(err => {
            ws.send(
              JSON.stringify({
                type: 'error',
                error: `Failed to list files: ${err.message}`,
              }),
            )
          })
      }
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
