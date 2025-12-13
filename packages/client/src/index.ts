import type {
  ClientOptions,
  EntryInfo,
  WSInputMessage,
  WSOutputMessage,
} from './types'

// Re-export types for convenience
export type { ClientOptions, EntryInfo, WSInputMessage, WSOutputMessage }
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

  // File operations via REST API
  async writeFile(path: string, content: string | Blob) {
    const url = `${this.baseUrl}/files/write?path=${encodeURIComponent(path)}`
    const response = await fetch(url, {
      method: 'POST',
      headers:
        content instanceof Blob ? {} : { 'Content-Type': 'application/json' },
      body: content instanceof Blob ? content : JSON.stringify({ content }),
    })
    if (!response.ok) {
      throw new Error(`Failed to write file: ${await response.text()}`)
    }
  }

  async readFile(path: string, format: 'text' | 'blob' = 'text'): Promise<string | Blob> {
    const url = `${this.baseUrl}/files/read?path=${encodeURIComponent(path)}&format=${format}`
    const response = await fetch(url)
    if (!response.ok) {
      throw new Error(`Failed to read file: ${await response.text()}`)
    }
    if (format === 'blob') {
      return response.blob()
    }
    return response.text()
  }

  async removeFile(path: string) {
    const url = `${this.baseUrl}/files/remove?path=${encodeURIComponent(path)}`
    const response = await fetch(url, { method: 'DELETE' })
    if (!response.ok) {
      throw new Error(`Failed to remove file: ${await response.text()}`)
    }
  }

  async listFiles(path = '.'): Promise<EntryInfo[]> {
    const url = `${this.baseUrl}/files/list?path=${encodeURIComponent(path)}`
    const response = await fetch(url)
    if (!response.ok) {
      throw new Error(`Failed to list files: ${await response.text()}`)
    }
    const data = (await response.json()) as { entries: EntryInfo[] }
    return data.entries
  }

  async mkdir(path: string) {
    const url = `${this.baseUrl}/files/mkdir?path=${encodeURIComponent(path)}`
    const response = await fetch(url, { method: 'POST' })
    if (!response.ok) {
      throw new Error(`Failed to create directory: ${await response.text()}`)
    }
  }

  async exists(path: string): Promise<boolean> {
    const url = `${this.baseUrl}/files/exists?path=${encodeURIComponent(path)}`
    const response = await fetch(url)
    if (!response.ok) {
      throw new Error(`Failed to check existence: ${await response.text()}`)
    }
    const data = (await response.json()) as { exists: boolean }
    return data.exists
  }

  async stop() {
    if (this.ws) {
      this.ws.close()
    }
  }
}
