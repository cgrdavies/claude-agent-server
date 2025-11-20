# @claude-agent/client

A TypeScript client library for connecting to Claude Agent Server with E2B sandbox support.

## Installation

```bash
npm install @dzhng/claude-agent
# or
yarn add @dzhng/claude-agent
# or
bun add @dzhng/claude-agent
```

## Usage

### Basic Example

```typescript
import { ClaudeAgentClient } from '@dzhng/claude-agent'

const client = new ClaudeAgentClient({
  e2bApiKey: process.env.E2B_API_KEY,
  anthropicApiKey: process.env.ANTHROPIC_API_KEY,
  debug: true,
})

// Start the client (creates E2B sandbox and connects)
await client.start()

// Listen for messages from the agent
client.onMessage(message => {
  console.log('Received:', message)
})

// Send a message to the agent
client.send({
  type: 'user_message',
  data: { content: 'Hello, Claude!' },
})

// Clean up when done
await client.stop()
```

### Use a Custom E2B Template

```typescript
const client = new ClaudeAgentClient({
  template: 'my-custom-template', // Your custom E2B template name
  e2bApiKey: process.env.E2B_API_KEY,
  anthropicApiKey: process.env.ANTHROPIC_API_KEY,
})

await client.start()
```

## API Reference

### `ClaudeAgentClient`

#### Constructor Options

```typescript
interface ClientOptions {
  // Required (unless using environment variables)
  anthropicApiKey?: string
  e2bApiKey?: string

  // Configuration
  template?: string // E2B template name, defaults to 'claude-agent-server'
  timeoutMs?: number // Sandbox timeout, defaults to 5 minutes
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
- **`async writeFile(path, content)`** - Write a file (string or Blob) to the sandbox
- **`async readFile(path, format)`** - Read a file as 'text' or 'blob'
- **`async removeFile(path)`** - Delete a file or directory
- **`async listFiles(path?)`** - List directory contents
- **`async stop()`** - Disconnect and clean up resources

## Message Types

```typescript
import type {
  AgentDefinition,
  SDKMessage,
  SDKUserMessage,
} from '@anthropic-ai/claude-agent-sdk'

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

- `E2B_API_KEY` - Your E2B API key (required)
- `ANTHROPIC_API_KEY` - Your Anthropic API key (required)

## License

MIT
