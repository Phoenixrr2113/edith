# MCP Tools — Backend Audit

_Last updated: 2026-03-30 | Ref: issue #55 (n8n removal complete)_

## Summary

- **17 tools** across 8 files
- **All tools** are fully direct (no n8n dependency)
- n8n has been removed entirely (#50, #51, #52, #53, #55)

---

## Tool-by-Tool Audit

| Tool | File | Backend | Env Deps | Status |
|---|---|---|---|---|
| `send_message` | messaging.ts | Direct (Telegram lib) | `TELEGRAM_BOT_TOKEN`, `TELEGRAM_CHAT_ID` | done |
| `send_notification` (whatsapp/sms/telegram/desktop/dialog) | messaging.ts | Direct (Twilio, telegram lib, notify lib) | `TWILIO_*`, `TELEGRAM_BOT_TOKEN` | done |
| `send_notification` (email) | messaging.ts | Direct (Gmail lib) | `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, `GOOGLE_REFRESH_TOKEN` | done |
| `send_notification` (slack/discord) | messaging.ts | Not supported | — | not implemented |
| `list_scheduled_tasks` | schedule.ts | Direct (local storage) | — | done |
| `add_scheduled_task` | schedule.ts | Direct (local storage) | — | done |
| `remove_scheduled_task` | schedule.ts | Direct (local storage) | — | done |
| `save_location` | location.ts | Direct (local storage) | — | done |
| `list_locations` | location.ts | Direct (local storage) | — | done |
| `save_reminder` | location.ts | Direct (local storage) | — | done |
| `list_reminders` | location.ts | Direct (local storage) | — | done |
| `mark_reminder_fired` | location.ts | Direct (local storage) | — | done |
| `manage_emails` | email.ts | Direct (Gmail REST API via lib/gmail.ts) | `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, `GOOGLE_REFRESH_TOKEN` | done |
| `manage_calendar` | calendar.ts | Direct (Google Calendar REST API via lib/gcal.ts) | `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, `GOOGLE_REFRESH_TOKEN` | done |
| `manage_docs` | docs.ts | Direct (Google Docs API via lib/gdocs.ts) | `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, `GOOGLE_REFRESH_TOKEN` | done |
| `generate_image` | docs.ts | Direct (Gemini/Imagen) | `GOOGLE_GENERATIVE_AI_API_KEY` | done |
| `proactive_history` | proactive.ts | Direct (lib/proactive) | — | done |
| `record_intervention` | proactive.ts | Direct (lib/proactive) | — | done |
| `get_activity` | activity.ts | Direct (lib/activity) | — | done |
