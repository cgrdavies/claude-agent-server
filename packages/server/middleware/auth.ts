import { createMiddleware } from 'hono/factory'
import { createClient, type SupabaseClient } from '@supabase/supabase-js'

type AuthVariables = {
  userId: string
  workspaceId: string
  isSuperuser: boolean
}

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
 * Verifies Supabase JWT and extracts user + workspace context.
 * Workspace ID comes from ?workspace_id query param or X-Workspace-Id header,
 * validated against the user's workspace_memberships in the JWT claims.
 *
 * JWT verification uses Supabase's getUser() (HTTP call to auth server).
 * Workspace membership is checked from JWT claims set by custom_access_token_hook.
 * All data queries then use Bun.sql with RLS context set via withRLS().
 */
export const authMiddleware = createMiddleware<{ Variables: AuthVariables }>(
  async (c, next) => {
    const authHeader = c.req.header('Authorization')
    if (!authHeader?.startsWith('Bearer ')) {
      return c.json({ error: 'Missing authorization token' }, 401)
    }

    const jwt = authHeader.slice(7)

    const supabase = getSupabase()
    const { data: { user }, error } = await supabase.auth.getUser(jwt)

    if (error || !user) {
      return c.json({ error: 'Invalid or expired token' }, 401)
    }

    const workspaceId =
      c.req.header('X-Workspace-Id') ??
      c.req.query('workspace_id')

    if (!workspaceId) {
      return c.json({ error: 'Missing workspace_id' }, 400)
    }

    // Validate workspace membership from JWT claims
    // The custom_access_token_hook enriches the JWT with a 'workspaces' array
    // containing { workspace_id, workspace_name, organization_id, role }.
    // Since getUser() returns the user from the DB (not JWT claims), we decode
    // the JWT payload directly to access the hook-injected claims.
    const claims = decodeJwtPayload(jwt)
    const memberships = (claims.workspaces ?? []) as Array<{ workspace_id: string }>

    const isMember = memberships.some(
      (m) => m.workspace_id === workspaceId,
    )

    if (!isMember) {
      return c.json({ error: 'Not a member of this workspace' }, 403)
    }

    c.set('userId', user.id)
    c.set('workspaceId', workspaceId)
    c.set('isSuperuser', claims.is_superuser === true)

    await next()
  },
)
