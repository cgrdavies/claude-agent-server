#!/usr/bin/env bun
/**
 * Standalone Claude Agent Client - no dependencies required
 * Usage: bun run https://raw.githubusercontent.com/cgrdavies/claude-agent-server/main/standalone-client.ts
 */
import * as readline from 'readline'

const SERVER_URL = process.env.CLAUDE_SERVER_URL || 'https://agents.yeeted.lol'
const SYSTEM_PROMPT = process.env.SYSTEM_PROMPT || 'You are a helpful assistant.'

const rl = readline.createInterface({
  input: process.stdin,
  output: process.stdout,
})

let ws: WebSocket | null = null
let sessionId = crypto.randomUUID()

async function connect(): Promise<WebSocket> {
  // Configure server
  await fetch(`${SERVER_URL}/config`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ systemPrompt: SYSTEM_PROMPT }),
  })

  const wsUrl = `${SERVER_URL.replace('http', 'ws')}/ws`

  return new Promise((resolve, reject) => {
    const socket = new WebSocket(wsUrl)

    socket.onopen = () => resolve(socket)
    socket.onerror = (e) => reject(e)

    socket.onmessage = (event) => {
      const msg = JSON.parse(event.data)

      if (msg.type === 'sdk_message') {
        const data = msg.data
        if (data.type === 'assistant') {
          const text = data.message.content
            .map((b: any) => b.type === 'text' ? b.text : `[${b.type}]`)
            .join('')
          console.log(`\n\x1b[34mClaude:\x1b[0m ${text}`)
        } else if (data.type === 'result') {
          console.log(`\x1b[90m(${data.duration_ms}ms, $${data.total_cost_usd?.toFixed(4) || '0'})\x1b[0m\n`)
          prompt()
        }
      } else if (msg.type === 'error') {
        console.error(`\x1b[31mError: ${msg.error}\x1b[0m`)
        prompt()
      }
    }
  })
}

function send(message: string) {
  if (!ws || ws.readyState !== WebSocket.OPEN) {
    throw new Error('Not connected')
  }
  ws.send(JSON.stringify({
    type: 'user_message',
    data: {
      type: 'user',
      message: { role: 'user', content: message },
      parent_tool_use_id: null,
      session_id: sessionId,
    },
  }))
}

function prompt() {
  rl.question('\x1b[32mYou:\x1b[0m ', async (input) => {
    const trimmed = input.trim()
    if (!trimmed) { prompt(); return }
    if (trimmed === '/quit') { process.exit(0) }
    if (trimmed === '/new') { sessionId = crypto.randomUUID(); console.log('New session\n'); prompt(); return }

    try {
      send(trimmed)
    } catch {
      console.log('\x1b[33mReconnecting...\x1b[0m')
      ws = await connect()
      send(trimmed)
    }
  })
}

async function main() {
  console.log(`\x1b[36mConnecting to ${SERVER_URL}...\x1b[0m`)
  ws = await connect()
  console.log('\x1b[32mConnected!\x1b[0m Type /quit to exit, /new for new session\n')
  prompt()
}

main().catch(console.error)
