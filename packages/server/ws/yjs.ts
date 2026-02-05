import type { Server, ServerWebSocket } from 'bun'
import { createClient, type SupabaseClient } from '@supabase/supabase-js'
import {
  handleYjsOpen,
  handleYjsMessage,
  handleYjsClose,
  type YjsWSData,
} from '../yjs-sync'

export type WSData = YjsWSData

let _supabase: SupabaseClient | null = null

function getSupabase(): SupabaseClient {
  if (!_supabase) {
    _supabase = createClient(
      Bun.env.SUPABASE_URL!,
      Bun.env.SUPABASE_ANON_KEY!,
    )
  }
  return _supabase
}

/**
 * Reset the Supabase client singleton.
 * Used by tests to ensure correct env vars are picked up.
 */
export function resetSupabaseClient(): void {
  _supabase = null
}

/**
 * Decode JWT payload without verification (verification is done by getUser).
 */
function decodeJwtPayload(jwt: string): Record<string, unknown> {
  const parts = jwt.split('.')
  if (parts.length !== 3) return {}
  try {
    return JSON.parse(atob(parts[1]!))
  } catch {
    return {}
  }
}

/**
 * Handle WebSocket upgrade requests for Yjs document sync.
 * Authenticates via ?token=<jwt>&workspace_id=<uuid>&project_id=<uuid> query params.
 * Returns true if the request was upgraded, undefined otherwise.
 */
export function handleYjsUpgrade(req: Request, server: Server<WSData>): boolean {
  const url = new URL(req.url)
  const match = url.pathname.match(/^\/ws\/documents\/([^/]+)$/)
  if (!match) return false

  const docId = match[1]!
  const token = url.searchParams.get('token')
  const workspaceId = url.searchParams.get('workspace_id')
  const projectId = url.searchParams.get('project_id')

  if (!token || !workspaceId || !projectId) {
    return false
  }

  // Store token, workspaceId (for auth), and projectId (for document loading)
  const data: YjsWSData = {
    type: 'yjs',
    docId,
    token,
    projectId,
    _workspaceId: workspaceId, // Used only for auth verification
  }

  return server.upgrade(req, { data })
}

/**
 * Verify JWT and workspace membership for a WebSocket connection.
 * Returns userId if valid, null otherwise.
 */
async function verifyWebSocketAuth(token: string, workspaceId: string): Promise<string | null> {
  const supabase = getSupabase()

  const { data: { user }, error } = await supabase.auth.getUser(token)

  if (error || !user) {
    return null
  }

  // Check workspace membership from JWT claims
  const claims = decodeJwtPayload(token)
  const memberships = (claims.workspaces ?? []) as Array<{ workspace_id: string }>
  const isMember = memberships.some((m) => m.workspace_id === workspaceId)

  if (!isMember) {
    return null
  }

  return user.id
}

/**
 * Bun WebSocket handler configuration for Yjs sync.
 */
export const yjsWebsocket = {
  async open(ws: ServerWebSocket<WSData>) {
    const { token, projectId, _workspaceId } = ws.data

    if (!token || !projectId || !_workspaceId) {
      ws.close(4001, 'Missing authentication')
      return
    }

    // Verify auth using workspace membership
    const userId = await verifyWebSocketAuth(token, _workspaceId)
    if (!userId) {
      ws.close(4003, 'Unauthorized')
      return
    }

    // Store userId for use in doc operations
    ws.data.userId = userId

    await handleYjsOpen(ws as ServerWebSocket<YjsWSData>)
  },

  message(ws: ServerWebSocket<WSData>, message: string | ArrayBuffer | Buffer) {
    handleYjsMessage(ws as ServerWebSocket<YjsWSData>, message as ArrayBuffer)
  },

  close(ws: ServerWebSocket<WSData>) {
    handleYjsClose(ws as ServerWebSocket<YjsWSData>)
  },
}
