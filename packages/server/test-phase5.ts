/**
 * Phase 5 integration test script.
 * Tests all session and document CRUD endpoints against local Supabase.
 *
 * Usage: bun run packages/server/test-phase5.ts
 * Requires: local Supabase running, server running on PORT
 */

import { createClient } from '@supabase/supabase-js'

const SUPABASE_URL = Bun.env.SUPABASE_URL!
const SUPABASE_ANON_KEY = Bun.env.SUPABASE_ANON_KEY!
// Seed user credentials (from supabase/seed.sql)
const TEST_EMAIL = 'cdavies@shopped.com'
const TEST_PASSWORD = 'password123'
const SERVER_URL = `http://localhost:${Bun.env.PORT ?? 4000}`

const supabase = createClient(SUPABASE_URL, SUPABASE_ANON_KEY)
const supabaseAdmin = createClient(SUPABASE_URL, Bun.env.SUPABASE_SERVICE_ROLE_KEY!)

let jwt: string
let workspaceId: string
let userId: string

// ── Helpers ──────────────────────────────────────────────────────

async function api(
  method: string,
  path: string,
  body?: unknown,
): Promise<Response> {
  const headers: Record<string, string> = {
    Authorization: `Bearer ${jwt}`,
    'X-Workspace-Id': workspaceId,
  }
  if (body) headers['Content-Type'] = 'application/json'

  return fetch(`${SERVER_URL}${path}`, {
    method,
    headers,
    body: body ? JSON.stringify(body) : undefined,
  })
}

function pass(label: string) {
  console.log(`  ✅ ${label}`)
}

function fail(label: string, detail?: string) {
  console.error(`  ❌ ${label}${detail ? ': ' + detail : ''}`)
  process.exit(1)
}

function assert(condition: boolean, label: string, detail?: string) {
  if (condition) pass(label)
  else fail(label, detail)
}

// ── Auth ─────────────────────────────────────────────────────────

async function authenticate() {
  console.log('\n📋 Authenticating...')

  let { data, error } = await supabase.auth.signInWithPassword({
    email: TEST_EMAIL,
    password: TEST_PASSWORD,
  })

  if (error) {
    console.log('  Sign in failed, trying sign up...')
    const signUp = await supabase.auth.signUp({
      email: TEST_EMAIL,
      password: TEST_PASSWORD,
    })
    if (signUp.error) fail('Auth', signUp.error.message)
    // @ts-ignore
    data = signUp.data
  }

  jwt = data!.session!.access_token
  userId = data!.user!.id
  pass(`Authenticated as ${TEST_EMAIL} (${userId})`)

  // Get workspace membership
  const { data: memberships, error: memberError } = await supabaseAdmin
    .from('workspace_memberships')
    .select('workspace_id')
    .eq('user_id', userId)

  if (memberError || !memberships?.length) {
    console.log('  No workspace found, creating one...')
    const { data: ws, error: wsErr } = await supabaseAdmin
      .from('workspaces')
      .insert({ name: 'Test Workspace', created_by: userId })
      .select()
      .single()

    if (wsErr) fail('Create workspace', wsErr.message)
    workspaceId = ws!.id

    await supabaseAdmin.from('workspace_memberships').insert({
      workspace_id: workspaceId,
      user_id: userId,
      role: 'owner',
    })

    const { data: refreshed } = await supabase.auth.refreshSession()
    if (refreshed.session) {
      jwt = refreshed.session.access_token
    }
    pass(`Created workspace ${workspaceId}`)
  } else {
    workspaceId = memberships[0]!.workspace_id
    pass(`Using workspace ${workspaceId}`)
  }
}

// ── Session CRUD Tests ──────────────────────────────────────────

