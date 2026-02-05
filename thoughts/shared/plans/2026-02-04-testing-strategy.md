# Testing Strategy for claude-agent-server

## Overview

This document outlines a comprehensive testing strategy focused on **API integration tests** at the HTTP boundary. We minimize mocking by:
1. Using a real (but separate) Supabase/Postgres instance for tests
2. Leveraging Vercel AI SDK's built-in test utilities instead of mocking HTTP

## Key Decisions

### 1. Test Level: API Integration Tests

Tests at the HTTP boundary (`POST /api/sessions`, `GET /api/documents`, etc.) because:
- They represent the actual external contract
- They exercise the full stack: routing → auth → RLS → database
- They catch integration bugs that unit tests miss
- They're the natural boundary for this service

### 2. What We Mock

**Only the AI model** - using Vercel AI SDK's built-in `MockLanguageModelV3`:

```typescript
import { MockLanguageModelV3 } from 'ai/test';
import { simulateReadableStream } from 'ai';
```

The AI SDK provides:
- `MockLanguageModelV3` - deterministic responses, no API calls
- `simulateReadableStream` - for testing streaming responses
- Full control over tool calls, tokens, finish reasons

**We don't mock:**
- Supabase Auth (use real local instance)
- PostgreSQL/RLS (use real local instance)
- Hono routing
- WebSocket connections

### 3. Database Isolation: Separate Test Instance

Run a dedicated Supabase instance for tests with different ports:

| Service | Dev Port | Test Port |
|---------|----------|-----------|
| API     | 54321    | 55321     |
| DB      | 54322    | 55322     |
| Studio  | 54323    | 55323     |

### 4. Database Cleanup: Table Truncation

Use a SQL function to truncate agent tables between tests (~100-200ms):

```sql
CREATE OR REPLACE FUNCTION reset_agent_tables()
RETURNS void AS $$
BEGIN
  SET session_replication_role = 'replica'; -- Disable triggers temporarily

  TRUNCATE TABLE messages RESTART IDENTITY CASCADE;
  TRUNCATE TABLE documents RESTART IDENTITY CASCADE;
  TRUNCATE TABLE agent_sessions RESTART IDENTITY CASCADE;

  SET session_replication_role = 'origin';
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;
```

Called via `beforeEach` in tests:
```typescript
beforeEach(async () => {
  await db`SELECT reset_agent_tables()`;
});
```

This gives us Rails-like clean slate behavior without the 30s container restart.

---

## Architecture

### Directory Structure

```
packages/server/
├── tests/
│   ├── setup.ts              # Global test setup/teardown
│   ├── helpers/
│   │   ├── auth.ts           # Test user/workspace creation
│   │   ├── api.ts            # HTTP request helpers
│   │   └── ai-mock.ts        # AI model mock factory
│   ├── sessions.test.ts      # Session API tests
│   ├── messages.test.ts      # Message/streaming API tests
│   └── documents.test.ts     # Document API tests
```

### Test Environment Setup

```typescript
// packages/server/tests/setup.ts
import { SQL } from 'bun';

const testDb = new SQL({
  url: process.env.TEST_DATABASE_URL!,
});

export async function setupTestEnvironment() {
  // Create the reset function if it doesn't exist
  await testDb`
    CREATE OR REPLACE FUNCTION reset_agent_tables() ...
  `;
}

export async function resetDatabase() {
  await testDb`SELECT reset_agent_tables()`;
}

export async function teardownTestEnvironment() {
  await testDb.close();
}
```

### Auth Helpers

```typescript
// packages/server/tests/helpers/auth.ts
import { createClient } from '@supabase/supabase-js';

const supabase = createClient(
  process.env.TEST_SUPABASE_URL!,
  process.env.TEST_SUPABASE_SERVICE_KEY! // Service role for test setup
);

export async function createTestUser(email: string = `test-${Date.now()}@example.com`) {
  const { data, error } = await supabase.auth.admin.createUser({
    email,
    password: 'test-password-123',
    email_confirm: true,
  });
  if (error) throw error;
  return data.user;
}

export async function createTestWorkspace(name: string = 'Test Workspace') {
  const { data, error } = await supabase
    .from('workspaces')
    .insert({ name })
    .select()
    .single();
  if (error) throw error;
  return data;
}

export async function addUserToWorkspace(userId: string, workspaceId: string) {
  await supabase
    .from('workspace_memberships')
    .insert({ user_id: userId, workspace_id: workspaceId });
}

export async function getAuthToken(userId: string): Promise<string> {
  // Generate a JWT for the test user
  const { data, error } = await supabase.auth.admin.generateLink({
    type: 'magiclink',
    email: `test-user-${userId}@example.com`,
  });
  // ... or use a simpler approach with service key
}
```

