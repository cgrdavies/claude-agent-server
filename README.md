# Claude Agent SDK WebSocket Server

A WebSocket server that wraps the Claude Agent SDK, allowing real-time bidirectional communication with Claude through WebSockets. Deploy it via Docker/Dokploy and connect via the TypeScript client library.

## Overview

**Typical Workflow:**

1. **Deploy with Docker** - Build and run the server as a Docker container
2. **Use the Client Library** - Install `@dzhng/claude-agent` in your project and connect to your server
3. **Modify the Server (Optional)** - If you need custom behavior, edit the server code in `packages/server/`

## Quick Start

### 1. Setup Environment

Install dependencies:

```bash
bun install
```

### 2. Deploy with Docker

#### Option A: Docker Compose (Recommended)

This automatically mounts your `~/.claude` directory for Claude Max authentication:

```bash
docker compose up
```

#### Option B: Docker Build & Run

```bash
# Build the image
bun run docker:build

# Run with Claude config mounted
bun run docker:run
```

#### Option C: Local Development

Start the server locally:

```bash
bun run start:server
```

### 3. Use the Client Library

Install the client library in your project:

```bash
npm install @dzhng/claude-agent
# or
bun add @dzhng/claude-agent
```

Connect to your server:

```typescript
import { ClaudeAgentClient } from '@dzhng/claude-agent'

const client = new ClaudeAgentClient({
  connectionUrl: 'https://your-server.dokploy.com', // or 'http://localhost:4000'
  debug: true,
})

// Start the client
await client.start()

// Listen for messages from Claude
client.onMessage(message => {
  if (message.type === 'sdk_message') {
    console.log('Claude:', message.data)
  }
})

// Send a message to Claude
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

## Docker Deployment

### Dokploy

1. Connect your Git repository to Dokploy
2. Configure environment:
   - Add volume mount: `~/.claude:/home/user/.claude:ro` for Claude Max authentication
   - Exposed port: 4000
3. Traefik handles TLS termination automatically

### Claude Max Authentication

The server uses your Claude Max subscription via the `~/.claude` directory. Mount it as a read-only volume:

```bash
docker run -p 4000:4000 -v ~/.claude:/home/user/.claude:ro claude-agent-server
```

Or with docker-compose (already configured in `docker-compose.yml`).

## Available Scripts

### `bun run start:server`

Starts the server locally on `http://localhost:4000`. Use this for local development and testing.

### `bun run docker:build`

Builds the Docker image.

### `bun run docker:run`

Runs the Docker container with Claude config mounted.

### `bun run docker:compose`

Runs the server via Docker Compose.

### `bun run test:client`

Runs the example client for testing.

## Client Library API

### Installation

```bash
npm install @dzhng/claude-agent
# or
bun add @dzhng/claude-agent
```

### Constructor Options

```typescript
interface ClientOptions {
  // Required
  connectionUrl: string // Server URL (e.g., 'https://your-server.dokploy.com')

  // Optional - passed to server for API calls
  anthropicApiKey?: string

  // Other Options
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

### Methods

- **`async start()`** - Initialize the client and connect to the server
- **`send(message: WSInputMessage)`** - Send a message to the agent
- **`onMessage(handler: (message: WSOutputMessage) => void)`** - Register a message handler (returns unsubscribe function)
- **`async stop()`** - Disconnect and clean up resources

### File Operations

The client provides file operations via REST API:

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

### Example Usage

```typescript
import { ClaudeAgentClient } from '@dzhng/claude-agent'

const client = new ClaudeAgentClient({
  connectionUrl: 'http://localhost:4000',
  debug: true,
})

await client.start()

client.onMessage(message => {
  if (message.type === 'sdk_message') {
    console.log('Claude:', message.data)
  }
})

client.send({
  type: 'user_message',
  data: {
    type: 'user',
    session_id: 'session-1',
    message: { role: 'user', content: 'Hello' },
  },
})

await client.stop()
```

## Server API Reference

The server runs on port 4000 with:

- Health endpoint: `GET /health`
- Config endpoint: `POST/GET /config`
- WebSocket endpoint: `ws://localhost:4000/ws`
- File operations: `/files/*`

### Health Check

```bash
curl http://localhost:4000/health
```

### Configuration API

#### POST /config

Set the configuration for the Claude Agent SDK query:

```bash
curl -X POST http://localhost:4000/config \
  -H "Content-Type: application/json" \
  -d '{
    "systemPrompt": "You are a helpful assistant.",
    "allowedTools": ["read_file", "write_file"],
    "model": "claude-sonnet-4-20250514"
  }'
```

### File Operations API

| Endpoint | Method | Description |
|----------|--------|-------------|
| `/files/write?path=<path>` | POST | Write file content |
| `/files/read?path=<path>&format=text\|blob` | GET | Read file content |
| `/files/remove?path=<path>` | DELETE | Remove file or directory |
| `/files/list?path=<path>` | GET | List directory contents |
| `/files/mkdir?path=<path>` | POST | Create directory |
| `/files/exists?path=<path>` | GET | Check if path exists |

### WebSocket API

Connect to the WebSocket endpoint:

```javascript
const ws = new WebSocket('ws://localhost:4000/ws')
```

**Note:** The server only accepts **one active connection at a time**.

#### Message Format

**Sending Messages (Client → Server)**

```typescript
type WSInputMessage =
  | { type: 'user_message'; data: SDKUserMessage }
  | { type: 'interrupt' }
```

**Receiving Messages (Server → Client)**

```typescript
type WSOutputMessage =
  | { type: 'connected' }
  | { type: 'sdk_message'; data: SDKMessage }
  | { type: 'error'; error: string }
  | { type: 'info'; data: string }
```

## Architecture

The server is a simple **1-to-1 relay** between a single WebSocket client and the Claude Agent SDK:

1. **Configuration** (optional): Client can POST to `/config` to set agents, allowedTools, and systemPrompt
2. **Client Connects**: A WebSocket connection is established (only one allowed at a time)
3. **Client Sends Message**: Client sends a user message (or interrupt)
4. **Message Queuing**: Server adds messages to the queue and processes them with the SDK
5. **SDK Processing**: The SDK query stream processes messages using the configured options
6. **Response Relay**: SDK responses are immediately sent back to the connected WebSocket client
7. **Cleanup**: When the client disconnects, the server is ready to accept a new connection

## Project Structure

```
claude-agent-server/
├── packages/
│   ├── server/           # Main server implementation
│   │   ├── index.ts
│   │   ├── message-handler.ts
│   │   ├── file-handler.ts
│   │   └── ...
│   └── client/           # Client library
│       └── src/
├── Dockerfile
├── docker-compose.yml
├── package.json
└── README.md
```

## License

MIT