async function testSessionCRUD(): Promise<void> {
  console.log('\n═══ Session CRUD ═══')

  // CREATE
  console.log('\n📋 Create Session')
  const createRes = await api('POST', '/api/sessions', {
    title: 'Phase 5 Test Session',
    model: 'claude-sonnet-4-20250514',
    provider: 'anthropic',
    system_prompt: 'You are a test assistant.',
  })
  assert(createRes.status === 201, 'Create returns 201')
  const { session: created } = await createRes.json() as any
  assert(!!created?.id, 'Response has session.id')
  assert(created.title === 'Phase 5 Test Session', `Title is correct: "${created.title}"`)
  assert(created.model === 'claude-sonnet-4-20250514', 'Model is correct')
  assert(created.provider === 'anthropic', 'Provider is correct')
  assert(created.archived === false, 'Not archived by default')
  const sessionId = created.id

  // CREATE with defaults
  console.log('\n📋 Create Session (defaults)')
  const defaultRes = await api('POST', '/api/sessions', {})
  assert(defaultRes.status === 201, 'Create with defaults returns 201')
  const { session: defaultSession } = await defaultRes.json() as any
  assert(defaultSession.title === 'New Session', `Default title: "${defaultSession.title}"`)
  const defaultSessionId = defaultSession.id

  // LIST
  console.log('\n📋 List Sessions')
  const listRes = await api('GET', '/api/sessions')
  assert(listRes.status === 200, 'List returns 200')
  const listData = await listRes.json() as any
  assert(Array.isArray(listData.data), 'Response has data array')
  assert(listData.data.length >= 2, `Found ${listData.data.length} sessions (expected >= 2)`)
  assert('cursor' in listData, 'Response has cursor field')

  // LIST with pagination
  console.log('\n📋 List Sessions (pagination)')
  const page1Res = await api('GET', '/api/sessions?limit=1')
  assert(page1Res.status === 200, 'Paginated list returns 200')
  const page1 = await page1Res.json() as any
  assert(page1.data.length === 1, `Page 1 has 1 item (got ${page1.data.length})`)
  assert(page1.cursor !== null, 'Page 1 has cursor for next page')

  // Fetch page 2 with cursor
  const page2Res = await api('GET', `/api/sessions?limit=1&cursor=${encodeURIComponent(page1.cursor)}`)
  assert(page2Res.status === 200, 'Page 2 returns 200')
  const page2 = await page2Res.json() as any
  assert(page2.data.length === 1, `Page 2 has 1 item (got ${page2.data.length})`)
  assert(page2.data[0].id !== page1.data[0].id, 'Page 2 has different session than page 1')

  // GET
  console.log('\n📋 Get Session')
  const getRes = await api('GET', `/api/sessions/${sessionId}`)
  assert(getRes.status === 200, 'Get returns 200')
  const getData = await getRes.json() as any
  assert(getData.session?.id === sessionId, 'Returns correct session')
  assert(Array.isArray(getData.messages), 'Includes messages array')
  assert(getData.messages.length === 0, `New session has 0 messages (got ${getData.messages.length})`)

  // GET non-existent
  console.log('\n📋 Get Non-existent Session')
  const notFoundRes = await api('GET', '/api/sessions/00000000-0000-0000-0000-000000000000')
  assert(notFoundRes.status === 404, `Non-existent returns 404 (got ${notFoundRes.status})`)

  // UPDATE title
  console.log('\n📋 Update Session (title)')
  const updateRes = await api('PATCH', `/api/sessions/${sessionId}`, {
    title: 'Updated Title',
  })
  assert(updateRes.status === 200, 'Update returns 200')
  const { session: updated } = await updateRes.json() as any
  assert(updated.title === 'Updated Title', `Title updated: "${updated.title}"`)

  // UPDATE archive
  console.log('\n📋 Archive Session')
  const archiveRes = await api('PATCH', `/api/sessions/${sessionId}`, {
    archived: true,
  })
  assert(archiveRes.status === 200, 'Archive returns 200')
  const { session: archived } = await archiveRes.json() as any
  assert(archived.archived === true, 'Session is archived')

  // Verify archived session doesn't appear in list
  const listAfterArchive = await api('GET', '/api/sessions')
  const afterArchiveData = await listAfterArchive.json() as any
  const archivedInList = afterArchiveData.data.find((s: any) => s.id === sessionId)
  assert(!archivedInList, 'Archived session not in list')

  // Unarchive
  await api('PATCH', `/api/sessions/${sessionId}`, { archived: false })

  // Cleanup: archive the test sessions so they don't pollute future runs
  await api('PATCH', `/api/sessions/${sessionId}`, { archived: true })
  await api('PATCH', `/api/sessions/${defaultSessionId}`, { archived: true })
}

