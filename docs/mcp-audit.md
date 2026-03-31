# MCP Tools — Backend Audit

_Last updated: 2026-03-30 | Ref: issue #58_

## Summary

- **17 tools** across 8 files
- **5 tools** still routed through n8n (Gmail, Calendar, Docs, email channel in send_notification, Slack/Discord fallback)
- **12 tools** are fully direct (no n8n dependency)
- **1 lib module** also uses n8n outside of MCP tools: `lib/prewake.ts`

---

## Tool-by-Tool Audit

| Tool | File | Backend | n8n Endpoint(s) | Env Deps | Migration Status | Risk |
|---|---|---|---|---|---|---|
| `send_message` | messaging.ts | Direct (Telegram lib) | — | `TELEGRAM_BOT_TOKEN`, `TELEGRAM_CHAT_ID` | done | low |
| `send_notification` (whatsapp/sms/telegram/desktop/dialog) | messaging.ts | Direct (Twilio, telegram lib, notify lib) | — | `TWILIO_*`, `TELEGRAM_BOT_TOKEN` | done | low |
| `send_notification` (email) | messaging.ts | **n8n** | `gmail` (action: send) | `N8N_URL` | not-started | medium |
| `send_notification` (slack/discord) | messaging.ts | **n8n** | `notify` | `N8N_URL` | not-started | medium |
| `list_scheduled_tasks` | schedule.ts | Direct (local storage) | — | — | done | low |
| `add_scheduled_task` | schedule.ts | Direct (local storage) | — | — | done | low |
| `remove_scheduled_task` | schedule.ts | Direct (local storage) | — | — | done | low |
| `save_location` | location.ts | Direct (local storage) | — | — | done | low |
| `list_locations` | location.ts | Direct (local storage) | — | — | done | low |
| `save_reminder` | location.ts | Direct (local storage) | — | — | done | low |
| `list_reminders` | location.ts | Direct (local storage) | — | — | done | low |
| `mark_reminder_fired` | location.ts | Direct (local storage) | — | — | done | low |
| `manage_emails` | email.ts | **n8n** | `gmail` (get, batch, archive, trash, markAsRead, addLabel, removeLabel) | `N8N_URL` | not-started | high |
| `manage_calendar` | calendar.ts | **n8n** | `calendar` (get, create, update, delete) | `N8N_URL` | not-started | high |
| `manage_docs` | docs.ts | **n8n** | `docs` (create) | `N8N_URL` | not-started | medium |
| `generate_image` | docs.ts | Direct (Gemini/Imagen) | — | `GOOGLE_GENERATIVE_AI_API_KEY` | done | low |
| `proactive_history` | proactive.ts | Direct (lib/proactive) | — | — | done | low |
| `record_intervention` | proactive.ts | Direct (lib/proactive) | — | — | done | low |
| `get_activity` | activity.ts | Direct (lib/activity) | — | — | done | low |

---

## n8n Workflows Still in Use

| n8n Endpoint | Used By | What It Does | Direct API Replacement |
|---|---|---|---|
| `gmail` (read) | `manage_emails` (get), `lib/prewake.ts` | Fetch recent Gmail messages | Gmail REST API (`users.messages.list` + `users.messages.get`) |
| `gmail` (write) | `manage_emails` (archive/trash/markAsRead/label), `send_notification` (email) | Modify Gmail messages, send email | Gmail REST API (`users.messages.modify`, `users.messages.send`) |
| `calendar` (read) | `manage_calendar` (get), `lib/prewake.ts` | Fetch Google Calendar events | Google Calendar API (`events.list`) |
| `calendar` (write) | `manage_calendar` (create/update/delete) | Create/edit/delete events | Google Calendar API (`events.insert/patch/delete`) |
| `notify` | `send_notification` (slack/discord) | Fan-out notification routing | Slack Web API / Discord webhooks (direct) |
| `docs` | `manage_docs` | Create Google Doc | Google Docs API (`documents.create`) + Drive API (`files.update` for folder) |

---

## Non-MCP n8n Usage

| File | n8n Calls | Purpose |
|---|---|---|
| `lib/prewake.ts` | `calendar` (read), `gmail` (read) | Pre-warm context before dispatching morning brief |

---

## Migration Priority (for issue #59)

1. **`manage_emails`** — highest value, most-used tool. Gmail REST API is well-documented. Risk: high (touches real email). Need OAuth token refresh logic.
2. **`manage_calendar`** — second most-used tool, same Google auth story as Gmail. Risk: high (modifies real calendar).
3. **`lib/prewake.ts`** — blocked on Gmail/Calendar migration above; can be updated in the same PR.
4. **`manage_docs`** — less critical, straightforward Google Docs API. Risk: medium.
5. **`send_notification` (email)** — minor: can share Gmail auth layer once `manage_emails` is migrated.
6. **`send_notification` (slack/discord)** — low usage; direct webhooks are simple. Risk: low.

---

## Dead Code / Quick Wins (no migration needed)

None found. All n8n-dependent code paths are actively used. No unused imports or unreachable branches detected.

The `n8nPost` helper in `lib/n8n-client.ts` has one quirk worth noting: it special-cases n8n's `"No item to return"` 500 response as a successful empty result (line 22). Any direct-API replacement must handle the empty-result case explicitly in the tool handler instead.
