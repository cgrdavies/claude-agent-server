import { SQL } from 'bun'

/**
 * Direct Postgres connection pool via Bun.sql.
 * Uses the Supabase connection pooler (Transaction mode).
 */
const sql = new SQL({
  url: Bun.env.DATABASE_URL!,
  max: 20,
  idleTimeout: 30,
})

/**
 * Execute a query with RLS context set for a specific user.
 * Wraps the query in a transaction that sets the Supabase JWT claims,
 * so all RLS policies using auth.uid() work correctly.
 *
 * IMPORTANT: Any error inside the transaction causes an automatic rollback
 * AND re-throws the error. We never silently swallow failures.
 *
 * Usage:
 *   const rows = await withRLS(userId, (sql) =>
 *     sql`SELECT * FROM agent_sessions WHERE workspace_id = ${workspaceId}`
 *   )
 */
export async function withRLS<T>(
  userId: string,
  fn: (sql: SQL) => Promise<T>,
): Promise<T> {
  try {
    return await sql.begin(async (tx) => {
      await tx`SELECT set_config('request.jwt.claims', ${JSON.stringify({ sub: userId, role: 'authenticated' })}, true)`
      await tx`SET LOCAL role = 'authenticated'`
      return fn(tx)
    })
  } catch (err) {
    // Always re-throw - never silently swallow a rolled-back transaction
    const message = err instanceof Error ? err.message : String(err)
    throw new Error(`withRLS transaction failed for user ${userId}: ${message}`, { cause: err })
  }
}

/**
 * Execute a query as service role (bypasses RLS).
 * Use sparingly - only for admin operations.
 */
export { sql as db }
