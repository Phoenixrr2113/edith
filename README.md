# Edith

A proactive, always-on AI personal assistant. Cortana's brain, Bonzi's charm.

Edith runs as a Bun daemon on macOS, dispatching to Claude via the Agent SDK. She communicates via Telegram, stores state in SQLite, manages Google services via direct REST APIs, and runs scheduled background agents on a timer. A Tauri v2 desktop companion provides a local presence with voice I/O.

## Architecture (v4 — Orchestrator + Skill Routing)

```
edith.ts (Bun daemon)
  ├── Telegram polling  → dispatch to persistent Claude session
  ├── Scheduler         → fires skills on cron (morning-brief, midday-check, etc.)
  ├── Geofencing        → location-based reminders via OwnTracks pings
  ├── Proactive engine  → screen context triggers with cooldown gates
  └── WebSocket server  → desktop app connection (JWT auth)

Claude session (orchestrator):
  Light tasks  → handles directly (reminders, lookups, quick questions)
  Heavy tasks  → spawns background agents via Agent tool

  4 general agents (skill-routed):
    ├── communicator  (briefs, email triage, messaging — sonnet)
    ├── researcher    (web + codebase research — sonnet)
    ├── analyst       (weekly/monthly/quarterly reviews — sonnet/opus)
    └── monitor       (reminder checks, proactive checks — haiku)

Desktop app (desktop/ — Tauri v2 + Svelte 5):
  ├── Frameless window + system tray
  ├── Speech bubbles (cloud-pushed messages)
  ├── Worker progress indicator
  ├── Settings panel + dark/light theme
  ├── Audio playback, TTS (Cartesia), STT (Groq Whisper)
  └── WebSocket client → cloud backend
        ├── Cloud-to-local fallback
        ├── Offline task queue
        ├── Local cache + state sync
        └── Ollama detection for local LLM

MCP tools (mcp/server.ts → mcp/tools/*.ts):
  8 domain modules: messaging, schedule, location, email,
  calendar, docs, proactive, activity

Google APIs (direct REST, no middleware):
  lib/gmail.ts      — Gmail (search, archive, trash, labels, send)
  lib/gcal.ts       — Calendar (list, create, update, delete events)
  lib/gdocs.ts      — Docs (create, read)
  lib/gdrive.ts     — Drive (search, get, download, upload)
  lib/google-auth.ts — OAuth2 token management (SQLite-backed)

State (SQLite — ~/.edith/edith.db):
  schedule, locations, reminders, sessions, dead_letters,
  proactive_state, geo_state, oauth_tokens

External services:
  Cognee (port 8001) — knowledge graph + semantic memory
  Groq Whisper       — voice transcription (direct API)
  Cartesia           — text-to-speech (direct API)
  Google Imagen      — image generation (direct API)
```

## Key Files

| File | What |
|------|------|
| `edith.ts` | Daemon — Telegram polling, scheduler, geofencing, dispatch |
| `lib/dispatch.ts` | Agent SDK dispatch — session management, circuit breaker, queue |
| `lib/briefs/` | Brief builders — scheduled, conversation, proactive (3 modules) |
| `lib/handlers.ts` | Message/voice/photo/location handler routing |
| `lib/ipc.ts` | Centralized IPC — signals, triggers, inbox processing |
| `lib/db.ts` | SQLite persistence — all state tables |
| `mcp/server.ts` | MCP entrypoint — registers 8 domain tool modules |
| `mcp/tools/*.ts` | Domain-specific MCP tools (email, calendar, etc.) |
| `lib/config.ts` | Centralized constants (timeouts, limits, paths, env vars) |
| `prompts/system.md` | Edith's identity, voice, orchestrator instructions |
| `.claude/agents/*.md` | 4 general agent definitions + project-auditor |
| `.claude/skills/*.md` | Skill definitions (morning-brief, check-reminders, etc.) |
| `.claude/rules/*.md` | Behavioral rules (communication, priorities, autonomy, memory) |
| `desktop/` | Tauri v2 + Svelte 5 desktop app |
| `ARCHITECTURE-V4.md` | Full architecture doc, decision log, future plans |

