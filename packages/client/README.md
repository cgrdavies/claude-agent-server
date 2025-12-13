# @dzhng/claude-agent

A TypeScript client library for connecting to Claude Agent Server.

## Installation

```bash
npm install @dzhng/claude-agent
# or
bun add @dzhng/claude-agent
```

## Usage

### Basic Example

```typescript
import { ClaudeAgentClient } from '@dzhng/claude-agent'

const client = new ClaudeAgentClient({
  connectionUrl: 'http://localhost:4000', // or your deployed server URL
  debug: true,
})

// Start the client
await client.start()

// Listen for messages from the agent
client.onMessage(message => {
  if (message.type === 'sdk_message') {
    console.log('Claude:', message.data)
  }
})

// Send a message to the agent
client.send({
  type: 'user_message',
  data: {
    type: 'user',
    session_id: 'my-session',
    message: {
      role: 'user',
      content: 'Hello, Claude!',
    },
  },
})

// Clean up when done
await client.stop()
```

### File Operations

```typescript
// Write a file
await client.writeFile('test.txt', 'Hello, world!')

// Read a file
const content = await client.readFile('test.txt')

// List files
const files = await client.listFiles('.')

// Check if file exists
const exists = await client.exists('test.txt')

// Create directory
await client.mkdir('my-folder')

// Remove file
await client.removeFile('test.txt')
```

## API Reference

### `ClaudeAgentClient`

#### Constructor Options

```typescript
interface ClientOptions {
  // Required
  connectionUrl: string // Server URL (e.g., 'https://your-server.dokploy.com')

  // Optional
  anthropicApiKey?: string // Passed to server for API calls
  debug?: boolean // Enable debug logging

  // Query Configuration (passed to server)
  agents?: Record<string, AgentDefinition>
  allowedTools?: string[]
  systemPrompt?:
    | string
    | { type: 'preset'; preset: 'claude_code'; append?: string }
  model?: string
}
```

#### Methods

- **`async start()`** - Initialize the client and connect to the server
- **`send(message: WSInputMessage)`** - Send a message to the agent
- **`onMessage(handler: (message: WSOutputMessage) => void)`** - Register a message handler (returns unsubscribe function)
- **`async writeFile(path, content)`** - Write a file (string or Blob)
- **`async readFile(path, format)`** - Read a file as 'text' or 'blob'
- **`async removeFile(path)`** - Delete a file or directory
- **`async listFiles(path?)`** - List directory contents
- **`async mkdir(path)`** - Create a directory
- **`async exists(path)`** - Check if file/directory exists
- **`async stop()`** - Disconnect and clean up resources

## Message Types

```typescript
// Input messages you can send
type WSInputMessage =
  | { type: 'user_message'; data: SDKUserMessage }
  | { type: 'interrupt' }

// Output messages you'll receive
type WSOutputMessage =
  | { type: 'connected' }
  | { type: 'sdk_message'; data: SDKMessage }
  | { type: 'error'; error: string }
  | { type: 'info'; data: string }
```

## Environment Variables

- `CONNECTION_URL` - Server URL (optional, can be passed in constructor)
- `ANTHROPIC_API_KEY` - Your Anthropic API key (optional if using Claude Max)

## License

MIT
