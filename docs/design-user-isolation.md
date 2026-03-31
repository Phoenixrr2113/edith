# Per-User State Isolation in Cloud DB

**Issue:** #86
**Status:** Design

---

## Problem

The cloud server currently operates as a single-user system. All state (conversation history, taskboard, sync payloads, scheduled tasks, memory) lives in shared tables with no user-scoping. Adding multi-user support requires every table to be owned by a specific user and access to be enforced at the query layer.

---

## Schema Design

### Core principle

Every mutable record is tagged with a `user_id` (UUID). All queries include `WHERE user_id = ?`. No cross-user reads are possible at the application layer.

### SQLite (single-server / self-hosted)

```sql
-- Users table
CREATE TABLE users (
  id          TEXT PRIMARY KEY,          -- UUID v4
  email       TEXT UNIQUE NOT NULL,
  display_name TEXT,
  created_at  INTEGER NOT NULL,          -- unix ms
  plan        TEXT NOT NULL DEFAULT 'free'  -- 'free' | 'pro' | 'team'
);

-- Device registrations (one user can have many devices)
CREATE TABLE devices (
  id          TEXT PRIMARY KEY,          -- UUID v4
  user_id     TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name        TEXT,                      -- "Randy's MacBook"
  token_hash  TEXT NOT NULL,             -- bcrypt hash of device token
  last_seen   INTEGER,
  created_at  INTEGER NOT NULL
);
CREATE INDEX idx_devices_user ON devices(user_id);

-- Conversation / message history
CREATE TABLE messages (
  id          TEXT PRIMARY KEY,
  user_id     TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  device_id   TEXT REFERENCES devices(id),
  role        TEXT NOT NULL,             -- 'user' | 'assistant' | 'tool'
  content     TEXT NOT NULL,
  created_at  INTEGER NOT NULL
);
CREATE INDEX idx_messages_user_ts ON messages(user_id, created_at DESC);

-- Taskboard (transient daily state)
CREATE TABLE taskboard (
  user_id     TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  content     TEXT NOT NULL DEFAULT '',
  updated_at  INTEGER NOT NULL
);

-- Scheduled tasks
CREATE TABLE scheduled_tasks (
  id          TEXT PRIMARY KEY,
  user_id     TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  label       TEXT NOT NULL,
  cron        TEXT NOT NULL,
  next_fire   INTEGER,
  enabled     INTEGER NOT NULL DEFAULT 1,
  created_at  INTEGER NOT NULL
);
CREATE INDEX idx_tasks_user ON scheduled_tasks(user_id);

-- Reminders
CREATE TABLE reminders (
  id          TEXT PRIMARY KEY,
  user_id     TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  text        TEXT NOT NULL,
  fire_at     INTEGER NOT NULL,
  fired       INTEGER NOT NULL DEFAULT 0,
  created_at  INTEGER NOT NULL
);
CREATE INDEX idx_reminders_user_fire ON reminders(user_id, fire_at);

-- Sync snapshots (last sync payload per device)
CREATE TABLE sync_snapshots (
  device_id   TEXT PRIMARY KEY REFERENCES devices(id) ON DELETE CASCADE,
  user_id     TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  payload     TEXT NOT NULL,             -- JSON
  synced_at   INTEGER NOT NULL
);
```

### Postgres (multi-tenant / Railway)

Same schema with Postgres types:

- `TEXT PRIMARY KEY` → `UUID PRIMARY KEY DEFAULT gen_random_uuid()`
- `INTEGER NOT NULL` (timestamps) → `BIGINT NOT NULL`
- Add `updated_at TIMESTAMPTZ DEFAULT now()` trigger on mutable tables
- Use `BIGSERIAL` for high-volume tables if UUID read performance is a concern

Row-level security (RLS) can be enabled as a defense-in-depth layer:

```sql
ALTER TABLE messages ENABLE ROW LEVEL SECURITY;
CREATE POLICY messages_user_policy ON messages
  USING (user_id = current_setting('app.current_user_id')::uuid);
```

The application sets `SET LOCAL app.current_user_id = '<id>'` at the start of each transaction.

---

## Access Patterns

| Operation | Query |
|-----------|-------|
| Load conversation | `SELECT * FROM messages WHERE user_id=? ORDER BY created_at DESC LIMIT 50` |
| Append message | `INSERT INTO messages (id,user_id,…) VALUES (…)` |
| Read taskboard | `SELECT content FROM taskboard WHERE user_id=?` |
| Write taskboard | `INSERT OR REPLACE INTO taskboard VALUES (?,?,?)` |
| List reminders due | `SELECT * FROM reminders WHERE user_id=? AND fire_at<=? AND fired=0` |

---

## Migration Strategy

1. Add `user_id` column (nullable) to all existing tables.
2. Create a `default_user` record and backfill `user_id = default_user.id`.
3. Apply NOT NULL constraint.
4. Create indexes.
5. Enable RLS if on Postgres.

No data loss; single-user deployments continue to work with one user row.

---

## Data Retention

- Messages: keep last 90 days per user (configurable per plan).
- Taskboard: overwritten daily; no retention needed.
- Reminders: purge `fired=1` records older than 7 days.
- Sync snapshots: one per device; overwritten on each sync.

A daily cron job runs `DELETE FROM messages WHERE user_id=? AND created_at < ?` per user based on their plan limits.