## Services

| Service | URL | Purpose |
|---------|-----|---------|
| **Langfuse** | http://localhost:3000 | LLM traces, cost tracking, latency analysis |
| **BetterStack Logs** | https://telemetry.betterstack.com | Structured logs, search, alerts |
| **BetterStack Uptime** | https://uptime.betterstack.com | Heartbeat monitoring, uptime alerts |
| **Sentry** | https://sentry.io | Error tracking, crash reports |
| **Cognee** | http://localhost:8001 | Knowledge graph, semantic memory |
| **Anthropic Console** | https://console.anthropic.com | API cost and usage reporting |

## Requirements

- **Claude Code CLI** v2.1.80+ (Agent SDK)
- **Bun** (runtime)
- **Docker** (for Langfuse + Cognee)
- **Telegram Bot** (via [@BotFather](https://t.me/BotFather))
- **Google OAuth credentials** (for Gmail, Calendar, Docs, Drive)
- **Rust + Tauri CLI** (for desktop app)

## Setup

```bash
./setup.sh              # interactive — generates .env with all keys
./install.sh            # installs LaunchAgent for auto-start on login
# or manually:
./launch-edith.sh       # starts Docker services + Edith daemon
```

### Environment Variables

| Variable | Required | Purpose |
|----------|----------|---------|
| `TELEGRAM_BOT_TOKEN` | Yes | Telegram Bot API token |
| `TELEGRAM_CHAT_ID` | Yes | Your Telegram chat ID |
| `ANTHROPIC_API_KEY` | Yes | Claude API key |
| `GOOGLE_CLIENT_ID` | Yes | Google OAuth client ID |
| `GOOGLE_CLIENT_SECRET` | Yes | Google OAuth client secret |
| `GOOGLE_REFRESH_TOKEN` | Yes | Google OAuth refresh token |
| `CARTESIA_API_KEY` | No | Text-to-speech (desktop app) |
| `GROQ_API_KEY` | No | Speech-to-text via Whisper (desktop app) |
| `SENTRY_DSN` | No | Sentry error tracking DSN |
| `DEVICE_SECRET` | No | JWT secret for device auth (auto-generated) |

## How It Works

1. **edith.ts** polls Telegram and runs scheduled tasks on cron
2. Messages dispatch to a persistent Claude session via Agent SDK
3. Claude decides: handle directly (light) or spawn background agent (heavy)
4. Skill routing maps brief types to the right agent + model
5. Results flow back to Randy via Telegram (and desktop speech bubbles)
6. **Desktop app** connects via WebSocket — receives pushed messages, plays TTS, accepts voice input
7. **Cognee** stores long-term knowledge; agents query it for context
8. **SQLite** persists all state (schedule, reminders, sessions, locations)
9. **Google APIs** called directly via OAuth2 (no middleware)

## Desktop Dev

```bash
cd desktop && bun run tauri dev    # hot-reload desktop app
cd desktop && bun run tauri build  # production build
```

## Notification Channels

| Channel | Method | Status |
|---------|--------|--------|
| Telegram | Bot API | Working |
| WhatsApp | Twilio sandbox | Working (rejoin every 72h) |
| SMS | Twilio A2P | Pending registration |
| Desktop | Tauri speech bubble | Working |
| macOS toast | macOS notification | Working |
| Dialog | macOS modal | Working |

## Testing

```bash
bun test                    # run all tests (265 tests)
bun run test:coverage       # with coverage report
bunx biome check .          # lint check
bun run tsc --noEmit        # type check
```

## Design Documents

| Document | Topic |
|----------|-------|
| `docs/design-skill-library.md` | Skill format, taxonomy, routing |
| `docs/design-websocket-protocol.md` | Device-cloud WebSocket protocol |
| `docs/design-device-auth.md` | JWT-based device authentication |
| `docs/design-session-management.md` | Cloud-ready session management |
| `docs/eval-agent-consolidation.md` | 11→4 agent consolidation analysis |
| `docs/mcp-audit.md` | MCP tool backend audit |
| `docs/mcp-direct.md` | Direct function exposure evaluation |
