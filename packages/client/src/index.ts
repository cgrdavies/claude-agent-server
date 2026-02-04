import type {
  ClientOptions,
  DocumentInfo,
  WSInputMessage,
  WSOutputMessage,
} from './types'

// Re-export types for convenience
export type { ClientOptions, DocumentInfo, WSInputMessage, WSOutputMessage }
export type { QueryConfig, McpRemoteServerConfig } from './types'

export class ClaudeAgentClient {
  private ws?: WebSocket
  private options: ClientOptions
  private messageHandlers: ((message: WSOutputMessage) => void)[] = []
  private baseUrl: string

  constructor(options: ClientOptions) {
    this.options = options
    // Normalize URL (remove trailing slash)
    this.baseUrl = options.connectionUrl.replace(/\/$/, '')
  }

  async start() {
    const anthropicApiKey =
      this.options.anthropicApiKey || process.env.ANTHROPIC_API_KEY

    const configUrl = `${this.baseUrl}/config`
    const wsProtocol = this.baseUrl.startsWith('https') ? 'wss' : 'ws'
    const wsUrl = `${wsProtocol}://${new URL(this.baseUrl).host}/ws`

    if (this.options.debug) {
      console.log(`Configuring server at ${configUrl}...`)
    }

    const configBody: Record<string, unknown> = { ...this.options }
    delete configBody.connectionUrl
    delete configBody.debug
    if (anthropicApiKey) {
      configBody.anthropicApiKey = anthropicApiKey
    }

    const configResponse = await fetch(configUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(configBody),
    })

    if (!configResponse.ok) {
      const error = await configResponse.text()
      throw new Error(`Failed to configure server: ${error}`)
    }

    if (this.options.debug) {
      console.log('Connecting to WebSocket...')
    }

    return this.connectWebSocket(wsUrl)
  }

  private connectWebSocket(wsUrl: string): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      this.ws = new WebSocket(wsUrl)

      this.ws.onopen = () => {
        if (this.options.debug) console.log('Connected to Claude Agent SDK')
        resolve()
      }

      this.ws.onmessage = event => {
        try {
          const message = JSON.parse(event.data.toString()) as WSOutputMessage
          this.handleMessage(message)
        } catch (error) {
          console.error('Failed to parse message:', error)
        }
      }

      this.ws.onerror = error => {
        console.error('WebSocket error:', error)
        reject(error)
      }

      this.ws.onclose = () => {
        if (this.options.debug) console.log('Disconnected')
      }
    })
  }

  private handleMessage(message: WSOutputMessage) {
    if (this.options.debug) {
      console.log('Received message:', JSON.stringify(message, null, 2))
    }
    this.messageHandlers.forEach(handler => handler(message))
  }

  onMessage(handler: (message: WSOutputMessage) => void) {
    this.messageHandlers.push(handler)
    return () => {
      this.messageHandlers = this.messageHandlers.filter(h => h !== handler)
    }
  }

  send(message: WSInputMessage) {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      throw new Error('WebSocket is not connected')
    }
    this.ws.send(JSON.stringify(message))
  }

  // Document operations via REST API
  async createDocument(name: string, content?: string): Promise<{ id: string; name: string }> {
    const url = `${this.baseUrl}/docs`
    const response = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name, content }),
    })
    if (!response.ok) {
      throw new Error(`Failed to create document: ${await response.text()}`)
    }
    return response.json() as Promise<{ id: string; name: string }>
  }

  async readDocument(id: string): Promise<{ id: string; name: string; content: string }> {
    const url = `${this.baseUrl}/docs/${encodeURIComponent(id)}`
    const response = await fetch(url)
    if (!response.ok) {
      throw new Error(`Failed to read document: ${await response.text()}`)
    }
    return response.json() as Promise<{ id: string; name: string; content: string }>
  }

  async listDocuments(): Promise<DocumentInfo[]> {
    const url = `${this.baseUrl}/docs`
    const response = await fetch(url)
    if (!response.ok) {
      throw new Error(`Failed to list documents: ${await response.text()}`)
    }
    const data = (await response.json()) as { documents: DocumentInfo[] }
    return data.documents
  }

  async deleteDocument(id: string): Promise<void> {
    const url = `${this.baseUrl}/docs/${encodeURIComponent(id)}`
    const response = await fetch(url, { method: 'DELETE' })
    if (!response.ok) {
      throw new Error(`Failed to delete document: ${await response.text()}`)
    }
  }

  // Session history via REST API
  async listSessions(): Promise<string[]> {
    const url = `${this.baseUrl}/sessions`
    const response = await fetch(url)
    if (!response.ok) {
      throw new Error(`Failed to list sessions: ${await response.text()}`)
    }
    const data = (await response.json()) as { sessions: string[] }
    return data.sessions
  }

  async getSessionHistory(sessionId: string): Promise<unknown[]> {
    const url = `${this.baseUrl}/sessions/${encodeURIComponent(sessionId)}`
    const response = await fetch(url)
    if (!response.ok) {
      throw new Error(`Failed to get session history: ${await response.text()}`)
    }
    const data = (await response.json()) as { sessionId: string; messages: unknown[] }
    return data.messages
  }

  async stop() {
    if (this.ws) {
      this.ws.close()
    }
  }
}
