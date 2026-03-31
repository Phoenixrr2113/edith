# Direct Function Exposure — Architecture Note

**Issue:** MCP-DIRECT-060
**Status:** Resolved — n8n removed, all Google APIs are now direct.

---

## Current Architecture

Every external API call (Gmail, GCal, Telegram, Docs) routes through MCP tools in `mcp/tools/*.ts` which call `lib/` functions directly. The transport is:

```
Claude (SDK) → MCP tool → lib/g*.ts → Google REST API
```

`lib/prewake.ts` calls `lib/gcal.ts` and `lib/gmail.ts` directly before Claude wakes up, bypassing the MCP layer to pre-load context.

---

## Tool-to-lib Mapping

### Google API wrappers

| MCP Tool | lib functions called |
|---|---|
| `manage_calendar` | `lib/gcal.getEvents`, `createEvent`, `updateEvent`, `deleteEvent` |
| `manage_emails` | `lib/gmail.getEmails`, `archiveEmail`, `trashEmail`, etc. |
| `manage_docs` | `lib/gdocs.createDoc` |
| `send_notification` (email) | `lib/gmail.sendEmail` |

### Tools wrapping local lib functions

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

## When Direct Calls Make Sense

| Operation | Pattern | Rationale |
|---|---|---|
| Pre-brief context (calendar, email read) | Direct `lib/gcal/gmail` in brief builders | Saves 2 tool turns per brief; prewake.ts already does this |
| Local state reads (reminders, locations, schedule) | Direct `lib/storage.*` | Already done; no reason to go through MCP |
| All write/send operations (email, calendar create, Telegram) | Always MCP | Needs logging, auth, rate limiting |
| Dashboard data display | Direct `lib/` imports in dashboard.ts | Never through Claude SDK |
| CLI one-shot scripts | Direct lib imports | MCP transport adds no value |