// ── Document CRUD Tests ─────────────────────────────────────────

async function testDocumentCRUD(): Promise<void> {
  console.log('\n═══ Document CRUD ═══')

  // CREATE
  console.log('\n📋 Create Document')
  const createRes = await api('POST', '/api/documents', {
    name: 'Test Document',
    content: '# Hello World\n\nThis is a test document.',
  })
  assert(createRes.status === 201, `Create returns 201 (got ${createRes.status})`)
  const { document: created } = await createRes.json() as any
  assert(!!created?.id, 'Response has document.id')
  assert(created.name === 'Test Document', `Name is correct: "${created.name}"`)
  assert(!!created.created_at, 'Has created_at')
  assert(!!created.updated_at, 'Has updated_at')
  const docId = created.id

  // CREATE without content
  console.log('\n📋 Create Document (no content)')
  const emptyRes = await api('POST', '/api/documents', {
    name: 'Empty Document',
  })
  assert(emptyRes.status === 201, 'Create empty returns 201')
  const { document: emptyDoc } = await emptyRes.json() as any
  assert(emptyDoc.name === 'Empty Document', `Empty doc name: "${emptyDoc.name}"`)
  const emptyDocId = emptyDoc.id

  // LIST
  console.log('\n📋 List Documents')
  const listRes = await api('GET', '/api/documents')
  assert(listRes.status === 200, 'List returns 200')
  const { documents } = await listRes.json() as any
  assert(Array.isArray(documents), 'Response has documents array')
  assert(documents.length >= 2, `Found ${documents.length} documents (expected >= 2)`)

  // GET with content
  console.log('\n📋 Get Document')
  const getRes = await api('GET', `/api/documents/${docId}`)
  assert(getRes.status === 200, 'Get returns 200')
  const { document: fetched } = await getRes.json() as any
  assert(fetched.id === docId, 'Returns correct document')
  assert(fetched.name === 'Test Document', `Name correct: "${fetched.name}"`)
  assert(typeof fetched.content === 'string', 'Has content field')
  assert(fetched.content.includes('Hello World'), `Content includes "Hello World": "${fetched.content.slice(0, 80)}"`)

  // GET non-existent
  console.log('\n📋 Get Non-existent Document')
  const notFoundRes = await api('GET', '/api/documents/00000000-0000-0000-0000-000000000000')
  assert(notFoundRes.status === 404, `Non-existent returns 404 (got ${notFoundRes.status})`)

  // PATCH name
  console.log('\n📋 Update Document (name)')
  const renameRes = await api('PATCH', `/api/documents/${docId}`, {
    name: 'Renamed Document',
  })
  assert(renameRes.status === 200, 'Rename returns 200')
  const { document: renamed } = await renameRes.json() as any
  assert(renamed.name === 'Renamed Document', `Name updated: "${renamed.name}"`)

  // PATCH content
  console.log('\n📋 Update Document (content)')
  const contentRes = await api('PATCH', `/api/documents/${docId}`, {
    content: '# Updated\n\nNew content here.',
  })
  assert(contentRes.status === 200, 'Content update returns 200')

  // Verify content was updated
  const verifyRes = await api('GET', `/api/documents/${docId}`)
  const { document: verified } = await verifyRes.json() as any
  assert(verified.content.includes('Updated'), `Content updated: "${verified.content.slice(0, 80)}"`)
  assert(verified.name === 'Renamed Document', 'Name preserved after content update')

  // PATCH both
  console.log('\n📋 Update Document (name + content)')
  const bothRes = await api('PATCH', `/api/documents/${docId}`, {
    name: 'Final Name',
    content: '# Final\n\nFinal content.',
  })
  assert(bothRes.status === 200, 'Both update returns 200')
  const { document: both } = await bothRes.json() as any
  assert(both.name === 'Final Name', `Name: "${both.name}"`)

  // PATCH non-existent
  console.log('\n📋 Patch Non-existent Document')
  const patchNotFound = await api('PATCH', '/api/documents/00000000-0000-0000-0000-000000000000', {
    name: 'Nope',
  })
  assert(patchNotFound.status === 404, `Patch non-existent returns 404 (got ${patchNotFound.status})`)

  // DELETE
  console.log('\n📋 Delete Document')
  const deleteRes = await api('DELETE', `/api/documents/${docId}`)
  assert(deleteRes.status === 200, 'Delete returns 200')
  const deleteBody = await deleteRes.json() as any
  assert(deleteBody.success === true, 'Delete returns { success: true }')

  // Verify deleted
  const afterDelete = await api('GET', `/api/documents/${docId}`)
  assert(afterDelete.status === 404, `Deleted doc returns 404 (got ${afterDelete.status})`)

  // DELETE non-existent
  console.log('\n📋 Delete Non-existent Document')
  const deleteNotFound = await api('DELETE', '/api/documents/00000000-0000-0000-0000-000000000000')
  assert(deleteNotFound.status === 404, `Delete non-existent returns 404 (got ${deleteNotFound.status})`)

  // Cleanup
  await api('DELETE', `/api/documents/${emptyDocId}`)
}