### AI Mock Factory

```typescript
// packages/server/tests/helpers/ai-mock.ts
import { MockLanguageModelV3 } from 'ai/test';
import { simulateReadableStream } from 'ai';

export function createMockModel(options: {
  response?: string;
  toolCalls?: Array<{ name: string; args: Record<string, unknown> }>;
  streaming?: boolean;
}) {
  if (options.streaming) {
    return new MockLanguageModelV3({
      doStream: async () => ({
        stream: simulateReadableStream({
          chunks: [
            { type: 'text-start', id: 'text-1' },
            { type: 'text-delta', id: 'text-1', delta: options.response ?? 'Hello!' },
            { type: 'text-end', id: 'text-1' },
            {
              type: 'finish',
              finishReason: { unified: 'stop', raw: undefined },
              usage: { promptTokens: 10, completionTokens: 5 },
            },
          ],
        }),
      }),
    });
  }

  return new MockLanguageModelV3({
    doGenerate: async () => ({
      rawCall: { rawPrompt: null, rawSettings: {} },
      finishReason: 'stop',
      usage: { promptTokens: 10, completionTokens: 20 },
      text: options.response ?? 'Hello, world!',
      toolCalls: options.toolCalls,
    }),
  });
}
```

### API Request Helpers

```typescript
// packages/server/tests/helpers/api.ts
const TEST_SERVER_URL = 'http://localhost:4001'; // Test server port

export async function apiRequest(
  method: string,
  path: string,
  options: {
    token: string;
    workspaceId: string;
    body?: unknown;
  }
) {
  const res = await fetch(`${TEST_SERVER_URL}${path}`, {
    method,
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${options.token}`,
      'X-Workspace-Id': options.workspaceId,
    },
    body: options.body ? JSON.stringify(options.body) : undefined,
  });

  return {
    status: res.status,
    data: res.headers.get('content-type')?.includes('json')
      ? await res.json()
      : await res.text(),
  };
}
```

---

## Example Tests

### Sessions API

```typescript
// packages/server/tests/sessions.test.ts
import { test, expect, beforeAll, beforeEach, afterAll } from 'bun:test';
import { setupTestEnvironment, resetDatabase, teardownTestEnvironment } from './setup';
import { createTestUser, createTestWorkspace, addUserToWorkspace, getAuthToken } from './helpers/auth';
import { apiRequest } from './helpers/api';

let testUser: { id: string };
let testWorkspace: { id: string };
let authToken: string;

beforeAll(async () => {
  await setupTestEnvironment();
  testUser = await createTestUser();
  testWorkspace = await createTestWorkspace();
  await addUserToWorkspace(testUser.id, testWorkspace.id);
  authToken = await getAuthToken(testUser.id);
});

beforeEach(async () => {
  await resetDatabase();
});

afterAll(async () => {
  await teardownTestEnvironment();
});

test('POST /api/sessions creates a new session', async () => {
  const res = await apiRequest('POST', '/api/sessions', {
    token: authToken,
    workspaceId: testWorkspace.id,
    body: { title: 'Test Session' },
  });

  expect(res.status).toBe(201);
  expect(res.data.title).toBe('Test Session');
  expect(res.data.workspace_id).toBe(testWorkspace.id);
});

test('GET /api/sessions returns only workspace sessions', async () => {
  // Create session in test workspace
  await apiRequest('POST', '/api/sessions', {
    token: authToken,
    workspaceId: testWorkspace.id,
    body: { title: 'My Session' },
  });

  // Create another workspace the user isn't part of
  // (This session shouldn't appear)

  const res = await apiRequest('GET', '/api/sessions', {
    token: authToken,
    workspaceId: testWorkspace.id,
  });

  expect(res.status).toBe(200);
  expect(res.data.sessions).toHaveLength(1);
  expect(res.data.sessions[0].title).toBe('My Session');
});

