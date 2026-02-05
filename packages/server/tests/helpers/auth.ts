/**
 * Authentication helpers for tests.
 *
 * Creates test users, workspaces, and generates auth tokens.
 * Uses the service role to bypass RLS for setup operations.
 */

import { getSupabaseAdmin, getSupabaseAnon, getTestDb } from '../setup'

export interface TestUser {
  id: string
  email: string
}

export interface TestWorkspace {
  id: string
  name: string
}

export interface TestProject {
  id: string
  name: string
  workspace_id: string
}

export interface TestContext {
  user: TestUser
  workspace: TestWorkspace
  project: TestProject
  token: string
}

/**
 * Create a test user in Supabase Auth.
 * Returns the user ID and email.
 */
export async function createTestUser(
  email: string = `test-${Date.now()}-${Math.random().toString(36).slice(2)}@test.local`
): Promise<TestUser> {
  const supabase = getSupabaseAdmin()

  const { data, error } = await supabase.auth.admin.createUser({
    email,
    password: 'test-password-123',
    email_confirm: true, // Auto-confirm email
  })

  if (error) {
    throw new Error(`Failed to create test user: ${error.message}`)
  }

  return {
    id: data.user.id,
    email: data.user.email!,
  }
}

/**
 * Delete a test user from Supabase Auth.
 */
export async function deleteTestUser(userId: string): Promise<void> {
  const supabase = getSupabaseAdmin()
  const { error } = await supabase.auth.admin.deleteUser(userId)
  if (error) {
    console.warn(`Failed to delete test user ${userId}: ${error.message}`)
  }
}

/**
 * Create a workspace directly in the database.
 * Bypasses RLS using direct SQL.
 */
export async function createTestWorkspace(
  name: string = `Test Workspace ${Date.now()}`
): Promise<TestWorkspace> {
  const db = getTestDb()

  const [workspace] = await db`
    INSERT INTO workspaces (name)
    VALUES (${name})
    RETURNING id, name
  `

  return {
    id: workspace.id,
    name: workspace.name,
  }
}

/**
 * Add a user to a workspace.
 */
export async function addUserToWorkspace(
  userId: string,
  workspaceId: string,
  role: string = 'member'
): Promise<void> {
  const db = getTestDb()

  await db`
    INSERT INTO workspace_memberships (user_id, workspace_id, role)
    VALUES (${userId}, ${workspaceId}, ${role})
    ON CONFLICT (user_id, workspace_id) DO NOTHING
  `
}

/**
 * Create a project in a workspace.
 */
export async function createTestProject(
  workspaceId: string,
  userId: string,
  name: string = `Test Project ${Date.now()}`
): Promise<TestProject> {
  const db = getTestDb()

  const [project] = await db`
    INSERT INTO projects (workspace_id, name, created_by)
    VALUES (${workspaceId}, ${name}, ${userId})
    RETURNING id, name, workspace_id
  `

  return {
    id: project.id,
    name: project.name,
    workspace_id: project.workspace_id,
  }
}

/**
 * Grant a user permission to access a project.
 * This is needed because the RLS policy requires explicit project permissions.
 */
export async function addProjectPermission(
  projectId: string,
  userId: string,
  permission: string = 'read'
): Promise<void> {
  const db = getTestDb()

  await db`
    INSERT INTO project_permissions (project_id, user_id, permission)
    VALUES (${projectId}, ${userId}, ${permission})
    ON CONFLICT (project_id, user_id) DO NOTHING
  `
}

/**
 * Sign in a user and get their access token.
 * The token includes workspace memberships via custom_access_token_hook.
 */
export async function signInUser(email: string, password: string = 'test-password-123'): Promise<string> {
  const supabase = getSupabaseAnon()

  const { data, error } = await supabase.auth.signInWithPassword({
    email,
    password,
  })

  if (error) {
    throw new Error(`Failed to sign in: ${error.message}`)
  }

  return data.session.access_token
}

/**
 * Create a complete test context with user, workspace, project, and auth token.
 * This is the main helper for most tests.
 */
export async function createTestContext(options?: {
  email?: string
  workspaceName?: string
  projectName?: string
}): Promise<TestContext> {
  // Create user
  const user = await createTestUser(options?.email)

  // Create workspace
  const workspace = await createTestWorkspace(options?.workspaceName)

  // Add user to workspace
  await addUserToWorkspace(user.id, workspace.id)

  // Sign in to get token (this triggers the custom_access_token_hook)
  const token = await signInUser(user.email)

  // Create a default project in the workspace
  const project = await createTestProject(workspace.id, user.id, options?.projectName)

  return { user, workspace, project, token }
}

/**
 * Create multiple test users in a workspace.
 * Useful for testing multi-user scenarios.
 */
export async function createTestTeam(size: number, workspaceName?: string): Promise<{
  workspace: TestWorkspace
  project: TestProject
  members: Array<{ user: TestUser; token: string }>
}> {
  const workspace = await createTestWorkspace(workspaceName)
  const members: Array<{ user: TestUser; token: string }> = []

  for (let i = 0; i < size; i++) {
    const user = await createTestUser()
    await addUserToWorkspace(user.id, workspace.id)
    const token = await signInUser(user.email)
    members.push({ user, token })
  }

  // Create a default project using the first member
  const project = await createTestProject(workspace.id, members[0]!.user.id)

  // Grant all members access to the project (needed for RLS to allow access)
  for (const member of members) {
    await addProjectPermission(project.id, member.user.id, 'admin')
  }

  return { workspace, project, members }
}
