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
    connectionUrl: 'http://localhost:4000',
    debug: true,
  })

  try {
    await client.start()

    console.log('✅ Client started\n')

    // Create an input document for Claude to work with
    console.log('🗂️  Creating input document...')
    const doc = await client.createDocument(
      'input',
      'Hello! This is a test document created by the user.',
    )
    console.log(`✅ Document created: ${doc.id}`)

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
              `Please read document "${doc.id}", reverse its content, and save it to a new document named "output".`,
          },
        },
      },
    ] as const

    // Cleanup function
    const stopAndExit = async () => {
      console.log('\n✅ Received result message, stopping...')

      // List all documents
      const documents = await client.listDocuments()
      console.log('\n📄 Documents:')
      for (const d of documents) {
        try {
          const full = await client.readDocument(d.id)
          console.log(`\n  ${d.name} (${d.id}):`)
          console.log('  ' + '─'.repeat(50))
          console.log(
            full.content
              .split('\n')
              .map(line => `  ${line}`)
              .join('\n'),
          )
          console.log('  ' + '─'.repeat(50))
        } catch (error) {
          console.log(`  - ${d.name} (could not read: ${error})`)
        }
      }

      console.log('\n👋 Closing connection...')
      await client.stop()
      console.log('✅ Done')
      process.exit(0)
    }

    // Register message handler
    client.onMessage(async message => {
      switch (message.type) {
        case 'connected':
          console.log('🔗 Connection confirmed')
          break

        case 'error':
          console.error('❌ Error:', message.error)
          break

        case 'sdk_message':
          console.log('🤖 SDK Message:', JSON.stringify(message.data, null, 2))

          // Stop when we receive a "result" type message
          if (message.data.type === 'result') {
            await stopAndExit()
          }
          break

        default:
          console.log('📨 Unknown message type:', (message as any).type)
      }
    })

    // Send commands
    for (const command of commands) {
      console.log(`\n📤 Sending command: ${command.type}`)
      client.send(command)
      await new Promise(resolve => setTimeout(resolve, 2000))
    }

    // Keep watching
    console.log(
      '\n👀 Waiting for result... (will stop when result is received)',
    )
  } catch (error) {
    console.error('❌ Error:', error)
    await client.stop()
    process.exit(1)
  }
}

main()