test('GET /api/sessions requires authentication', async () => {
  const res = await fetch('http://localhost:4001/api/sessions');
  expect(res.status).toBe(401);
});
```

### Messages API (with AI mocking)

```typescript
// packages/server/tests/messages.test.ts
import { test, expect, beforeAll, beforeEach, afterAll, mock } from 'bun:test';
import { createMockModel } from './helpers/ai-mock';
import * as providers from '../lib/providers';

beforeAll(async () => {
  // Mock the getModel function to return our test model
  mock.module('../lib/providers', () => ({
    ...providers,
    getModel: () => createMockModel({
      response: 'This is a test response',
      streaming: true,
    }),
  }));
});

test('POST /api/sessions/:id/messages streams AI response', async () => {
  // Create session first
  const session = await apiRequest('POST', '/api/sessions', {
    token: authToken,
    workspaceId: testWorkspace.id,
  });

  const res = await fetch(`http://localhost:4001/api/sessions/${session.data.id}/messages`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${authToken}`,
      'X-Workspace-Id': testWorkspace.id,
    },
    body: JSON.stringify({ content: 'Hello!' }),
  });

  expect(res.status).toBe(200);
  expect(res.headers.get('content-type')).toContain('text/event-stream');

  // Read SSE events
  const reader = res.body!.getReader();
  const events: string[] = [];

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    events.push(new TextDecoder().decode(value));
  }

  // Verify we got text-delta and done events
  const allText = events.join('');
  expect(allText).toContain('text-delta');
  expect(allText).toContain('done');
});
```

---

## Test Supabase Instance Setup

### 1. Create Test Config

```bash
mkdir -p supabase-test
cd supabase-test
supabase init
```

### 2. Edit `supabase-test/supabase/config.toml`

```toml
project_id = "claude-agent-server-test"

[api]
port = 55321

[db]
port = 55322
shadow_port = 55320

[studio]
port = 55323

[inbucket]
port = 55324
```

### 3. Symlink Migrations

```bash
# Share migrations between dev and test
ln -s ../supabase/migrations supabase-test/supabase/migrations
```

### 4. Start Test Instance

```bash
cd supabase-test && supabase start
```

### 5. Environment Variables

```env
# .env.test
TEST_SUPABASE_URL=http://127.0.0.1:55321
TEST_SUPABASE_ANON_KEY=<from supabase status>
TEST_SUPABASE_SERVICE_KEY=<from supabase status>
TEST_DATABASE_URL=postgresql://postgres:postgres@127.0.0.1:55322/postgres
```

---

## Package.json Scripts

```json
{
  "scripts": {
    "test": "bun test",
    "test:server": "cd packages/server && bun test",
    "test:db:start": "cd supabase-test && supabase start",
    "test:db:stop": "cd supabase-test && supabase stop",
    "test:db:reset": "cd supabase-test && supabase db reset"
  }
}
```

---

## What We're NOT Testing

1. **Unit tests for individual functions** - Not investing here per your preference
2. **Supabase Auth internals** - Trust the library works
3. **AI model responses** - Deterministic via mocks
4. **WebSocket Yjs sync** - Could add later if needed, but complex to test

---

## Implementation Order

1. **Phase 1: Infrastructure**
   - [x] Create test Supabase instance config
   - [x] Create `reset_agent_tables()` SQL function
   - [x] Create test setup/helpers
   - [x] Configure bun test

2. **Phase 2: Session Tests**
   - [x] CRUD operations
   - [x] Pagination/cursor
   - [x] RLS enforcement

3. **Phase 3: Message Tests**
   - [x] Message creation
   - [x] SSE streaming
   - [x] AI model mocking
   - [x] Tool execution (partial - mock emits tool-call events, full execution requires real AI)

4. **Phase 4: Document Tests**
   - [x] CRUD operations (API endpoints)
   - [x] Markdown conversion (content roundtrips)
   - [x] AI tool integration (verify tool-call events emitted via mocked agent)
   - [x] Direct tool function tests (call createDocumentTools() functions directly to verify side effects)

---

## Open Questions

1. **Model injection**: Currently `getModel()` is called directly in routes. We could:
   - Mock the module (shown above)
   - Pass model as dependency injection
   - Use a factory pattern with test override

2. **Test parallelism**: With table truncation, tests must run serially. Options:
   - Accept serial execution (fine for now)
   - Use unique data per test (Supabase's recommendation)
   - Use schema isolation (complex)

3. **CI setup**: Need to decide if we spin up Supabase in CI or use a hosted test project.
