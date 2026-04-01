# Edith State Consolidation Plan (COMPLETED)

**Date:** 2026-04-01
**Status:** ✅ Completed (April 2026)

## Problem

Edith's runtime state is scattered across 20+ files and directories in `packages/agent/.state/`. Half are dead (dashboard was deleted), several are legacy JSON fallbacks that already migrated to SQLite, and two near-identical entrypoints (`edith.ts` and `edith-cloud.ts`) duplicate 300+ lines of startup logic.

## Audit Summary

### Dead — delete immediately (code + files)

| File | Why dead | Size |
|------|----------|------|
| `backups/` | Old n8n database backups from migration era. No code references. | 64MB |
| `inbox/` | Written/read by dashboard IPC (`lib/ipc.ts:112-161`). Dashboard was deleted. Contains stale JPGs from Mar 27-29. | 336KB |
| `active-processes.json` | Written by `lib/state.ts:105-109` for dashboard display. Dashboard was deleted. | 2B |
| `edith.log` | Written by `edith.ts:22-49` console override. Always empty (0 bytes). Redundant with `launchd-stderr.log` and `events.jsonl`. | 0B |
| `edith.pid` | Defined in `lib/config.ts:16` but only written in `edith-cloud.ts:142`. Never read by any code. | — |

### Legacy fallbacks — delete files, remove fallback code

These were migrated to SQLite (`edith.db`) but the JSON files and fallback read paths still exist in `lib/storage.ts` and `lib/state.ts`.

| File | SQLite table | Fallback code location |
|------|-------------|----------------------|
| `schedule.json` | `schedule` | `lib/storage.ts:114` |
| `locations.json` | `locations` | `lib/storage.ts:166-198` |
| `reminders.json` | `reminders` | `lib/storage.ts:234-273` |
| `proactive-state.json` | `proactive_state` | `lib/proactive.ts` |
| `session-id` (file) | `sessions` | `lib/state.ts:52-55, 73-76` |
| `dead-letters.json` | `dead_letters` | `lib/state.ts:132-134, 153-158` |

### Never migrated to SQLite — migrate now

| File | Current storage | Proposed |
|------|----------------|----------|
| `schedule-state.json` | Flat JSON via `lib/scheduler.ts:16-22` | `kv_state` table in `edith.db` |
| `tg-offset` | Single int in plain text via `lib/state.ts:23,37-63` | `kv_state` table |
| `proactive-config.json` | JSON read by `lib/proactive.ts:74`, writer was the deleted dashboard | `kv_state` table |

### Active — keep as-is

| File | Purpose | Why filesystem is correct |
|------|---------|--------------------------|
| `edith.db` | All structured state (SQLite, WAL mode) | Single source of truth for config/state |
| `events.jsonl` | Local event log, BetterStack backup | Append-only, rotated at 1MB/48h |
| `taskboard.md` | Today's transient brief state | LLM-readable markdown, rotated daily |
| `taskboard-archive/` | Monthly markdown archives | Low volume, rarely read |
| `activity/` | Daily activity snapshots | Append-only markdown |
| `transcripts/` | Per-session JSONL conversation logs | Append-only, 1417 files (needs rotation) |
| `triggers/` | File-based IPC for cross-process signaling | Correct pattern — file existence = signal |
| `launchd-*.log` | System log capture | Managed by launchd, not our choice |
| `pending-knowledge/` | Cognee staging for audio extracts | Evaluate if audio-extract is still active; clean stale files |

## Architectural Decisions

### 1. Merge `edith.ts` and `edith-cloud.ts` into one file

**Why:** They share ~90% of their code (console override, imports, poll loop, bootstrap, shutdown, scheduler). The diff is:

- **Local-only:** `caffeinate`, pause flag shared with poll loop
- **Cloud-only:** HTTP health endpoint, WebSocket server, STATE_DIR override (currently broken), conditional Telegram polling

**How:** One `edith.ts` with `const isCloud = !!process.env.RAILWAY_ENVIRONMENT || process.env.CLOUD_MODE === "true"`. Guard local-only and cloud-only blocks behind this flag. Delete `edith-cloud.ts`. Update `Dockerfile` CMD to `["bun", "run", "edith.ts"]`.

### 2. State lives in project dir, Postgres for cloud

**Why `packages/agent/.state/` stays for local:**
- Survives git operations, reinstalls, branch switches
- SQLite is perfect for single-machine, single-process state
- No server dependency for a desktop agent
- Standard pattern for daemon state on macOS

**Why Postgres for cloud (not SQLite on a volume):**
- Railway containers are ephemeral — SQLite WAL can corrupt on container kill
- Railway has 1-click Postgres with automatic backups
- `DATABASE_URL` is auto-injected — zero config
- Shared state if we ever run multiple replicas
- Same SQL queries work for both SQLite and Postgres with minor dialect adjustments

**How:** Abstract `lib/db.ts` to return either SQLite or Postgres based on `DATABASE_URL` env var. Queries are already simple enough to be dialect-agnostic (INSERT OR REPLACE → ON CONFLICT DO UPDATE).