// ── Auth Edge Cases ─────────────────────────────────────────────

async function testAuthEdgeCases(): Promise<void> {
  console.log('\n═══ Auth Edge Cases ═══')

  // No auth header
  console.log('\n📋 No auth header')
  const noAuth = await fetch(`${SERVER_URL}/api/sessions`, {
    headers: { 'X-Workspace-Id': workspaceId },
  })
  assert(noAuth.status === 401, `No auth returns 401 (got ${noAuth.status})`)

  // Invalid JWT
  console.log('\n📋 Invalid JWT')
  const badJwt = await fetch(`${SERVER_URL}/api/sessions`, {
    headers: {
      Authorization: 'Bearer invalid-token-here',
      'X-Workspace-Id': workspaceId,
    },
  })
  assert(badJwt.status === 401, `Invalid JWT returns 401 (got ${badJwt.status})`)

  // Missing workspace ID
  console.log('\n📋 Missing workspace ID')
  const noWorkspace = await fetch(`${SERVER_URL}/api/sessions`, {
    headers: { Authorization: `Bearer ${jwt}` },
  })
  assert(noWorkspace.status === 400, `Missing workspace returns 400 (got ${noWorkspace.status})`)

  // Wrong workspace ID
  console.log('\n📋 Wrong workspace ID')
  const wrongWs = await fetch(`${SERVER_URL}/api/sessions`, {
    headers: {
      Authorization: `Bearer ${jwt}`,
      'X-Workspace-Id': '00000000-0000-0000-0000-000000000000',
    },
  })
  assert(wrongWs.status === 403, `Wrong workspace returns 403 (got ${wrongWs.status})`)
}

// ── Main ─────────────────────────────────────────────────────────

async function main() {
  console.log('═══════════════════════════════════════════')
  console.log(' Phase 5 Manual Verification')
  console.log('═══════════════════════════════════════════')

  await authenticate()
  await testAuthEdgeCases()
  await testSessionCRUD()
  await testDocumentCRUD()

  console.log('\n═══════════════════════════════════════════')
  console.log(' ✅ All Phase 5 tests passed!')
  console.log('═══════════════════════════════════════════\n')
}

main().catch((err) => {
  console.error('\n💥 Fatal error:', err)
  process.exit(1)
})
