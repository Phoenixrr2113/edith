# Edith

A proactive, always-on AI personal assistant. Cortana's brain, Bonzi's charm.

Edith runs as a Bun daemon on macOS, dispatching to Claude via the Agent SDK. She communicates via Telegram, remembers via Cognee, manages Google services via n8n, and runs scheduled background agents on a timer.

## Architecture (v4 — Orchestrator Pattern)

```
edith.ts (Bun daemon)
  ├── Telegram polling  → dispatch to persistent Claude session
  ├── Scheduler         → fires skills on cron (morning-brief, midday-check, etc.)
  └── Geofencing        → location-based reminders via OwnTracks pings

Claude session (orchestrator):
  Light tasks  → handles directly (reminders, lookups, quick questions)
  Heavy tasks  → spawns background agents via Agent tool
    ├── morning-briefer   (calendar, email, Cognee, meeting prep)
    ├── email-triager     (scan inbox, archive noise, draft replies)
    ├── midday-checker    (catch changes, prep afternoon)
    ├── evening-wrapper   (day review, tomorrow prep, Cognee storage)
    ├── researcher        (web + codebase research)
    └── reminder-checker  (check due reminders — haiku)

MCP tools (mcp/server.ts):
  send_message, send_notification, manage_emails, manage_calendar,
  manage_docs, generate_image, save_reminder, list_reminders,
  save_location, list_locations, add/list/remove_scheduled_task,
  proactive_history, record_intervention

Integration backend (n8n, port 5679):
  /webhook/calendar  — Google Calendar (get/create/update/delete)
  /webhook/gmail     — Gmail (get/send/reply/draft/archive/trash)
  /webhook/docs      — Google Docs (create)
  /webhook/notify    — Telegram, WhatsApp, SMS routing

External services:
  Cognee (port 8001) — knowledge graph + semantic memory
  Groq Whisper       — voice transcription (direct API)
  Google Imagen      — image generation (direct API)
```

## Key Files

| File | What |
|------|------|
| `edith.ts` | Daemon — Telegram polling, scheduler, geofencing, dispatch |
| `lib/dispatch.ts` | Agent SDK dispatch — session management, event streaming |
| `mcp/server.ts` | MCP tool server — all tools Edith can call |
| `prompts/system.md` | Edith's identity, voice, orchestrator instructions |
| `.claude/agents/*.md` | Background agent definitions (scoped tools + prompts) |
| `.claude/rules/*.md` | Behavioral rules (communication, priorities, autonomy, memory) |
| `n8n/` | Workflow JSONs + documentation |
| `ARCHITECTURE-V4.md` | Full architecture doc, decision log, future plans |

## Services

| Service | URL | Purpose |
|---------|-----|---------|
| **Langfuse** | http://localhost:3000 | LLM traces, cost dashboard, latency analysis |
| **BetterStack Logs** | https://telemetry.betterstack.com | Structured logs, search, alerts |
| **BetterStack Uptime** | https://uptime.betterstack.com | Heartbeat monitoring, uptime alerts |
| **n8n** | http://localhost:5679 | Google Calendar/Gmail/Docs via OAuth webhooks |
| **Cognee** | http://localhost:8001 | Knowledge graph, semantic memory |
| **GitHub Project** | https://github.com/users/Phoenixrr2113/projects/1 | Task backlog and pipeline |

## Requirements

- **Claude Code CLI** v2.1.80+ (Agent SDK)
- **Bun** (runtime)
- **n8n** (`npx n8n start` — runs as child process, no Docker needed)
- **Cognee** (Docker or MCP stdio)
- **Telegram Bot** (via [@BotFather](https://t.me/BotFather))

## Setup

```bash
cp .env.example .env   # fill in API keys
cd mcp && bun install && cd ..
./launch-edith.sh       # starts n8n + Edith
```

## How It Works

1. **edith.ts** polls Telegram and runs scheduled tasks on cron
2. Messages dispatch to a persistent Claude session via Agent SDK
3. Claude decides: handle directly (light) or spawn background agent (heavy)
4. Background agents run in parallel, stream progress events
5. Results flow back to Randy via Telegram
6. **Cognee** stores long-term knowledge; agents query it for context
7. **n8n** proxies Google services via pre-authenticated OAuth webhooks

## Notification Channels

| Channel | Method | Status |
|---------|--------|--------|
| Telegram | Bot API | Working |
| WhatsApp | Twilio sandbox | Working (rejoin every 72h) |
| SMS | Twilio A2P | Pending registration (~2-3 weeks) |
| Desktop | macOS toast | Working |
| Dialog | macOS modal | Working |