### 3. Add `kv_state` table to SQLite

Replaces `schedule-state.json`, `tg-offset`, and `proactive-config.json` — all "single value in a file" patterns.

```sql
CREATE TABLE IF NOT EXISTS kv_state (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL,
  updated_at TEXT DEFAULT (datetime('now'))
);
```

### 4. Add transcript rotation

1417 files in `transcripts/` and growing. Add age-based cleanup: delete transcripts older than 30 days during `rotateEvents()`.

### 5. Move state into the project dir

Moved from `packages/agent/.state/` to `packages/agent/.state/` (gitignored) because:
- The AI agent works inside the project dir and never checks `packages/agent/.state/` when debugging
- Hours of debugging issues were caused by stale/corrupt state the agent couldn't see
- Everything is now visible to the agent during troubleshooting
- `EDITH_STATE_DIR` env var allows override for cloud (`/data/.state`) or testing

## Target State

### `packages/agent/.state/` after cleanup (local)

```
packages/agent/.state/
├── edith.db                # ALL structured state
├── edith.db-shm
├── edith.db-wal
├── events.jsonl            # Local event log (BetterStack is primary)
├── taskboard.md            # Today's transient brief state
├── launchd-stderr.log      # System log capture
├── launchd-stdout.log
├── taskboard-archive/      # Monthly archives
├── activity/               # Daily activity markdown
├── transcripts/            # Per-session JSONL (with rotation)
└── triggers/               # File-based IPC signals
```

**11 items** (down from 25). **~65MB freed** from dead files.

### Cloud (Railway)

```
Railway Services:
├── edith         (Bun) ─── Postgres (DATABASE_URL)
├── cognee        (Python) ─ Postgres (shared or separate)
└── langfuse      (Docker) ─ Postgres (separate)
```

No volume mounts. No filesystem state. Everything in Postgres or BetterStack.

## Storage Architecture Summary

| Data type | Local | Cloud | Interface |
|-----------|-------|-------|-----------|
| Structured state (schedule, reminders, locations, sessions, dead letters, KV) | SQLite | Postgres | `lib/db.ts` |
| Event logs | `events.jsonl` + BetterStack | BetterStack only | `lib/edith-logger.ts` |
| Knowledge (people, decisions, patterns) | Cognee (local Docker) | Cognee (Railway service) | `mcp/cognee-direct.sh` |
| Transient briefs | `taskboard.md` (file) | Postgres table | New abstraction |
| Conversation transcripts | JSONL files | Postgres table | `lib/transcript.ts` |
| Activity logs | Daily markdown files | Postgres table | `lib/activity.ts` |
| IPC signals | File triggers | Not needed | `lib/ipc.ts` (local only) |

## Implementation Order

### Phase 1: Cleanup (no behavior changes)
1. Delete dead files on disk (`backups/`, `inbox/` contents, `active-processes.json`, `edith.log`, `edith.pid`)
2. Remove dead code: `processInbox()`, `sendIpc()`, `ActiveProcess`, `writeActiveProcesses()`, `INBOX_DIR`, `PID_FILE`
3. Remove inbox cleanup blocks from both `edith.ts` and `edith-cloud.ts`
4. Remove JSON fallback branches from `lib/storage.ts` and `lib/state.ts`
5. Delete legacy JSON files (`schedule.json`, `locations.json`, `reminders.json`, `proactive-state.json`, `session-id`, `dead-letters.json`)

### Phase 2: SQLite consolidation
1. Add `kv_state` table migration to `lib/db.ts`
2. Migrate `schedule-state.json` → `kv_state` (key: `schedule_state`, value: JSON)
3. Migrate `tg-offset` → `kv_state` (key: `tg_offset`, value: string int)
4. Migrate `proactive-config.json` → `kv_state` (key: `proactive_enabled`, value: `"true"/"false"`)
5. Add transcript rotation (30-day TTL)
6. Clean stale `pending-knowledge/` files

### Phase 3: Merge entrypoints
1. Merge `edith-cloud.ts` into `edith.ts` behind `isCloud` flag
2. Delete `edith-cloud.ts`
3. Update `Dockerfile` CMD
4. Fix STATE_DIR override to work before module imports (env var set in Dockerfile or Railway config, not at runtime)

### Phase 4: Postgres adapter (cloud-ready)
1. Abstract `lib/db.ts` to support both SQLite and Postgres via `DATABASE_URL` env var
2. Add Postgres table creation (same schema as SQLite migrations)
3. Move taskboard, transcripts, activity to Postgres tables in cloud mode
4. Skip filesystem state entirely when `isCloud`
5. Add Railway Postgres service to project

## What we're NOT doing

- **Not moving to Redis/MongoDB** — SQLite/Postgres covers everything, no need for another dependency
- **Not moving state to project dir** — `packages/agent/.state/` is correct for local, cloud uses Postgres
- **Not moving everything to Cognee/FalkorDB** — Cognee is for knowledge (fuzzy/semantic), not operational state (exact retrieval)
- **Not adding a migration framework** — the `db.ts` migration pattern (check table exists, migrate, mark done) is simple enough
