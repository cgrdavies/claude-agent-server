#!/usr/bin/env bun
import * as readline from 'readline'
import { ClaudeAgentClient } from './packages/client/src/index'

const SERVER_URL = process.env.CLAUDE_SERVER_URL || 'https://agents.yeeted.lol'

const rl = readline.createInterface({
  input: process.stdin,
  output: process.stdout,
})

let client: ClaudeAgentClient
let sessionId = crypto.randomUUID()
let isWaiting = false

async function main() {
  console.log(`\x1b[36mConnecting to ${SERVER_URL}...\x1b[0m`)

  client = new ClaudeAgentClient({
    connectionUrl: SERVER_URL,
    systemPrompt: process.env.SYSTEM_PROMPT || 'You are a helpful assistant.',
  })

  client.onMessage((message) => {
    if (message.type === 'connected') {
      console.log('\x1b[32mConnected!\x1b[0m\n')
      prompt()
    } else if (message.type === 'sdk_message') {
      const msg = message.data
      if (msg.type === 'assistant') {
        const text = msg.message.content
          .map((b: any) => {
            if (b.type === 'text') return b.text
            if (b.type === 'tool_use') return `\x1b[33m[Tool: ${b.name}]\x1b[0m`
            return `[${b.type}]`
          })
          .join('')
        console.log(`\n\x1b[34mClaude:\x1b[0m ${text}`)
      } else if (msg.type === 'result') {
        isWaiting = false
        console.log(`\x1b[90m(${msg.duration_ms}ms, $${msg.total_cost_usd?.toFixed(4) || '0'})\x1b[0m\n`)
        prompt()
      }
    } else if (message.type === 'error') {
      console.error(`\x1b[31mError: ${message.error}\x1b[0m`)
      isWaiting = false
      prompt()
    } else if (message.type === 'info') {
      // Skip info messages for cleaner output
    }
  })

  try {
    await client.start()
  } catch (err) {
    console.error('\x1b[31mFailed to connect:\x1b[0m', err)
    process.exit(1)
  }
}

function prompt() {
  rl.question('\x1b[32mYou:\x1b[0m ', async (input) => {
    const trimmed = input.trim()

    if (!trimmed) {
      prompt()
      return
    }

    if (trimmed === '/quit' || trimmed === '/exit') {
      console.log('Goodbye!')
      await client.stop()
      rl.close()
      process.exit(0)
    }

    if (trimmed === '/new') {
      sessionId = crypto.randomUUID()
      console.log('\x1b[33mStarted new session\x1b[0m\n')
      prompt()
      return
    }

    if (trimmed === '/help') {
      console.log(`
Commands:
  /new   - Start a new session
  /quit  - Exit
  /help  - Show this help
`)
      prompt()
      return
    }

    isWaiting = true
    client.send({
      type: 'user_message',
      data: {
        type: 'user',
        message: { role: 'user', content: trimmed },
        parent_tool_use_id: null,
        session_id: sessionId,
      },
    })
  })
}

// Handle Ctrl+C
rl.on('close', () => {
  console.log('\nGoodbye!')
  process.exit(0)
})

main().catch(console.error)
