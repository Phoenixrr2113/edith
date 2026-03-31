# Direct Function Exposure — Evaluation

**Issue:** MCP-DIRECT-060
**Question:** Should `lib/` functions be called directly in some cases, or should everything route through MCP tools?

---

## Current Architecture

Every external API call (Gmail, GCal, Telegram, Docs) routes through MCP tools in `mcp/tools/*.ts`. Claude receives a tool call, the MCP server handles it, and the result comes back as a tool response. The underlying transport is always:

```
Claude (SDK) → MCP tool → lib/n8n-client.ts → n8n webhook → Google API
```

There is already one exception: `lib/prewake.ts` calls `n8nPost()` directly before Claude wakes up, bypassing the MCP layer entirely.

---

## Tool-to-lib Mapping

### Pure n8n wrappers (no lib abstraction layer yet)

| MCP Tool | What it does | Direct path available? |
|---|---|---|
| `manage_calendar` | `n8nPost("calendar", ...)` | Yes — `n8nPost` is `lib/n8n-client.ts` |
| `manage_emails` | `n8nPost("gmail", ...)` | Yes — same |
| `manage_docs` | `n8nPost("docs", ...)` | Yes — same |
| `send_notification` (email channel) | `n8nPost("gmail", {action:"send"})` | Yes |

### Tools wrapping local lib functions directly

| MCP Tool | lib functions called | Notes |
|---|---|---|
| `send_message` | `lib/telegram.sendMessage`, `sendPhoto`, `tgCall` | Thin wrapper + auth check |
| `send_notification` (Telegram/WA/SMS) | `lib/telegram.sendMessage`, `lib/twilio.sendTwilio` | Auth + routing only |
| `generate_image` | `lib/gemini.generateImages` | Single-call wrapper |
| `get_activity` | `lib/activity.readActivity`, `getRecentActivity` | Pass-through |
| `proactive_history` | `lib/proactive.getInterventionHistory` | Pass-through |
| `record_intervention` | `lib/proactive.canIntervene`, `recordIntervention` | Adds rate-limit guard |
| `list_scheduled_tasks` / `add` / `remove` | `lib/storage.loadSchedule`, `saveSchedule` | Pass-through |
| `save_location` / `list_locations` | `lib/storage.loadLocations`, `saveLocations` | Pass-through |
| `save_reminder` / `list_reminders` / `mark_reminder_fired` | `lib/storage.loadReminders`, `saveReminders` | Pass-through |

---

## Where Direct Calls Already Happen

`lib/prewake.ts` is the only non-Claude caller of Google APIs. It calls `n8nPost("calendar")` and `n8nPost("gmail")` directly to pre-load context before waking Claude. This pattern works correctly and has no observable downside — no logging gap, no auth issue, faster by ~1 round-trip turn.

`lib/handlers.ts` calls `lib/geo.ts` functions and `lib/proactive.canIntervene` directly — no MCP involved — before deciding whether to dispatch to Claude at all.

`lib/dispatch.ts` calls `lib/telegram.sendTyping` directly (fire-and-forget, not a tool call).

---

## Evaluation: When Direct Calls Make Sense

### Case 1: Pre-wake / context gathering (RECOMMENDED — direct)

**Scenario:** `lib/briefs/scheduled.ts` builds the morning/midday/evening brief prompt. It currently relies on Claude to call `manage_calendar` and `manage_emails` as tool turns.

**Benefit of going direct:** Each tool call Claude makes costs one full LLM turn (~2–5s). Pre-loading calendar + email data into the prompt before Claude starts eliminates 2 tool turns per brief. For a 10-turn brief that's a 20% reduction.

**Pattern:** Same as `prewake.ts` — call `n8nPost(...)` in `buildFullBrief()` / `buildMiddayBrief()`, inject the data as `### Calendar` and `### Recent Emails` sections.

**Risk:** Low. The data is read-only. If n8n is down, the brief runs without it (Claude will still call the tool).

### Case 2: Reminder/schedule read access (OK — direct, already works)

`lib/geo.ts` already reads `loadReminders()` and `loadLocations()` directly. `lib/scheduler.ts` reads `loadSchedule()` directly. This is the right pattern — local file reads don't need Claude involvement.

**No change needed here.**

### Case 3: Write operations triggered by Claude (KEEP in MCP)

Actions like `manage_calendar create`, `manage_emails archive`, `send_message` must go through MCP tools. Reasons:

- **Observability:** `logEvent()` calls in the tool handlers write to BetterStack. Direct calls would skip this.
- **Auth enforcement:** `send_message` enforces `ALLOWED_CHAT` whitelist. Direct calls bypass it.
- **Intent clarity:** Claude deciding to archive an email is a semantic decision. The tool call makes that intent explicit and auditable.
- **Rate limiting:** `record_intervention` includes `canIntervene()` — a guard that prevents spam. This only works if Claude goes through the tool.

### Case 4: Tauri app / web dashboard (future — direct HTTP API)

If a Tauri desktop app or web dashboard needs to display calendar events or email summaries, it should NOT spawn a Claude process and call MCP tools. Instead, expose a thin HTTP API (e.g. `lib/api-server.ts`) that calls `n8nPost(...)` and local lib functions directly.

**Pattern:**
```
Tauri / Browser → HTTP GET /api/calendar → lib/n8n-client.n8nPost → n8n
```

This is faster (no LLM turn), deterministic, and works offline when n8n is local.

### Case 5: CLI / scheduled tasks calling lib functions (direct, no SDK)

Scheduled tasks in `edith.ts` currently invoke Claude via `dispatchToClaude()` for everything. Some tasks could be pure data operations that don't need Claude at all:

- Check if a reminder is due → read `loadReminders()` directly → send Telegram message via `sendMessage()` directly
- This is already done in `lib/geo.ts` / `check-reminders` skill

**No architecture change needed — the pattern is already established.**

---

## Recommendation

| Operation | Pattern | Rationale |
|---|---|---|
| Pre-brief context (calendar, email read) | Direct `n8nPost()` in brief builders | Saves 2 tool turns per brief; prewake.ts already does this |
| Local state reads (reminders, locations, schedule) | Direct `lib/storage.*` | Already done; no reason to go through MCP |
| All write/send operations (email, calendar create, Telegram) | Always MCP | Needs logging, auth, rate limiting |
| Tauri/dashboard data display | HTTP API over lib/ | Never through Claude SDK |
| CLI one-shot scripts | Direct lib imports | Import and call; MCP transport adds no value |

### Specific call sites to add direct reads

1. `lib/briefs/scheduled.ts` → `buildFullBrief()` and `buildMiddayBrief()` — inject calendar + email using `gatherPrewakeContext()` (already written in `prewake.ts`; just reuse it)
2. Any future `lib/api-server.ts` or Tauri IPC handler — import from `lib/n8n-client`, `lib/storage`, `lib/activity` directly

### What NOT to change

- `manage_calendar` create/update/delete — stays in MCP
- `send_message` / `send_notification` — stays in MCP
- `manage_emails` archive/trash — stays in MCP
- `record_intervention` — stays in MCP (rate-limiting guard must run)

---

## Summary

The MCP layer is correct for Claude-driven actions. The gap is context gathering before Claude runs: briefs currently "waste" tool turns fetching data Claude could have received in its initial prompt. The fix is to extend the existing `prewake.ts` pattern into `lib/briefs/scheduled.ts`. Everything else is already correctly routed.
