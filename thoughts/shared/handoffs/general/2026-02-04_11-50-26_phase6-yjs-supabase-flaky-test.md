---
date: 2026-02-04T11:50:26-0500
researcher: claude-opus-4-5
git_commit: 3990f0e58c2e54bc7205a8b45a25732468ffc4a8
branch: main
repository: claude-agent-server
topic: "Phase 6 Yjs Document Collaboration (Supabase-backed) - Flaky Test Fix"
tags: [implementation, phase-6, yjs, supabase, documents, flaky-test]
status: in_progress
last_updated: 2026-02-04
last_updated_by: claude-opus-4-5
type: implementation_strategy
---

# Handoff: Phase 6 Yjs Supabase Migration - Flaky Agent Tool Test

## Task(s)

**Phase 6 of `thoughts/shared/plans/2026-02-04-multitenant-agent-server.md`** — Migrate Yjs document storage from local SQLite to Supabase Postgres.

| Task | Status |
|------|--------|
| Rewrite document-manager.ts to use Supabase via withRLS | ✅ Completed |
| Add WebSocket JWT auth in ws/yjs.ts | ✅ Completed |
| Remove SQLite dependency (db.ts, const.ts) | ✅ Completed |
| Update routes/documents.ts, tools/document-tools.ts for async API | ✅ Completed |
| Harden withRLS to re-throw on rollback | ✅ Completed |
| Write test-phase6.ts integration test | ✅ Completed |
| Fix flaky "Agent Tools Full Cycle" doc_edit test | 🔧 Work in progress |

## Critical References

- `thoughts/shared/plans/2026-02-04-multitenant-agent-server.md:1760-1803` — Phase 6 spec
- `packages/server/document-manager.ts` — Core file, complete rewrite for Supabase
- `packages/server/test-phase6.ts` — Integration test script

## Recent changes

- `packages/server/test-phase6.ts:566-580` — Added pre-edit content verification step before the `doc_edit` agent call. This reads the document via REST API first and waits if content doesn't match expected, guarding against hot-reload cache clearing.

## Learnings

1. **Flaky doc_edit in Agent Tools Full Cycle**: The test passes ~2/3 of the time. The `doc_edit` tool sometimes returns `{"success":false,"error":"old_text not found in document"}` even though the document was just created with content containing "Original Title". Root cause is likely `bun --hot` reloading the server mid-test, which clears the in-memory `docs` Map in `document-manager.ts:62`. When `getDoc()` then reloads from DB, the markdown round-trip (Yjs binary → XmlFragment → ProseMirror JSON → markdown) may produce slightly different output.

2. **`bun --hot` clears module state**: The `docs` Map, `persistTimers` Map, and all module-level objects (schema, markdownManager) are re-instantiated on hot reload. The DB has the correct yjs_state from the initial INSERT, but reloading and re-serializing may not be perfectly idempotent.

3. **ECONNRESET from hot reload**: One test run failed with `ECONNRESET` during a fetch — the hot reload dropped the connection mid-request. This is a separate failure mode from the doc_edit issue.

4. **Yjs dual-import issue**: Using `require()` and `import` for Yjs/TipTap in the same process causes "Yjs was already imported" errors. Always use top-level ES module imports (fixed earlier in the session).

5. **LLM non-determinism in tool tests**: The Agent Tools Full Cycle uses fresh LLM sessions per tool call to prevent the LLM from answering from memory instead of calling tools. System prompt `TOOL_SYSTEM_PROMPT` at `test-phase6.ts:491` forces tool usage.

6. **Supabase admin client can't query BYTEA columns**: `.select('id, yjs_state').single()` fails. Workaround: query non-binary columns separately and use `.not('yjs_state', 'is', null)` for existence checks.

## Artifacts

- `packages/server/document-manager.ts` — Complete rewrite (all functions async, withRLS, debounced persist)
- `packages/server/ws/yjs.ts` — WebSocket JWT auth added
- `packages/server/yjs-sync.ts` — Async handling, expanded YjsWSData type
- `packages/server/routes/documents.ts` — Async API calls
- `packages/server/tools/document-tools.ts` — Async API calls
- `packages/server/lib/db.ts:26-41` — Hardened withRLS with try/catch re-throw
- `packages/server/test-phase6.ts` — Full integration test
- `thoughts/shared/plans/2026-02-04-multitenant-agent-server.md:1792-1794` — Automated verification checkboxes checked

Files deleted: `packages/server/db.ts`, `packages/server/const.ts`, `packages/server/document-tools.ts` (old SDK), `packages/server/document-manager.test.ts`, `packages/server/document-tools.test.ts`, `packages/server/yjs-sync.test.ts`

## Action Items & Next Steps

1. **Fix the flaky doc_edit test** — The pre-edit verification step was just added at `test-phase6.ts:570-576` but hasn't been tested yet. Options to fully fix:
   - Run the server without `--hot` during tests (most reliable)
   - Add retry logic around the doc_edit agent call
   - Debug the exact markdown round-trip difference when loading from DB (add logging in `editDoc` at `document-manager.ts:216-217` to print `content` before `indexOf`)
   - Consider whether the markdown round-trip is truly idempotent — test `markdownToJSON → populateFragment → fragmentToMarkdown` round-trip in isolation

2. **Run test-phase6.ts 3+ times to confirm stability** after fixing

3. **Manual verification items** (plan lines 1797-1801) — require the client editor UI which doesn't exist yet. Three of five are covered by the test:
   - `[x]` Yjs state persists to Supabase
   - `[x]` WebSocket rejects unauthenticated connections
   - `[ ]` Create a document via API, open it in the client editor (needs client)
   - `[ ]` Edit in real-time with two clients connected (needs client)
   - `[ ]` Agent tool edits appear in real-time in connected editors (needs client)

4. **Commit Phase 6 changes** — All code changes are uncommitted. Run `git status` to see the full diff.

## Other Notes

- Server runs on port 4000: `bun --hot packages/server/index.ts` (pid may vary)
- Test user: `cdavies@shopped.com` / `password123`, userId `11111111-1111-1111-1111-111111111111`, workspaceId `e5c7bfe4-737e-4d72-8344-8d2c0c1404a8`
- The `debouncedPersist` in document-manager.ts uses a 500ms timer. Tests use `waitForSync(300-1000)` to account for this.
- `test-phase5.ts` still passes against the new code (backward compatible)
- Dead code exists: `packages/server/message-handler.ts` and `packages/server/message-types.ts` reference `@anthropic-ai/claude-agent-sdk` but aren't imported by index.ts
