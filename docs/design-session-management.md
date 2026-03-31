# Session Management: Cloud-Ready Design

**Issue:** CLOUD-SESSION-044
**Status:** Implemented
**Depends on:** #45 (CLOUD-SQLITE-045 — SQLite persistence layer)
**Blocks:** #43 (CLOUD-FLY-043 — cloud deploy)

---

## Overview

Edith's session model tracks two distinct concepts:

1. **Agent SDK session ID** — a string issued by the Claude Agent SDK. Stored in SQLite. Survives across Fly.io redeploys when a persistent volume is attached. Enables `resume=` on query() to continue prior conversation context.

2. **Active query handle** — an in-memory `Query` object from the Agent SDK. Lives only for the duration of one `dispatchToClaude()` call. Always `null` after any restart or redeploy (this is correct and expected).

These two concepts are intentionally separate. The session ID provides continuity across boots; the active query handle provides message injection into a currently-running dispatch.

---

## Architecture

```
edith.ts (boot)
  └─ loadSessionId()         ← reads from SQLite sessions table
       └─ sessionId: string  ← "" if no prior session

dispatchToClaude(prompt, { resume: true })
  └─ buildSdkOptions()
       └─ if sessionId:  sdkOptions.resume = sessionId   ← resume prior session
       └─ if !sessionId: new session created automatically

processMessageStream()
  └─ message.session_id → setActiveSessionId(id)   ← tracks current SDK session
  └─ on completion:      saveSession(newSessionId)  ← persists to SQLite
  └─ on error (corrupted): clearSession()           ← clears SQLite, forces new session

injectMessage(text)
  └─ activeQuery.streamInput()  ← in-memory only, null after redeploy
```

---

## Session Lifecycle

### Cold Start (no prior session)

1. `openDatabase()` — sessions table empty
2. `sessionId = ""` (module-level in `state.ts`)
3. `buildSdkOptions()` — no `resume` field set, Agent SDK creates new session
4. On first message: `session_id` arrives in stream → `saveSession(id)` → SQLite
5. Next boot: session ID found in SQLite, session resumed

### Warm Start (session in SQLite, Agent SDK session still valid)

1. `openDatabase()` — `sessions WHERE key = 'session_id'` → row found
2. `sessionId = "<prior-id>"`
3. `buildSdkOptions()` → `sdkOptions.resume = sessionId`
4. Agent SDK resumes conversation context, no bootstrap brief needed

### Warm Start (session expired on Agent SDK side)

1. Session ID loaded from SQLite, passed as `resume=`
2. Agent SDK returns `is_error: true, subtype: "error_during_execution"`
3. `processMessageStream()` detects this: `clearSession()` + `needsRetry = true`
4. `dispatchToClaude()` re-queues the job with `_sessionRetried: true`
5. Second attempt has no session ID → new session created → proceeds normally

### Redeploy on Fly.io

- **With persistent volume** (`[mounts] source = "edith_data", destination = "/root/.edith"`): SQLite DB persists across redeploys. Session survives.
- **Without volume** (ephemeral FS): SQLite is lost on redeploy. Cold start on every deploy. The boot brief runs, establishing a new session. This is safe — Edith will re-orient from the taskboard and Cognee.

**Recommendation:** Use a persistent volume. It's one line in `fly.toml` and avoids the boot brief on every deploy.

```toml
# fly.toml
[[mounts]]
  source      = "edith_data"
  destination = "/root/.edith"
```

---

## activeQuery: Always In-Memory

`activeQuery` (the `Query` handle from Agent SDK) is **never persisted**. It is:

- Set in `setActiveQuery(q)` when dispatch starts
- Cleared in `setActiveQuery(null)` when dispatch ends or errors
- Always `null` after any restart or redeploy

This is correct. The active query handle is an ephemeral stream handle — it cannot survive a process restart. `injectMessage()` checks for `null` and returns `false` gracefully if no session is running.

---

## User Isolation (Multi-User)

The current design is single-user (Randy only). The sessions table uses a `key/value` schema that can be extended for multi-user without schema changes:

```sql
-- Current (single user)
INSERT OR REPLACE INTO sessions (key, value) VALUES ('session_id', '<id>');

-- Future multi-user: key = "session:<userId>"
INSERT OR REPLACE INTO sessions (key, value) VALUES ('session:u_123', '<id>');
```

When multi-user support is needed (CLOUD-USERS-*), `saveSession` / `clearSession` / `sessionId` loading should accept an optional `userId` parameter that namespaces the key.

---

## Device-to-Cloud Session Handoff

When a device (Tauri app) connects via WebSocket (see `docs/design-websocket-protocol.md`), it does not manage session IDs directly. The cloud always owns the session:

```
Device                          Cloud (edith.ts)
  │─── WsInputMessage ────────→ │
  │                             │ injectMessage() if session active
  │                             │    └─ activeQuery.streamInput()
  │                             │ dispatchToClaude() if no active session
  │                             │    └─ resume: sessionId from SQLite
  │←── WsTextMessage ──────────  │
```

The device never sees or stores a session ID. Session continuity is invisible to the device layer — it always just sends input and receives output.

---

## SQLite Schema

Session IDs are stored in the existing `sessions` table (created in `lib/db.ts`):

```sql
CREATE TABLE IF NOT EXISTS sessions (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
```

Access pattern: single row with `key = 'session_id'`.

`saveSession()`, `clearSession()`, and the startup load in `state.ts` all use this table. File fallback (`~/.edith/session-id`) is kept for backward compatibility.

---

## Session Corruption Retry

The retry path is already implemented in `lib/dispatch.ts`. When an Agent SDK call returns `is_error: true` with `subtype: "error_during_execution"`:

1. `clearSession()` is called — removes the stale session ID from SQLite
2. `needsRetry = true` is returned from `processMessageStream()`
3. `dispatchToClaude()` re-queues the job with `{ _sessionRetried: true }` to prevent infinite retry loops
4. On the retry, no session ID exists → Agent SDK creates a new session → proceeds normally

This logic works identically in cloud and local contexts.

---

## Session Type Interfaces

See `lib/session.ts` for the full interface. Key exports:

| Export | Type | Description |
|---|---|---|
| `setActiveQuery(q)` | `(Query \| null) → void` | Set/clear the in-memory active query |
| `getActiveQuery()` | `() → Query \| null` | Get current active query |
| `setActiveSessionId(id)` | `(string) → void` | Track current SDK session ID |
| `getActiveSessionId()` | `() → string` | Read current session ID |
| `isSessionRunning()` | `() → boolean` | True if a dispatch is in progress |
| `injectMessage(text, chatId?)` | `async (string, number?) → boolean` | Inject into active session |

Session persistence (`saveSession`, `clearSession`, `sessionId`) lives in `lib/state.ts` as it is part of the shared mutable state loaded at boot.

---

## Files

| File | Role |
|---|---|
| `docs/design-session-management.md` | This document |
| `lib/session.ts` | In-memory active query + inject. Cloud-safe (no file I/O). |
| `lib/state.ts` | `saveSession` / `clearSession` / `sessionId` — SQLite-backed with file fallback |
| `lib/db.ts` | SQLite schema — `sessions` table |
| `lib/dispatch.ts` | Session retry logic, `buildSdkOptions`, `processMessageStream` |
