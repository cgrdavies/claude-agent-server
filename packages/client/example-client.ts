/**
 * Example WebSocket client for the Claude Agent SDK server
 *
 * Usage: bun example-client.ts
 */

import { ClaudeAgentClient } from './src/index'

if (!process.env.E2B_API_KEY) {
  console.error('❌ E2B_API_KEY environment variable is required')
  process.exit(1)
}

if (!process.env.ANTHROPIC_API_KEY) {
  console.error('❌ ANTHROPIC_API_KEY environment variable is required')
  process.exit(1)
}

async function main() {
  const client = new ClaudeAgentClient({
    debug: true,
  })

  try {
    await client.start()

    console.log('🗂️  Writing input.txt...')
    await client.writeFile(
      'input.txt',
      'Hello! This is a test file created by the user.',
    )
    console.log('✅ File written')

    const commands = [
      {
        type: 'user_message',
        data: {
          type: 'user',
          session_id: 'example-session',
          parent_tool_use_id: null,
          message: {
            role: 'user',
            content:
              'Please read "input.txt", reverse its content, and save it to a new file named "output.txt".',
          },
        },
      },
    ] as const

    // Register message handler
    client.onMessage(message => {
      switch (message.type) {
        case 'connected':
          console.log('🔗 Connection confirmed')
          break

        case 'error':
          console.error('❌ Error:', message.error)
          break

        case 'sdk_message':
          console.log('🤖 SDK Message:', JSON.stringify(message.data, null, 2))
          break

        default:
          console.log('📨 Unknown message type:', (message as any).type)
      }
    })

    // Send commands
    for (const command of commands) {
      console.log(`\n📤 Sending command: ${command.type}`)
      client.send(command)

      // Wait for response
      await new Promise(resolve => setTimeout(resolve, 2000))
    }

    // Disconnect
    setTimeout(async () => {
      console.log('\n👋 Closing connection...')
      await client.stop()
      console.log('✅ Sandbox terminated')
      process.exit(0)
    }, 1000)
  } catch (error) {
    console.error('❌ Error:', error)
    await client.stop()
    process.exit(1)
  }
}

main()
