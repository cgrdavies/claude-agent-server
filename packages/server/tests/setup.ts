/**
 * Test environment setup and utilities.
 *
 * This module provides:
 * - Environment configuration for test Supabase instance
 * - Database reset functionality
 * - Global setup/teardown hooks
 */

import { SQL } from 'bun'
import { createClient, type SupabaseClient } from '@supabase/supabase-js'

// Test environment configuration
// These point to the test Supabase instance (different ports from dev)
export const TEST_CONFIG = {
  SUPABASE_URL: process.env.TEST_SUPABASE_URL ?? 'http://127.0.0.1:55321',
  SUPABASE_ANON_KEY: process.env.TEST_SUPABASE_ANON_KEY ?? '',
  SUPABASE_SERVICE_KEY: process.env.TEST_SUPABASE_SERVICE_KEY ?? '',
  DATABASE_URL: process.env.TEST_DATABASE_URL ?? 'postgresql://postgres:postgres@127.0.0.1:55322/postgres',
}

// Validate test environment
function validateTestEnv() {
  if (!TEST_CONFIG.SUPABASE_ANON_KEY) {
    throw new Error(
      'TEST_SUPABASE_ANON_KEY not set. Run `cd supabase-test && supabase start` and set the keys in .env.test'
    )
  }
  if (!TEST_CONFIG.SUPABASE_SERVICE_KEY) {
    throw new Error(
      'TEST_SUPABASE_SERVICE_KEY not set. Run `cd supabase-test && supabase start` and set the keys in .env.test'
    )
  }
}

// Singleton database connection for tests
let _testDb: SQL | null = null

export function getTestDb(): SQL {
  if (!_testDb) {
    _testDb = new SQL({
      url: TEST_CONFIG.DATABASE_URL,
      max: 5,
      idleTimeout: 30,
    })
  }
  return _testDb
}

// Singleton Supabase clients
let _supabaseAdmin: SupabaseClient | null = null
let _supabaseAnon: SupabaseClient | null = null

/**
 * Get Supabase client with service role (bypasses RLS).
 * Use for test setup operations like creating users.
 */
export function getSupabaseAdmin(): SupabaseClient {
  validateTestEnv()
  if (!_supabaseAdmin) {
    _supabaseAdmin = createClient(
      TEST_CONFIG.SUPABASE_URL,
      TEST_CONFIG.SUPABASE_SERVICE_KEY,
      { auth: { autoRefreshToken: false, persistSession: false } }
    )
  }
  return _supabaseAdmin
}

/**
 * Get Supabase client with anon key (respects RLS).
 * Use for simulating actual client behavior in tests.
 */
export function getSupabaseAnon(): SupabaseClient {
  validateTestEnv()
  if (!_supabaseAnon) {
    _supabaseAnon = createClient(
      TEST_CONFIG.SUPABASE_URL,
      TEST_CONFIG.SUPABASE_ANON_KEY,
      { auth: { autoRefreshToken: false, persistSession: false } }
    )
  }
  return _supabaseAnon
}

/**
 * Reset agent tables to clean state.
 * Calls the reset_agent_tables() function defined in seed.sql.
 * Takes ~100-200ms.
 */
export async function resetAgentTables(): Promise<void> {
  const db = getTestDb()
  await db`SELECT reset_agent_tables()`
}

/**
 * Full cleanup of test data including users and workspaces.
 * Use sparingly - resetAgentTables() is faster for most tests.
 */
export async function resetAllTestData(): Promise<void> {
  const db = getTestDb()

  // Disable triggers
  await db`SET session_replication_role = 'replica'`

  // Clean in dependency order
  await db`TRUNCATE TABLE messages RESTART IDENTITY CASCADE`
  await db`TRUNCATE TABLE documents RESTART IDENTITY CASCADE`
  await db`TRUNCATE TABLE agent_sessions RESTART IDENTITY CASCADE`
  await db`TRUNCATE TABLE workspace_memberships RESTART IDENTITY CASCADE`
  await db`TRUNCATE TABLE workspaces RESTART IDENTITY CASCADE`

  // Clean auth users (requires service role)
  // Note: This doesn't delete auth.users, just our app data

  // Re-enable triggers
  await db`SET session_replication_role = 'origin'`
}

/**
 * Close all test connections.
 * Call in afterAll() of test suites.
 */
export async function closeTestConnections(): Promise<void> {
  if (_testDb) {
    await _testDb.close()
    _testDb = null
  }
  // Supabase clients don't need explicit closing
  _supabaseAdmin = null
  _supabaseAnon = null
}

/**
 * Override environment variables for the server to use test Supabase.
 * Call before importing server modules.
 */
export function setupTestEnvironment(): void {
  validateTestEnv()

  // Override env vars that the server uses
  process.env.SUPABASE_URL = TEST_CONFIG.SUPABASE_URL
  process.env.SUPABASE_ANON_KEY = TEST_CONFIG.SUPABASE_ANON_KEY
  process.env.DATABASE_URL = TEST_CONFIG.DATABASE_URL
  process.env.FRONTEND_URL = 'http://localhost:3000'

  // Set test-specific flags
  process.env.NODE_ENV = 'test'
}
