# Edith

A proactive, always-on AI personal assistant powered by Claude Code.

Edith runs as a persistent Bun process on macOS, orchestrating Claude Code CLI calls. She communicates via Telegram, remembers everything via Cognee, accesses Google Calendar and Gmail via n8n, and runs scheduled tasks on a timer.

## Architecture

```
launch-edith.sh
  ├── dashboard.ts        → monitoring UI (localhost:3456)
  └── edith.ts             → persistent orchestrator
        ├── Telegram poll  → claude -p --resume (conversation session)
        ├── Scheduler      → claude -p (ephemeral task sessions)
        └── Events         → ~/.edith/events.jsonl → dashboard

MCP tools (channel/server.ts):
  send_message, get_calendar, get_emails,
  save_reminder, list_reminders, mark_reminder_fired,
  save_location, list_locations,
  add/list/remove_scheduled_task

Docker:
  cognee (port 8001) — knowledge graph
  n8n (port 5679)    — Google Calendar + Gmail proxy
```

## What's in the box

| File | What |
|------|------|
| `edith.ts` | Persistent orchestrator — Telegram polling, scheduler, event logging |
| `channel/server.ts` | MCP tool server — messaging, reminders, locations, schedule, Google |
| `channel/geo.ts` | Haversine distance + geofencing |
| `dashboard.ts` | Monitoring dashboard |
| `CLAUDE.md` | Edith's identity, protocols, memory instructions |
| `.claude/skills/*.md` | 4 scheduled skills (morning-brief, midday-check, evening-wrap, check-reminders) |
| `docker-compose.yml` | Cognee + n8n containers |

## Requirements

- **Claude Code CLI** v2.1.80+
- **Bun** (runtime)
- **Docker** (Cognee + n8n)
- **Telegram Bot** (create via [@BotFather](https://t.me/BotFather))
- **OpenRouter API key** (for Cognee LLM)

## Setup

```bash
./setup.sh
```

Or manually:

```bash
cd channel && bun install && cd ..
docker compose up -d
# Configure .env with TELEGRAM_BOT_TOKEN, TELEGRAM_CHAT_ID, OPENROUTER_API_KEY
bash test-e2e.sh   # verify everything works
./launch-edith.sh   # start Edith + dashboard
```

## Dashboard

http://localhost:3456 — auto-refreshes every 5 seconds.

Shows system health, active Claude processes, message feed, scheduled tasks, errors, and daily stats.

## How It Works

1. **edith.ts** polls Telegram for messages and runs scheduled tasks on a timer
2. Each message dispatches `claude -p --resume` to maintain conversation context
3. Claude sees MCP tools and calls `send_message` to reply via Telegram
4. Scheduled tasks run as ephemeral `claude -p` calls and write to the taskboard
5. **Cognee** stores long-term knowledge; the **taskboard** stores transient task output
6. **n8n** proxies Google Calendar and Gmail via pre-authenticated OAuth webhooks
7. **Geofencing** runs locally in edith.ts — instant alerts when entering named locations

## Reminders

Tell Edith "remind me to X" — she uses the `save_reminder` tool:
- **Time**: checked every 5 min by `/check-reminders` scheduled task
- **Location**: fired instantly when GPS enters the geofence radius
