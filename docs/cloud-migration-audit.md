# Cloud Edith: Migration Audit & Proposed Fixes

## Architecture

Cloud Edith = **brain** (Telegram, scheduling, email, calendar, memory, dispatch)
Desktop companion = **body** (screen capture, notifications, computer-use, idle detection)

---

## Issue 1: MCP servers crash in cloud

**Current state:** `.mcp.json` loads ALL servers unconditionally via `loadMcpConfig()` in `dispatch-options.ts`.

**Servers in .mcp.json:**
| Server | Type | Cloud compatible? |
|--------|------|-------------------|
| `cognee` | bash wrapper → cognee-wrapper.sh | No — hardcoded path `/Users/randywilson/...` |
| `edith` | bash wrapper → mcp/start.sh | Maybe — needs verification |
| `computer-use` | npx computer-use-mcp | No — requires display server |
| `railway` | npx @railway/mcp-server | Yes |
| `betterstack` | remote MCP | Yes |

**Proposed fix:** Filter out cloud-incompatible MCP servers when `IS_CLOUD` is true.

**Questions:**
- Should cloud Edith use cognee via MCP or only via `cognee-direct.sh` (HTTP)?
- Should `edith` MCP server (tools like send_message, manage_calendar) work in cloud? It's the main tools server.
- Are there cloud-specific MCP servers we should add?

---

## Issue 2: macOS binaries called on Linux

### notify.ts
- `showNotification()` calls `terminal-notifier` — macOS only
- `showDialog()` calls `osascript` — macOS only
- `showAlert()` calls `osascript` — macOS only
- No platform guards, no try/catch

**Proposed fix:** Add `if (process.platform !== "darwin") return;` to each function.

**Questions:**
- Should cloud-side notifications just go through Telegram instead?
- Is there a cloud notification path that should replace these?

### screenpipe.ts
- `getSystemIdleSeconds()` calls `ioreg` — macOS only
- Already has try/catch, returns 0 on failure (safe)

**Proposed fix:** None needed — already handles gracefully.

### caffeinate.ts
- Already guarded by `!IS_CLOUD` check in edith.ts

**Proposed fix:** None needed.

---

## Issue 3: DEVICE_SECRET not set

**Current state:** Cloud WebSocket server requires `DEVICE_SECRET` env var for JWT auth. Without it, all desktop companion connections are rejected with `auth_device_secret_missing`.

**Proposed fix:** Generate and set secret on Railway.

**Questions:**
- Is the desktop companion app ready to connect to cloud? Or is this premature?
- Should we skip WS auth setup until the desktop app is closer to ready?

---

## Issue 4: Telegram webhook status

**Current state:** Webhook IS registered and working (Langfuse shows processed messages). The error was a stale session resume — cloud tried to resume a session ID that doesn't exist in the cloud context.

**Proposed fix:** Clear stale session in Neon DB, or let Edith start fresh.

**Questions:**
- Should cloud Edith always start fresh sessions (never resume)?
- Or should it resume from its own cloud session history?

---

## Issue 5: No persistent volume on Railway

**Current state:** File-based state is lost on every restart:
- `events.jsonl` — audit log
- `taskboard.md` — daily task state
- `transcripts/` — session transcripts
- `activity/` — daily activity logs

Database state (sessions, reminders, schedules, locations) persists in Neon Postgres.

**Proposed fix:** Create Railway volume mounted at `/data`.

**Questions:**
- Is it worth adding a volume? Or should events/taskboard/transcripts be considered ephemeral in cloud?
- Should we migrate events.jsonl to Postgres/BetterStack as the source of truth?
- Transcripts: do we need them persisted? They can be large (1400+ locally).

---

## Issue 6: cognee-wrapper.sh hardcoded path

**Current state:** Line 7: `COGNEE_DIR="/Users/randywilson/Desktop/edith-v3/cognee-repo/cognee-mcp"`

**Proposed fix:** Use relative path or env var: `COGNEE_DIR="${COGNEE_DIR:-$(dirname "$0")/../../cognee-repo/cognee-mcp}"`

**Questions:**
- Is the cognee MCP wrapper even needed anymore? Cloud uses `COGNEE_URL` (HTTP API via cognee-direct.sh). Local could too.
- Should we deprecate the MCP wrapper entirely in favor of cognee-direct.sh?

---

## Issue 7: Cloud-specific MCP tools

**Current state:** The `edith` MCP server provides 8 tool domains:
- `send_message` / `send_notification` — messaging
- `manage_calendar` — Google Calendar
- `manage_emails` — Gmail
- `list/add/remove_scheduled_task` — scheduling
- `get_activity` — activity logs
- Google Docs integration
- Log introspection

**Questions:**
- Do all of these work in cloud? They're API-based (Gmail, Calendar, Telegram) so they should.
- Is `send_notification` handling the cloud case properly? It supports channels: telegram, whatsapp, sms, email, desktop, dialog. Desktop/dialog channels will fail in cloud.
- Should `send_notification` auto-route to telegram when in cloud mode?

---

## Issue 8: Google OAuth in cloud

**Current state:** OAuth tokens are seeded from env vars (`GOOGLE_REFRESH_TOKEN`, `GOOGLE_REFRESH_TOKEN_2`) on startup via `seedTokensFromEnv()`. Tokens stored in Neon DB. Refresh logic uses `GOOGLE_CLIENT_ID` + `GOOGLE_CLIENT_SECRET`.

**Both are set in Railway env vars.**

**Questions:**
- Has this actually been tested? Does the cloud instance successfully refresh tokens and call Gmail/Calendar APIs?
- If the refresh token expires, is there a re-auth flow for cloud? (Normally requires browser OAuth consent)

---

## Issue 9: Scheduled tasks behavior in cloud

**Current state:** All scheduled tasks run in cloud (morning-brief, midday-check, evening-wrap, check-reminders, etc.). Langfuse shows them executing.

**Concerns:**
- Morning brief calls `manage_calendar`, `manage_emails` — do these work with cloud OAuth?
- Proactive checks call screenpipe — will silently skip (no context), but should they even run in cloud?
- Check-reminders needs location data — does cloud get location updates via Telegram?

**Questions:**
- Should proactive-check be disabled in cloud (it needs screen context)?
- Are there cloud-specific scheduled tasks that should exist?

---

## Issue 10: Desktop companion readiness

**Current state:** Desktop app (Tauri + Svelte) is ~40% complete:
- Screen capture: works (xcrun screencapture)
- Audio capture: scaffolded
- WebSocket to cloud: code exists but transport layer incomplete
- Computer-use: shell command execution works

**Questions:**
- What's the priority: get cloud brain fully working first, or work on brain+companion in parallel?
- What capabilities should the companion provide to the brain via WebSocket?
  - Screen context (replacing screenpipe)?
  - Desktop notifications?
  - Computer-use actions?
  - Location data?

---

## Summary: What needs to happen

| # | Item | Type | Effort |
|---|------|------|--------|
| 1 | Filter MCP servers for cloud | Code change | 15 min |
| 2 | Platform guards in notify.ts | Code change | 5 min |
| 3 | Set DEVICE_SECRET on Railway | Config | 2 min |
| 4 | Clear stale session | DB operation | 2 min |
| 5 | Railway volume for state | Dashboard config | 5 min |
| 6 | Fix cognee-wrapper.sh path | Code change | 2 min |
| 7 | Verify send_notification cloud routing | Investigation | 10 min |
| 8 | Test Google OAuth refresh in cloud | Investigation | 10 min |
| 9 | Disable proactive-check in cloud | Code change | 5 min |
| 10 | Desktop companion planning | Planning | TBD |
