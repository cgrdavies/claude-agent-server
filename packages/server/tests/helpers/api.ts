/**
 * API request helpers for tests.
 *
 * Makes HTTP requests to the Hono app directly (no server startup needed).
 * Handles auth headers, workspace context, and response parsing.
 */

// Import the app after environment is set up
// This must be a dynamic import to ensure env vars are set first
let _app: { fetch: (request: Request) => Response | Promise<Response> } | null = null

async function getApp() {
  if (!_app) {
    // Dynamic import to ensure env is set up first
    const { app } = await import('../../index')
    _app = app
  }
  return _app!
}

export interface ApiResponse<T = unknown> {
  status: number
  headers: Headers
  data: T
  raw: Response
}

export interface RequestOptions {
  token?: string
  workspaceId?: string
  body?: unknown
  headers?: Record<string, string>
}

/**
 * Make a request to the API.
 * Automatically handles JSON serialization and auth headers.
 */
export async function apiRequest<T = unknown>(
  method: string,
  path: string,
  options: RequestOptions = {}
): Promise<ApiResponse<T>> {
  const app = await getApp()

  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    ...options.headers,
  }

  if (options.token) {
    headers['Authorization'] = `Bearer ${options.token}`
  }

  if (options.workspaceId) {
    headers['X-Workspace-Id'] = options.workspaceId
  }

  // For POST/PATCH/PUT, send empty object if no body provided
  const needsBody = ['POST', 'PATCH', 'PUT'].includes(method.toUpperCase())
  const body = options.body !== undefined
    ? JSON.stringify(options.body)
    : needsBody
      ? '{}'
      : undefined

  const request = new Request(`http://localhost${path}`, {
    method,
    headers,
    body,
  })

  const response = await app.fetch(request)

  // Parse response body based on content type
  const contentType = response.headers.get('content-type') ?? ''
  let data: T

  if (contentType.includes('application/json')) {
    data = await response.json() as T
  } else if (contentType.includes('text/event-stream')) {
    // For SSE, return the raw text - caller can parse events
    data = await response.text() as unknown as T
  } else {
    data = await response.text() as unknown as T
  }

  return {
    status: response.status,
    headers: response.headers,
    data,
    raw: response,
  }
}

// Convenience methods

export function get<T = unknown>(path: string, options?: RequestOptions) {
  return apiRequest<T>('GET', path, options)
}

export function post<T = unknown>(path: string, options?: RequestOptions) {
  return apiRequest<T>('POST', path, options)
}

export function patch<T = unknown>(path: string, options?: RequestOptions) {
  return apiRequest<T>('PATCH', path, options)
}

export function del<T = unknown>(path: string, options?: RequestOptions) {
  return apiRequest<T>('DELETE', path, options)
}

/**
 * Helper for authenticated requests using a test context.
 */
export function withAuth(token: string, workspaceId: string) {
  return {
    get: <T = unknown>(path: string, options?: Omit<RequestOptions, 'token' | 'workspaceId'>) =>
      get<T>(path, { ...options, token, workspaceId }),

    post: <T = unknown>(path: string, options?: Omit<RequestOptions, 'token' | 'workspaceId'>) =>
      post<T>(path, { ...options, token, workspaceId }),

    patch: <T = unknown>(path: string, options?: Omit<RequestOptions, 'token' | 'workspaceId'>) =>
      patch<T>(path, { ...options, token, workspaceId }),

    del: <T = unknown>(path: string, options?: Omit<RequestOptions, 'token' | 'workspaceId'>) =>
      del<T>(path, { ...options, token, workspaceId }),
  }
}

/**
 * Read SSE events from a streaming response.
 * Returns an array of parsed event data.
 */
export async function readSSEEvents<T = unknown>(response: Response): Promise<Array<{ event: string; data: T }>> {
  const events: Array<{ event: string; data: T }> = []
  const reader = response.body?.getReader()

  if (!reader) {
    throw new Error('Response has no body')
  }

  const decoder = new TextDecoder()
  let buffer = ''

  while (true) {
    const { done, value } = await reader.read()
    if (done) break

    buffer += decoder.decode(value, { stream: true })

    // Parse complete events from buffer
    const lines = buffer.split('\n')
    buffer = lines.pop() ?? '' // Keep incomplete line in buffer

    let currentEvent = ''
    let currentData = ''

    for (const line of lines) {
      if (line.startsWith('event: ')) {
        currentEvent = line.slice(7)
      } else if (line.startsWith('data: ')) {
        currentData = line.slice(6)
      } else if (line === '' && currentEvent && currentData) {
        // End of event
        try {
          events.push({
            event: currentEvent,
            data: JSON.parse(currentData) as T,
          })
        } catch {
          // Non-JSON data
          events.push({
            event: currentEvent,
            data: currentData as unknown as T,
          })
        }
        currentEvent = ''
        currentData = ''
      }
    }
  }

  return events
}
