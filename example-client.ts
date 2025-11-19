/**
 * Example WebSocket client for the Claude Agent SDK server
 *
 * Usage: bun example-client.ts
 */

const ws = new WebSocket('ws://localhost:3000/ws')

ws.onopen = async () => {
  console.log('✅ Connected to Claude Agent SDK')

  const commands = [
    {
      type: 'create_file',
      path: 'test_binary.bin',
      content: Buffer.from('Binary Content').toString('base64'),
      encoding: 'base64',
    },
    {
      type: 'create_file',
      path: 'test_text.txt',
      content: 'Plain Text Content',
      encoding: 'utf-8',
    },
    {
      type: 'list_files',
    },
    {
      type: 'read_file',
      path: 'test_binary.bin',
      encoding: 'base64',
    },
    {
      type: 'read_file',
      path: 'test_text.txt',
      encoding: 'utf-8',
    },
    {
      type: 'delete_file',
      path: 'test_binary.bin',
    },
    {
      type: 'delete_file',
      path: 'test_text.txt',
    },
    {
      type: 'list_files',
    },
  ]

  for (const command of commands) {
    console.log(`\n📤 Sending command: ${command.type}`)
    ws.send(JSON.stringify(command))

    // Wait for response
    await new Promise(resolve => setTimeout(resolve, 1000))
  }

  // Disconnect
  setTimeout(() => {
    console.log('\n👋 Closing connection...')
    ws.close()
  }, 1000)
}

ws.onmessage = event => {
  try {
    const message = JSON.parse(event.data.toString())

    switch (message.type) {
      case 'connected':
        console.log('🔗 Connection confirmed')
        break

      case 'file_result':
        console.log(
          '📄 File Operation Result:',
          JSON.stringify(message, null, 2),
        )
        break

      case 'error':
        console.error('❌ Error:', message.error)
        break

      default:
        console.log('📨 Unknown message type:', message.type)
    }
  } catch (error) {
    console.error('❌ Failed to parse message:', error)
  }
}

ws.onerror = error => {
  console.error('❌ WebSocket error:', error)
}

ws.onclose = () => {
  console.log('\n👋 Disconnected from server')
  process.exit(0)
}
