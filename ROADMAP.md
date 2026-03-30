# Edith Roadmap

Last updated: 2026-03-30

This document is the single source of truth for Edith's architecture direction, planned work, and design decisions. It replaces scattered planning across PLAN.md, ARCHITECTURE-V4.md future sections, and individual docs/ files.

---

## Vision

Edith is an always-on AI companion that lives in the cloud, senses everything (screen, audio, location, calendar, email, messages), and proactively helps. She runs on any device — desktop companion on the laptop, Telegram on the phone, native app eventually.

**Mental model:** Spider on a web. Edith sits at the center, senses vibrations (events), and spawns specialized agents to handle what comes in. The orchestrator never does heavy lifting — it delegates and synthesizes.

**Design philosophy:** Cortana's brain + Bonzi's charm. Every interruption must earn its cost. Silence is default. Have personality. Be a presence, not a service.

---

## Architecture Target

```
                    ┌─────────────────────┐
                    │   Fly.io Sprite     │
                    │   (Edith Brain)     │
                    │                     │
                    │  Orchestrator Agent  │
                    │  Memory (Cognee)    │
                    │  State (SQLite)     │
                    │  Direct API calls   │
                    │  (Gmail, Cal, Docs) │
                    └──────┬──────────────┘
                           │ WebSocket
              ┌────────────┼────────────┐
              │            │            │
    ┌─────────▼──┐  ┌──────▼─────┐  ┌──▼──────────┐
    │ Tauri App  │  │ Telegram   │  │ Future:     │
    │ (macOS)    │  │ (phone)    │  │ iOS/Android │
    │            │  │            │  │ native app  │
    │ Screen cap │  │ Messages   │  │             │
    │ Audio cap  │  │ Voice      │  │             │
    │ Rive char  │  │ Location   │  │             │
    │ TTS output │  │            │  │             │
    │ Ollama     │  │            │  │             │
    │ (offline)  │  │            │  │             │
    └────────────┘  └────────────┘  └─────────────┘
```

### Key Architectural Decisions

| Decision | Choice | Rationale |
|----------|--------|-----------|
| Cloud host | Fly.io Sprites | Persistent VMs, idle shutdown, 1-12s cold start, pay for CPU time |
| App framework | Tauri v2 + Rust + Svelte 5 | 30-50MB RAM, native macOS access, small binary |
| Screen capture | screencapturekit-rs | Event-driven (app switch, click, typing pause), not continuous |
| Audio capture | ScreenCaptureKit (same crate) | System audio + mic from one API |
| Speaker diarization | WhisperX (batch) / Deepgram (real-time) | WhisperX for post-meeting, Deepgram for live |
| Screen understanding | Gemini Live API | Session-bounded, not 24/7. $0.28/hr at 1 FPS |
| Character animation | Rive | 60fps, 10-15x smaller than Lottie, built-in state machine |
| TTS | Cartesia Sonic (cloud) + Piper (offline) | Sub-90ms TTFB, 73% cheaper than ElevenLabs |
| Offline LLM | Ollama + llama3.2:1b | Auto-detect, prompt user to install, pull model programmatically |
| Memory | Keep Cognee (graph+vector hybrid) | Graph layer enables relationship reasoning (people, decisions). Uses LanceDB for vectors + Kuzu for graph + bge-base-en-v1.5 embeddings. Mem0 as future alternative if Python-only becomes a blocker |
| Error tracking | Sentry + BetterStack | Sentry for errors/stack traces, BetterStack for operational logs |
| Integration backend | Direct API calls (replaces n8n) | n8n has $50K embed license, OAuth injection broken |
| Agent orchestration | Supervisor pattern, max 2 levels | Research-validated: 2-5 agents, 5-6 tasks each |
| Dashboard | Kill it (after extracting reusable functions) | End users don't need it. Telegram + desktop companion are the UI |

---

## Agent Model

Hybrid approach (validated by Anthropic's SDK guidance and multi-agent research):

**1 persistent orchestrator** — the main Claude session. Handles routing, synthesis, quick tasks.

**3-4 scoped worker agents** — spawned on-demand with specific skills + tool permissions:

| Agent | Scope | Tools | Example Tasks |
|-------|-------|-------|---------------|
| communicator | Email, calendar, messaging, docs | manage_emails, manage_calendar, send_message, manage_docs | Morning brief, email triage, meeting prep, send replies |
| researcher | Web search, context gathering | WebSearch, WebFetch, Read, Glob, Grep, Bash | Look up people, research companies, find context |
| analyst | Reviews, reports, data synthesis | Read, Write, manage_calendar, manage_emails, manage_docs | Weekly/monthly/quarterly reviews, cost analysis |
| monitor | Screen context, proactive triggers | screenpipe/capture data, activity log | Focus tracking, meeting detection, proactive suggestions |

Workers get skill-specific prompts per task. The orchestrator picks agent + skill based on the incoming signal.

### Current Agents (11 — refactored to 4 in Phase 2)

| Agent | Model | Purpose | Target (P2-D) |
|-------|-------|---------|----------------|
| morning-briefer | sonnet | Calendar, email, Cognee, meeting prep, file prep | communicator + "morning-brief" skill |
| midday-checker | sonnet | Catch changes, prep afternoon, advance deadlines | communicator + "midday-check" skill |
| evening-wrapper | sonnet | Day review, tomorrow prep, Cognee storage | analyst + "evening-wrap" skill |
| weekend-briefer | sonnet | Family activities, local events, weather, beach | communicator + "weekend-brief" skill |
| email-triager | sonnet | Scan inbox, archive noise, draft replies | communicator + "email-triage" skill |
| weekly-reviewer | sonnet | GTD weekly review, Google Doc output | analyst + "weekly-review" skill |
| monthly-reviewer | sonnet | Scorecard, life areas, retrospective | analyst + "monthly-review" skill |
| quarterly-reviewer | sonnet | Strategic review, trajectory | analyst + "quarterly-review" skill |
| researcher | sonnet | Web + codebase research | researcher (stays as-is) |
| reminder-checker | haiku | Time-based reminders only | monitor + "reminder-check" skill |
| project-auditor | sonnet | Scan docs against code, create GitHub Issues | Internal tooling — not refactored, stays as-is |

---

## Internal Subsystems Reference

Active subsystems with file locations. These must be preserved/considered during all refactoring.

### Dispatch Engine (`lib/dispatch.ts`)
Queue management, circuit breaker (5 failures → 10 min cooldown), timeout handling, dead-letter save/replay, session cost tracking. The central nervous system — all messages and scheduled tasks flow through here.

### Reflector System (`lib/reflector.ts`)
Observes running sessions and injects contextual feedback via `streamInput()`. It:
- Records transcript entries as messages stream in
- Injects reflections via Claude Haiku after every Nth tool call
- Guards irreversible actions (send_message, manage_emails writes) with pre-execution review
- Evaluates session quality post-completion with scoring
- Supports A/B testing (active vs eval-only mode, 70/30 split)

The reflector is deeply integrated into `dispatch.ts` — it's ~50% of the stream processing loop. During P1-B (decompose `dispatchToClaude`), extract reflector into its own observer module. During P2-D (agent model refactor), the reflector continues as-is — it monitors the orchestrator session, not individual workers.

### Brief Building (`lib/briefs.ts`, `lib/prewake.ts`)
Before Claude wakes, Edith pre-fetches calendar and email from n8n and assembles a context brief. 8 brief types: boot, morning, midday, evening, message, location, scheduled, proactive. Pre-wake optimization (`lib/prewake.ts`) saves Claude turns by front-loading context. In Phase 2, prewake calls shift from n8n webhooks to direct googleapis.

### Activity Log (`lib/activity.ts`)
Source-agnostic record of what Randy was doing. Two tiers:
- **L1 snapshots** — appended by `gatherScreenContext()` in `lib/briefs.ts` every 10 min (proactive-check) and at noon (midday-check). Timestamped ~3-5 line blocks with apps, audio, context.
- **L2 daily summary** — generated by evening-wrap. Claude reads L1 entries and writes a summary paragraph.

Files: `~/.edith/activity/YYYY-MM-DD.md`, never rotated. MCP tool `get_activity`: `days=1` (today), `days=7` (week), `days=30` (month). L2 summaries returned when available, L1 as fallback.

**Screen context windows:** Proactive-check pulls 15 min (since last check). Midday-check pulls 240 min (full morning since 8am brief).

### Session Injection (`lib/session.ts`)
Tracks the active Agent SDK query handle. Exposes `streamInput()` for mid-session message injection — new messages/tasks inject into the running session instead of waiting in the dispatch queue. **Known limitation:** if injection fails (session not in an injectable state), `skipIfBusy` tasks are dropped silently. Needs a queue+retry fallback before cloud migration changes the session model.

### Proactive Interventions (`lib/proactive.ts`)
Rate limiting infrastructure: quiet hours (22:00–08:00), per-category cooldowns (60 min), max 2 interventions/hour. `canIntervene()` and `recordIntervention()` wired into MCP server. **Gap:** trigger logic for WHEN to proactively intervene is not connected to the main loop — infrastructure exists but no automatic firing.

### Screen Awareness (`lib/screenpipe.ts`, `lib/gemini.ts`, `lib/audio-extract.ts`)
- **Screenpipe client** — health check, OCR + audio context, app usage tracking, continuous activity calculation
- **Gemini summarization** — Gemini 2.5 Flash for screen context summaries, skips LLM for trivial cases
- **Audio extraction** — Qwen 3 235B (OpenRouter) extracts structured knowledge from meeting audio (decisions, action items)

### Idle Detection (`lib/screenpipe.ts`)
Uses macOS `ioreg -c IOHIDSystem` to read HIDIdleTime. `isUserIdle(thresholdSeconds = 300)` returns true when idle >5 min. Scheduler skips all interval-based tasks when idle (proactive-check, check-reminders). Window-based tasks (morning/midday/evening) always fire.

### Transcript Logging (`lib/transcript.ts`)
Every session logged to JSONL — tool uses, text blocks, results, costs. Skips stream events to minimize size. Used by the `/costs` skill for cost analysis.

### Caffeinate (`lib/caffeinate.ts`)
Prevents macOS sleep while Edith is running (`caffeinate -dis -w PID`). Irrelevant after cloud migration — stays in Tauri app only.

### Taskboard (`lib/taskboard.ts`)
Timestamped entries from every agent run — findings, actions taken, open loops. Rotated every 24 hours (old entries pruned). **Gap:** no archival before rotation — weekly/monthly reviews can't read old entries. Fixed in P1-E.

---

## Task Pipeline (Development Workflow)

The audit → plan → execute → verify pipeline is existing internal tooling:
- **project-auditor** agent: scans docs against codebase, creates GitHub Issues with ATS YAML specs
- **/plan-task** skill: validates an issue's ATS spec (file ownership, dependencies, scope) before execution
- **/work-task** skill: pulls next `ready` issue, implements, runs verification, creates PR
- **/verify-task** skill: post-implementation verification against acceptance criteria

Task store: GitHub Issues (data layer, ATS YAML in issue body) + GitHub Projects board (workflow: Backlog → Ready → In Progress → Done → Failed). All via `gh` CLI.

This pipeline is fully operational and continues as-is. It's how all ROADMAP tasks get executed.

---

## Working Features (carry forward)

These are active, operational features that continue through all phases.

### Briefs & Reviews

| Feature | Schedule | Agent | Key Behavior |
|---------|----------|-------|-------------|
| Morning brief | 8:03 weekdays | morning-briefer | Calendar (24h ahead), email (24h back), Cognee context, meeting prep files to ~/Desktop/edith-prep/ |
| Midday check | 12:07 weekdays | midday-checker | Afternoon agenda, deadline work, email catch-up, screen context (240 min) |
| Evening wrap | 16:53 weekdays | evening-wrapper | Day review, tomorrow prep, L2 activity summary, Cognee storage |
| Weekend brief | 9:03 Sat/Sun | weekend-briefer | Weather, Bradenton/Sarasota events, beach conditions (water temp, surf, tide), kid-friendly activities for Phoenix (parkour, STEM, skateparks), family calendar |
| Weekly review | Sunday 5 PM | weekly-reviewer | Google Doc (GTD-style: work, personal, open loops, next week) + Telegram summary with link |
| Monthly review | 1st, 9:30 AM | monthly-reviewer | Google Doc (life scorecard across 9 areas, 3 wins, 3 lessons, energy audit) + Telegram summary |
| Quarterly review | 1st of quarter, 10 AM | quarterly-reviewer | Google Doc (OKR scorecard, quarter theme, stop/start/continue, values alignment) + Telegram summary |

**Review data flow cascade:** Daily briefs are the foundation — they capture raw data (email, calendar, screen) to the taskboard. Weekly reviews aggregate taskboard + recent data. Monthly reviews aggregate weekly reviews. Quarterly reviews aggregate monthly reviews. Each level builds on the one below it.

**Review output dependency:** All reviews produce a Google Doc (shareable URL for mobile access) + Telegram summary linking to it. Google Docs creation currently flows through manage_docs → n8n → googleapis. This chain must remain functional through the n8n migration (Phase 2).

### Core Runtime Systems

| System | File(s) | Key Behavior |
|--------|---------|-------------|
| Dispatch engine | lib/dispatch.ts | Queue, circuit breaker (5 failures → 10 min), timeout, dead-letter save/replay |
| Reflector | lib/reflector.ts | Session quality monitoring, irreversible action guards, A/B testing |
| Activity log | lib/activity.ts | L1 snapshots every 10 min, L2 daily summaries, MCP tool `get_activity` |
| Proactive rate limiter | lib/proactive.ts | Quiet hours 22-08, per-category cooldowns (60 min), max 2/hour |
| Session injection | lib/session.ts | `streamInput()` for mid-session message injection |
| Brief building | lib/briefs.ts, lib/prewake.ts | 8 brief types, pre-wake calendar/email fetch |
| Idle detection | lib/screenpipe.ts | macOS HIDIdleTime, scheduler skips interval tasks when idle >5 min |
| Transcript logging | lib/transcript.ts | Every session → JSONL (tool uses, text, costs), used by /costs skill |
| Caffeinate | lib/caffeinate.ts | Prevents macOS sleep during daemon runtime |
| Taskboard | lib/taskboard.ts | Agent run results, rotated every 24h (archival gap → P1-E) |
| Event logging | lib/state.ts | ~/.edith/events.jsonl — every dispatch, cost, error, schedule fire, timestamped |

### Location & Reminders

| Feature | Implementation | Notes |
|---------|---------------|-------|
| Geofencing | mcp/geo.ts + Telegram live location | Arrive/depart detection with named locations (home, school, Diana's work) |
| Location-based reminders | Checked on every Telegram location update | Fire when entering a geofence |
| Time-based reminders | checkTimeReminders() every 5 min | reminders.json, checked by reminder-checker agent |
| Named locations | locations.json + location-latest.json | GPS coords for geofence definitions |

### Communication Channels

| Channel | Direction | Implementation |
|---------|-----------|---------------|
| Telegram | Bidirectional (primary) | Polling in edith.ts, send via send_message MCP tool |
| WhatsApp | Outbound only | lib/twilio.ts via send_notification MCP tool |
| SMS | Outbound only | lib/twilio.ts via send_notification MCP tool |
| Email (send) | Outbound | manage_emails MCP tool → n8n → Gmail API |
| Slack | Outbound only | send_notification MCP tool |
| Discord | Outbound only | send_notification MCP tool |
| Desktop notifications | Outbound only | terminal-notifier / osascript |

### Data Source Limitations (current)

These are known limitations that affect review quality. Workarounds are in place via the daily brief → taskboard cascade.

| Source | What Works | What Doesn't | Workaround |
|--------|-----------|-------------|-----------|
| Gmail (n8n) | Relative time: hoursBack 1-48, max 20 results, unread filter | No date range search (after/before), no sent mail, no pagination >20 | Daily briefs write email summaries to taskboard |
| Calendar (n8n) | Forward only: hoursAhead 1-168 (7 days) | No past event queries, no search by attendee/title | hoursBehind parameter (P1-E). Daily briefs capture calendar to taskboard |
| Screenpipe | Live: last N minutes of OCR, audio, app usage | No historical queries by date, no cross-session search | Activity log (L1 snapshots) captures screen context every 10 min |
| Cognee | Semantic search, graph queries, entity storage | Was broken (networkx/kuzu mismatch), fixed, no data before March 28 | Re-cognify existing knowledge as needed |
| Google Drive | Search + read (MCP tools) | No create/write/update (read-only) | Google Docs creation via n8n webhook |
| Taskboard | Current 24h of agent results | Rotated daily — no history | Archival before rotation (P1-E) |
| Telegram history | Edith sends messages | Can't search own sent history | Taskboard + events log capture what was sent |

### Development Tooling

| Tool | Status | Notes |
|------|--------|-------|
| Pre-commit hooks | Working | Husky + tsc + bun test (~2s) |
| CI | Working | GitHub Actions: tsc --noEmit + bun test on push to main |
| Task pipeline | Working | project-auditor → /plan-task → /work-task → /verify-task |
| GitHub Projects | Working | Board with ATS labels, automations |
| Langfuse | Working | Self-hosted Docker stack, OTEL tracing of all Claude SDK calls |
| BetterStack | Working | Structured logging + heartbeats + alerting + MCP server |

---

## Feature Migration Map

Every current feature mapped to its cloud + Tauri equivalent.

### Works in cloud with minimal changes (JSON → SQLite migration)

| Feature | Current Implementation | Cloud Migration |
|---------|----------------------|-----------------|
| Time-based reminders | `checkTimeReminders()` every 5 min, reminders.json | Same logic, SQLite-backed |
| Scheduled tasks | scheduler.ts + schedule.json | Same logic, SQLite-backed |
| Email management | MCP → n8n webhooks → Gmail API | Direct googleapis (Phase 2) |
| Calendar management | MCP → n8n webhooks → Calendar API | Direct googleapis (Phase 2) |
| Google Docs creation | MCP → n8n webhooks → Docs API | Direct googleapis (Phase 2) |
| Proactive rate limiting | proactive.ts + proactive-state.json | Same logic, SQLite-backed |
| Activity logging | activity.ts → ~/.edith/activity/ | Same logic, cloud storage |
| Event logging | state.ts → events.jsonl | Same logic, cloud storage |
| Cognee memory | bash script → Python subprocess | Cognee process on Fly.io |
| Voice messages | Telegram → download → Groq Whisper | Same (API call from cloud) |
| Reflector system | Runs inside dispatch stream | Same pattern in cloud |
| Dead-letter queue | dead-letters.json, replayed on boot | SQLite-backed, same logic |
| Transcript logging | transcript.ts → JSONL per session | Same logic, cloud storage |
| Taskboard | taskboard.ts → ~/.edith/taskboard.md | Same logic, SQLite-backed |
| Brief building | briefs.ts + prewake.ts | Same logic, prewake calls shift from n8n to direct googleapis |

### Needs new implementation for cloud + Tauri

| Feature | Current | Cloud + Tauri | Notes |
|---------|---------|---------------|-------|
| Location tracking | Telegram live location → handlers.ts | Telegram + Tauri (macOS Location Services) + phone app | Multiple location sources |
| Geofence state | In-memory `let currentLocationName` (mcp/geo.ts:66) | SQLite row in cloud DB | Must persist across restarts |
| Location-based reminders | Checked on every Telegram location update | Checked on every location update from any device | Same logic, more sources |
| Screen capture | Screenpipe (local OCR) | Tauri → screencapturekit-rs → stream to cloud | Event-driven, not continuous |
| Audio capture | Screenpipe | Tauri → ScreenCaptureKit → stream to cloud | System audio + mic |
| Audio extraction | Qwen 3 235B via OpenRouter (lib/audio-extract.ts) | Same API call from cloud | Extracts decisions/action items from meeting audio |
| Idle detection | `ioreg` shell command (macOS) | Tauri native API (macOS HIDIdleTime) | Stays on device, reports to cloud |
| Caffeinate | lib/caffeinate.ts (`caffeinate -dis -w PID`) | Not needed in cloud. Tauri app handles local sleep prevention | macOS only |
| Desktop notifications | terminal-notifier / osascript | Tauri native notifications via WebSocket from cloud | Cloud sends, device displays |
| Photo handling | Telegram → download to local disk | Telegram → cloud storage (Fly volume or S3/R2) | |
| Signal files (IPC) | .signal-fresh, .signal-restart, .signal-pause | Gone — API/WebSocket commands | No more file-based IPC |
| Dashboard | localhost:3456 HTTP server | Gone — killed (data-access functions extracted to lib/) | Companion app replaces it |
| Prep files | ~/Desktop/edith-prep/ (local path) | Cloud storage → Google Doc link in Telegram | Local paths useless on phone |

### Tauri app offline resilience

The Tauri app is not purely a thin client — it needs local capabilities when cloud is unreachable:

| Capability | Offline Behavior |
|------------|-----------------|
| Basic queries | Ollama (llama3.2:1b) handles simple questions |
| Location tracking | Continues locally, geofence checks against cached locations |
| Reminders | Time-based reminders fire from local cache |
| Screen/audio capture | Buffers to local disk, syncs when cloud returns |
| Notifications | Shows cached/queued notifications |
| Complex tasks | Queued for cloud, user notified "will process when online" |
| State sync | On reconnect: device pushes buffered data, cloud pushes missed updates |

---

## Multi-Device Sync

Like WhatsApp Web — brain in the cloud, devices are thin clients:
- Cloud holds: state, memory, conversation history, agent sessions
- Devices send: screen frames, audio, location, user messages
- Devices receive: text responses, voice audio, companion state updates
- Sync via WebSocket (real-time) + REST (async)

---

## Phases

### Phase 1: Foundation Cleanup (current — weeks)

Fix the architectural issues found in the audit before building new features.

#### P1-A: Code Quality

| Task | Files | Acceptance Criteria |
|------|-------|-------------------|
| Add Biome linter to CI | .github/workflows/ci.yml, biome.json (new) | `biome check` passes in CI, lint errors block merge |
| Fix file race conditions | lib/state.ts, mcp/server.ts | Add file locking (flock or write-to-temp+rename) for taskboard.md, reminders.json, events.jsonl. No more corrupted reads. |
| Fix .env file permissions | launch-edith.sh or setup script | `.env` is chmod 600 (owner read/write only), verified in CI or pre-commit |
| Remove dead code: transcribeAudio | mcp/server.ts | `grep -r 'transcribeAudio' mcp/` returns only lib/telegram.ts (the real one) |
| Remove dead code: loadPrompt | lib/state.ts, prompts/ | `loadPrompt` function deleted, unused prompt templates (prompts/bootstrap.md, message.md, etc.) deleted |
| Replace ~30 `any` types | lib/sdk-types.ts (new), all files with `any` | New file defines narrow interfaces for Agent SDK types. `grep -c ': any'` reduced to <5 (intentional any for truly dynamic data) |
| Fix fragile Gemini dep | mcp/package.json | `@google/generative-ai` explicitly listed in mcp/package.json dependencies |
| Consolidate duplicate Gemini client | lib/gemini.ts, mcp/server.ts | Single Gemini client in lib/gemini.ts, mcp/server.ts imports from lib/ |
| Export shouldFire from scheduler | lib/scheduler.ts, tests/scheduler.test.ts | `shouldFire()` exported, unit tests cover all schedule types (cron, interval, window) |
| Clean up Claude Desktop scheduled tasks | ~/.claude/scheduled-tasks/ | Directory deleted or emptied. ARCHITECTURE-V4.md note about this removed. |

#### P1-B: Architecture Fixes

| Task | Files Modified | Files Read | Acceptance Criteria |
|------|---------------|------------|-------------------|
| Move geo.ts | mcp/geo.ts → lib/geo.ts, update imports | mcp/server.ts | No cross-boundary imports (mcp/ never imports from lib/ pattern violation fixed) |
| Split briefs.ts into 3 modules | lib/briefs.ts → lib/screen-context.ts, lib/triggers.ts, lib/briefs.ts | lib/activity.ts | screen-context.ts owns `gatherScreenContext()` + activity log L1 writes. triggers.ts owns heuristic detection. briefs.ts owns template assembly for all 8 brief types. Activity log L1/L2 relationship preserved and documented in code comments. |
| Split mcp/server.ts into domain files | mcp/server.ts → mcp/tools/telegram.ts, mcp/tools/schedule.ts, mcp/tools/calendar.ts, mcp/tools/email.ts, mcp/tools/docs.ts, mcp/tools/location.ts, mcp/tools/notification.ts | — | Each tool domain in its own file. mcp/server.ts imports and registers. All 25+ MCP tools still functional. |
| Decompose dispatchToClaude() | lib/dispatch.ts → lib/stream-processor.ts (new), lib/reflector-observer.ts (new) | lib/reflector.ts | Stream processing extracted. Reflector integration extracted into observer module (~50% of current processMessageStream). dispatch.ts calls both. Reflector still guards irreversible actions, still does A/B testing. |
| Unify IPC | lib/dispatch.ts, edith.ts | .signal-fresh, .signal-restart, triggers/, inbox/ | Single command inbox replaces signal files + trigger dir + inbox dir. All IPC goes through one mechanism. Old signal file handling removed. |
| Centralize constants | lib/config.ts, all files with hardcoded values | — | Model names (claude-sonnet-4-20250514, etc.), timeouts (dispatch 300s, etc.), thresholds (idle 300s, circuit breaker 5, etc.) all in config.ts. No magic numbers in business logic. |
| Clean up skills/agents duplication | .claude/skills/*, .claude/agents/* | — | Skill stubs that duplicate agent definitions collapsed. Agents are source of truth. Skills reference agents, not duplicate them. |
| Kill dashboard.ts | dashboard.ts → lib/dashboard-data.ts (extract), then delete dashboard.ts + dashboard.html | — | `readEventsFile()`, `checkHealth()`, `getStatus()`, `getStats()` extracted to lib/dashboard-data.ts. Dashboard HTTP server and HTML deleted. MCP tools or future code can import data-access functions from lib/. |

#### P1-C: Testing

| Task | Files | Acceptance Criteria |
|------|-------|-------------------|
| Unit tests for dispatch.ts | tests/dispatch.test.ts | Tests cover: queue ordering, circuit breaker trigger + reset, timeout handling, dead-letter save on failure, dead-letter replay on boot, skipIfBusy behavior |
| Unit tests for briefs.ts (after split) | tests/screen-context.test.ts, tests/triggers.test.ts, tests/briefs.test.ts | Tests cover: each of 8 brief types assembled correctly, screen context gathering mocked, trigger heuristics fire/don't fire correctly |
| Unit tests for handlers.ts | tests/handlers.test.ts | Tests cover: Telegram message handling, location update handling, voice message handling, photo handling |
| Integration tests for dispatch → agent → response | tests/dispatch-integration.test.ts (Issue #4) | Tests with mocked Agent SDK: scheduler tick → shouldFire() → brief building → dispatch. Message → dispatch → response. Dead-letter → restart → replay → delivery. Idle detection → scheduler skips. All pass without real LLM calls. |
| Test coverage reporting | .github/workflows/ci.yml | Coverage report generated in CI, viewable in PR. Target: >60% on lib/ files. |

#### P1-D: Documentation

| Task | Files | Acceptance Criteria |
|------|-------|-------------------|
| Fix ARCHITECTURE-V4.md dev process header | ARCHITECTURE-V4.md line 623 | "Development Process (Planned)" → "Development Process". Content updated to reflect implemented state. |
| Fix data-sources.md | docs/data-sources.md | Google Docs "HIGH BLOCKER" (line 72) removed or marked "IMPLEMENTED via manage_docs MCP tool". Activity log documented as data source. `grep -q 'BLOCKER' docs/data-sources.md` returns false. |
| Fix review-templates.md | docs/review-templates.md | Notes activity log (lib/activity.ts) alongside Screenpipe as data source. Clarifies that L1 snapshots replace Screenpipe for historical screen context. |
| Consolidate PLAN.md | PLAN.md (delete), this ROADMAP.md | All Phase 3+ content from PLAN.md captured here. PLAN.md deleted from repo. |
| Update ARCHITECTURE-V4.md agent count + near-term | ARCHITECTURE-V4.md | Agent count correct (11, with note about P2-D refactor to 4). Near-term checklist only contains undone items. |
| Update desktop-companion.md UI framework | docs/desktop-companion.md | React references changed to Svelte 5 to match ROADMAP decision #14. |

#### P1-E: Existing Feature Gaps

| Task | Files | Issue | Acceptance Criteria |
|------|-------|-------|-------------------|
| Taskboard archival before rotation | lib/taskboard.ts | #7 | `rotateTaskboard()` writes pruned entries to `~/.edith/taskboard-archive/YYYY-MM.md` (append-only) before deleting. New export: `getTaskboardArchive(months)` for review agents. Existing rotation behavior unchanged. |
| Historical calendar queries | n8n calendar workflow OR lib/calendar.ts | — | `hoursBehind` parameter added to calendar queries. Monthly reviews can inventory past meetings. Test: query events from 7 days ago returns results. |
| Proactive intervention trigger wiring | lib/proactive.ts, edith.ts (main loop) | #5 | `canIntervene()` + trigger logic connected to scheduler tick or dedicated interval. Proactive checks fire automatically when heuristics detect an intervention-worthy event. Rate limiting (quiet hours, cooldowns, max 2/hr) enforced. |

**Note:** Gmail date range search (after/before parameters) deferred to P2-B — n8n is being replaced with direct googleapis there anyway, so adding it to the n8n workflow now would be throwaway work. Daily brief taskboard entries serve as the email diary workaround until then.

#### P1-F: Observability

| Task | Files | Acceptance Criteria |
|------|-------|-------------------|
| Add Sentry error tracking | lib/sentry.ts (new), edith.ts, package.json | Sentry SDK initialized at startup. Unhandled exceptions + rejections captured with stack traces. Breadcrumbs for dispatch, tool calls, agent spawns. Sentry dashboard shows error grouping. |
| Evaluate Grafana unified dashboard | docker-compose.langfuse.yml, ARCHITECTURE-V4.md (Issue #9) | Decision documented: either add Grafana (Langfuse Clickhouse + BetterStack Logtail sources) or explicitly defer with rationale. If added: Grafana at localhost:3001, at least one "Edith Operations" dashboard. |

#### P1-G: Preserve During Cleanup

These are not new tasks — they're constraints on Phase 1 refactoring:

| Subsystem | Constraint |
|-----------|-----------|
| lib/session.ts + streamInput() | Must remain functional through all P1 refactoring. Add fallback: if injection fails during busy dispatch, queue the message + retry after current session completes (instead of silently dropping skipIfBusy tasks). Document the known limitation. |
| lib/prewake.ts | Preserved as-is during briefs.ts split. It's a separate module that pre-fetches calendar/email before Claude wakes. In Phase 2, prewake calls shift from n8n webhooks to direct googleapis — don't couple it to the n8n removal. |
| lib/activity.ts | L1 snapshots are written by `gatherScreenContext()` which moves to lib/screen-context.ts in the briefs.ts split. Ensure the activity log write path is preserved and tested after the split. |
| lib/reflector.ts | Extracted into observer module during dispatchToClaude decomposition (P1-B) but must retain all current behavior: per-N-tool-call injection, irreversible action guards, A/B testing, quality scoring. |
| lib/transcript.ts | Untouched in Phase 1. Continues logging every session to JSONL. |

---

### Phase 2: Cloud Migration (next — months)

Move Edith's brain to the cloud so she's accessible from any device.

#### P2-A: Cloud Infrastructure

| Task | Acceptance Criteria |
|------|-------------------|
| Set up Fly.io Sprite for Edith backend | Edith daemon runs on Fly.io. Sprite idles after inactivity, cold starts in 1-12s. Health check endpoint responds. BetterStack heartbeat pings from cloud. |
| Redesign session management for cloud | Persistent Claude session model adapted for Fly.io lifecycle (sprite sleep/wake). The busy flag + streamInput() injection pattern must handle: cold start mid-conversation, sprite wake with stale session, concurrent device connections. Document the new session lifecycle. |
| Migrate state from ~/.edith/ JSON files to SQLite | All JSON files (reminders.json, schedule.json, proactive-state.json, locations.json, dead-letters.json) → SQLite tables. events.jsonl → SQLite events table. taskboard.md → SQLite taskboard table. Migration script that converts existing data. |
| Deploy Cognee alongside Edith on Fly.io | Cognee runs as Python subprocess on the same Fly.io sprite (no Docker). Uses LanceDB (file-based vectors) + Kuzu (file-based graph) + `BAAI/bge-base-en-v1.5` embeddings (210MB, 768 dims, ~22ms/1K tokens on CPU). Config: `EMBEDDING_PROVIDER=fastembed`, `EMBEDDING_MODEL=BAAI/bge-base-en-v1.5`. MCP stdio transport. |
| Evaluate Cognee Python blocker | If running Cognee's Python process on Fly.io proves problematic (resource usage, startup time, reliability): evaluate Mem0 self-hosted as replacement. Mem0 has JS SDK + graph support. Preserve bge-base-en-v1.5 embedding model. Document decision. |
| Design WebSocket protocol | Protocol spec for device ↔ cloud: message types (text, voice, location, screen frame, audio chunk, state sync), authentication, reconnection, buffered message delivery. Handles multiple simultaneous devices. |
| Implement device authentication | Device registration flow: how does a new device prove it's Randy's? Options: one-time pairing code, Telegram-verified auth, API key. Must work for Tauri app, Telegram bot, future native apps. |
| Set up cloud CI/CD | Deploy on push to main. Fly.io deploy via GitHub Actions. Rollback on health check failure. |

#### P2-B: Replace n8n with Direct APIs

**Critical dependency:** Review agents (weekly/monthly/quarterly) depend on Google Docs creation returning a shareable URL. Google Docs must be migrated first or in parallel with other APIs — if Docs creation breaks during migration, all reviews break.

**Migration order:** Google Docs (reviews depend on it) → Gmail (includes after/before date range, deferred from P1-E) → Calendar (includes hoursBehind) → Google Drive → remove n8n.

| Task | Acceptance Criteria |
|------|-------------------|
| Google Docs: direct googleapis (FIRST) | `manage_docs` MCP tool calls googleapis directly with OAuth token instead of n8n webhook. Returns `{ docId, docUrl }`. Weekly/monthly/quarterly review agents produce working Google Doc links. Test by running a weekly review end-to-end. |
| Gmail: direct googleapis | `manage_emails` MCP tool calls googleapis directly. All current actions work: get (hoursBack), archive, trash, mark read, labels, batch. Add `after`/`before` date parameters for monthly reviews. |
| Calendar: direct googleapis | `manage_calendar` MCP tool calls googleapis directly. Forward queries (hoursAhead) + backward queries (hoursBehind) both work. Create/update/delete events. |
| Google Drive: direct googleapis | `manage_drive` or equivalent MCP tool. Search + read + create + update (current MCP tools are read-only — this expands capability). |
| OAuth token storage | OAuth tokens stored in cloud SQLite DB, encrypted at rest. Token refresh handled automatically. Tokens scoped per Google account. |
| Remove n8n dependency | n8n removed from launch script, docker-compose, and all code paths. No n8n process running. All MCP tools that previously called n8n webhooks now call googleapis directly. |
| Verify review agents | Run weekly, monthly, and quarterly review agents end-to-end. Each produces a Google Doc with shareable URL + Telegram summary with link. |
| Evaluate Google Tasks + Contacts | Decide: add Google Tasks and Google Contacts as direct API integrations now, or defer. Document decision. (Listed in ARCHITECTURE-V4.md as potential workflows.) |

#### P2-C: MCP Tool Architecture

**Note:** The Claude Agent SDK uses MCP as its tool interface — agents access tools via MCP servers. Fully removing MCP would mean not using the Agent SDK's tool system. Instead, the goal is to clean up the MCP layer: replace n8n-backed tools with direct API calls behind the same MCP interface, and evaluate which tools could additionally be exposed as direct TypeScript functions for non-Agent-SDK use cases (cloud API, Tauri app).

| Task | Acceptance Criteria |
|------|-------------------|
| Audit MCP tools for backend cleanup | List of all 25+ MCP tools. For each: current backend (n8n, direct API, file-based), target backend (direct googleapis, SQLite, etc.), migration status. |
| Replace n8n backends behind MCP interface | MCP tool registrations stay the same (agents still call them via MCP). Backends swap from n8n webhooks to direct API calls. No agent prompt changes needed. |
| Evaluate direct function exposure | For non-Agent-SDK use cases (cloud HTTP API, Tauri app): identify which MCP tools should also be callable as TypeScript functions. Design a shared interface. Don't break MCP — add direct call as an additional path. |

#### P2-D: Agent Model Refactor

| Task | Acceptance Criteria |
|------|-------------------|
| Design skill library | Each skill is a prompt template + tool scope definition. Skills map to current agent capabilities (see "Current Agents" table above for mapping). Example: "morning-brief" skill = morning-briefer's system prompt + its tool list. |
| Refactor to 4 general agents | 11 specialized agents → 4 general agents (communicator, researcher, analyst, monitor). Each agent has a base prompt + receives a skill overlay per task. |
| Update orchestrator routing | Orchestrator routes: incoming signal → pick agent + skill → spawn. Decision logic documented. Routing tested for all current task types (briefs, reviews, email triage, research, reminders, proactive). |
| Quality comparison | Run each brief/review type with both old (specialized) and new (general+skill) agents. Compare output quality. Document which approach wins per task type. Keep specialized agents as fallback if quality drops. |

#### P2-E: Cost Governance

| Task | Acceptance Criteria |
|------|-------------------|
| Per-task cost tracking | Every dispatch logs cost breakdown (input tokens, output tokens, model, total $) to SQLite. Queryable by task label, date range, agent. |
| Cost budget alerts | Configurable daily budget threshold. When exceeded, Telegram alert. Langfuse dashboard shows cost trends. |
| Evaluate per-worker budgets | Decision documented: enforce per-worker cost caps (kill worker if over budget) or just alert. Current state: tracked via /costs skill and Langfuse but no enforcement. |

---

### Phase 3: Desktop Companion (parallel with Phase 2)

Build Edith's visible presence on the desktop.

#### P3-A: Tauri App Scaffold

| Task | Acceptance Criteria |
|------|-------------------|
| Initialize Tauri v2 project | Rust backend + Svelte 5 frontend. Project builds and runs on macOS. |
| Menu bar tray icon | Tray icon with basic menu (show/hide companion, settings, quit). Click toggles floating window. |
| Frameless floating window | Transparent, always-on-top, non-activating `NSPanel` equivalent. Appears on all Spaces (`setVisibleOnAllWorkspaces`). Click-through by default — clicks pass to apps behind. Becomes interactive on hover/click on character. |
| WebSocket connection to cloud | Connects to Fly.io backend. Handles: reconnection on disconnect, authentication, message send/receive. |
| Basic text display | Speech bubbles from Edith render in the floating window. Test: send message from Telegram → appears as speech bubble on desktop. |

#### P3-B: Screen & Audio Capture

| Task | Acceptance Criteria |
|------|-------------------|
| Screen capture via screencapturekit-rs | Event-driven capture: fires on app switch, click, typing pause (not continuous). Frames captured as images with timestamp + foreground app name. |
| Audio capture via ScreenCaptureKit | System audio + mic from same API. Captures meeting audio, media playback. |
| Stream to cloud backend | Frames and audio chunks sent to cloud via WebSocket. Cloud stores and processes. Handles: buffering during disconnection, resume on reconnect. |
| Local storage layer | SQLite with timestamps + app context. Query by time range, app name, content (OCR text). Retention policy (e.g., 30 days local). |
| Query API | Cloud can request screen/audio history from device. Device responds with stored data. Used by: activity log, review agents, proactive monitor. |

#### P3-C: Screen Understanding

| Task | Acceptance Criteria |
|------|-------------------|
| Gemini Live API integration | WebSocket client to Gemini Live API. Sends frames at 1 FPS. Receives structured context summaries. Session management: ~10 min connection lifetime, 2hr resumption tokens, reconnection logic. Cost target: ~$0.28/hr at 1 FPS on Gemini 2.5 Flash. |
| Event-driven triggers | App switch → capture + understand. Click → capture. Typing pause (>3s) → capture. NOT continuous — only on meaningful events. |
| Context bridge | Gemini understanding → structured context update → orchestrator. Orchestrator decides: spawn worker, suggest, stay silent. |
| "Bonzi test" filter | Every proactive action passes: "Would this earn the interruption?" Stating the obvious → suppress. Researching a person before a meeting → do silently, report if useful. Configurable sensitivity. |
| Evaluate hybrid local+cloud pre-filter | Test OmniParser V2 (Microsoft, 0.6s local UI parsing) or Qwen3-Omni as cheap local pre-filter. Only send "interesting" frames to Gemini (app changed, new content detected, user seems stuck). Could cut Gemini costs significantly. Document results + decision. |
| Computer use / "take over" | When Randy says "do it for me" or "take over": switch to Claude computer use (screenshot-based UI control). Gemini Live provides real-time visual context, Claude handles actual mouse/keyboard interactions. OS-specific (macOS first). |

#### P3-D: Voice I/O

| Task | Acceptance Criteria |
|------|-------------------|
| TTS: Cartesia Sonic (cloud) | Cloud generates speech from Edith's text responses. Sub-90ms TTFB. Audio streamed to device via WebSocket. |
| TTS: Piper (offline) | Local TTS fallback when cloud unreachable. Lower quality but functional. |
| STT: Whisper/Groq | Voice input from desktop mic → transcribed → sent to orchestrator as text. Works alongside Telegram voice messages. |
| Speaker diarization | WhisperX for batch processing (post-meeting transcripts). Deepgram for real-time (live meeting context). Extracted speakers mapped to Cognee contacts when possible. |
| Audio playback | Tauri app plays TTS audio through system speakers. Volume control. Mute option. |

#### P3-E: Character & UX

| Task | Acceptance Criteria |
|------|-------------------|
| Rive character design | Character with state machine: idle (breathing/blinking), thinking (working animation), talking (speaking + speech bubble), listening (ear/antenna animation), sleeping (dimmed, night mode 9PM-7AM), alert (attention-getting but not annoying). Tiny .riv file. |
| Speech bubble UI | Messages appear as speech bubbles from character. Dismissable on click. Auto-fade after reading (configurable timeout). Markdown rendering for formatted content. |
| Worker progress display | Shows what Edith is doing: "Checking your email...", "Prepping for your 2pm meeting...", "Running weekly review...". Character shows "thinking" state during background work. |
| Settings panel | API keys (Claude, Gemini, Telegram), preferences (notification frequency, quiet hours, voice on/off), notification controls. Stored in macOS Keychain via Tauri. |
| Dark mode / light mode | Follows system preference. Character and speech bubbles adapt. |

#### P3-F: Offline Resilience

| Task | Acceptance Criteria |
|------|-------------------|
| Ollama detection + install prompt | On first launch: check if Ollama installed. If not, prompt user with install instructions + link. If installed, auto-pull llama3.2:1b model. |
| Cloud-to-local fallback | When WebSocket to cloud disconnects: switch to Ollama for basic queries. User sees "offline mode" indicator on character. |
| Queue complex tasks | Tasks that need Claude (briefs, reviews, email triage) queued locally. User notified: "I'll handle this when I'm back online." On reconnect: queued tasks sent to cloud in order. |
| Local caches | SQLite cache for: locations + geofence definitions, time-based reminders, recent conversation context, Edith's current state. All sync bidirectionally with cloud on reconnect. |
| State sync protocol | On reconnect: device pushes buffered screen/audio/location data + queued tasks. Cloud pushes missed messages + state updates. Conflict resolution: cloud wins for state, append-only for data. |

---

### Phase 4: Product Distribution (future — when ready)

Package Edith for end users.

#### P4-A: Packaging

| Task | Acceptance Criteria |
|------|-------------------|
| Tauri binary + code signing (macOS) | Signed .dmg that installs cleanly. Gatekeeper passes. Binary size target: <100MB. |
| Auto-updater | Tauri's built-in updater. Checks for updates on launch + daily. Silent background download, prompt to restart. |
| Installer onboarding flow | First launch: "Hi, I'm Edith. Let's get you set up." → Google OAuth (in-app via tauri-plugin-oauth) → Claude API key (or Anthropic account) → Optional Gemini key → Optional Telegram token → Done. |
| Windows support | Tauri v2 cross-platform build. Screen capture via DXGI. Keychain via Windows Credential Manager. Always-on-top behavior tested. |
| Linux support | Tauri v2 build. Screen capture via PipeWire. Keychain via libsecret. |

#### P4-B: Multi-User

| Task | Acceptance Criteria |
|------|-------------------|
| Per-user state isolation | Cloud DB has user_id on every table. No cross-user data leakage. |
| Per-user OAuth tokens | Each user's Google tokens stored separately, encrypted. Token refresh per-user. |
| Rate limiting + cost governance | Per-user daily/monthly cost caps. Alert user before hitting limit. Admin dashboard for usage. |
| User context through call chain | Replace module-level globals with user context object passed through dispatch → agent → tool calls. Enables multi-user without race conditions. |

#### P4-C: Privacy & Security

| Task | Acceptance Criteria |
|------|-------------------|
| Sensitive content detection | Screen captures scanned for: passwords, credit card numbers, banking pages, SSNs. Detected frames excluded from cloud upload or redacted. |
| Local-only processing option | User can opt out of cloud screen processing. All screen data stays on device, processed by Ollama only. |
| Encryption at rest | Cloud SQLite DB encrypted. OAuth tokens encrypted. Screen/audio data encrypted on Fly.io volumes. |
| GDPR compliance | Data export (all user data as JSON). Data deletion (complete wipe). Privacy policy. Retention policies. |

#### P4-D: Business

| Task | Acceptance Criteria |
|------|-------------------|
| Pricing model | Decision documented: subscription tiers, API usage-based, or hybrid. Cost analysis: what does one user cost to serve (Claude API, Gemini, Fly.io, storage)? |
| Landing page + distribution | Website with install instructions. Consider: Mac App Store, direct download, or both. |
| LLM cost strategy | Evaluate: negotiate Anthropic volume pricing, replace Claude with open model via agntk for some tasks, hybrid (Claude for orchestrator, open model for workers). |

---

## Open Questions

These need decisions before or during their relevant phase:

| Question | Relevant Phase | Current Status |
|----------|---------------|---------------|
| Per-worker cost budgets — enforce caps or just alert? | P2-E | Tracked via /costs skill + Langfuse, no enforcement |
| Linear vs GitHub Issues for backlog? | P1 | Using GitHub Issues. Evaluate Linear if volume grows. |
| Google Tasks + Contacts — add now or defer? | P2-B | Deferred pending need. Listed as potential. |
| Grafana unified dashboard — worth the setup for personal use? | P1-F | Two-layer (Langfuse + BetterStack) may be sufficient. Evaluate. |
| Screenpipe → Gemini transition timing | P3-C | Screenpipe stays as bridge during Phase 2. Replaced when Tauri capture + Gemini Live are stable. |

---

## Design Decisions Log

Decisions made during the 2026-03-30 architecture review:

1. **Product direction**: Not pursuing distribution now, but architect clean toward it
2. **Desktop companion**: Start building toward it now (Phase 3)
3. **Screen awareness**: Build capture into Tauri (own the layer), Gemini for understanding. Keep Screenpipe as bridge during transition
4. **Cloud-first**: Edith's brain moves to Fly.io. Devices are thin clients. Like WhatsApp multi-device
5. **Agent model**: Hybrid — fewer general agents (3-4) with skill-based scoping, not 11 specialized agents
6. **Error tracking**: Add Sentry alongside BetterStack
7. **Dashboard**: Kill it (after extracting reusable data-access functions to lib/). End users don't need it
8. **n8n**: Keep for POC, replace with direct googleapis in Phase 2. Migrate Google Docs first (reviews depend on it)
9. **MCP tools**: Keep MCP as the agent tool interface (Agent SDK requires it). Replace n8n backends behind MCP. Add direct function exposure for non-SDK use cases.
10. **Cognee**: Keep it — graph layer is valuable for relationship reasoning. Mem0 is backup if Python-only becomes a blocker
11. **Voice**: Cartesia Sonic (cloud) + Piper (offline). Edith speaks
12. **Offline**: Ollama + llama3.2:1b bundled in desktop app
13. **Cost governance**: Claude Max subscription for now, revisit at distribution
14. **UI framework**: Svelte 5 (not SvelteKit, not React) — lighter bundle, less boilerplate, better fit for companion app
15. **Vector DB**: LanceDB (file-based, embedded, already used by Cognee internally). NOT pgvector (requires Postgres, contradicts SQLite-only direction)
16. **Embedding model**: BAAI/bge-base-en-v1.5 — carry forward through any memory system changes (benchmarked: +1.27 MTEB over nomic, 2.5x smaller, faster on CPU, same 768 dims)

---

## Files This Replaces

| Old File | Status |
|----------|--------|
| PLAN.md | Superseded — Phase 1-2 done, Phase 3+ captured here. Delete. |
| NEXT-SESSION.md | Already deleted |
| docs/desktop-companion.md | Design reference — keep as detailed spec (updated React → Svelte 5), this file has the summary |
| docs/screen-awareness.md | Design reference — keep as detailed spec |
| docs/distribution.md | Design reference — keep as detailed spec |
| docs/data-sources.md | Design reference — keep as data source inventory (fix BLOCKER status, add activity log) |
| docs/review-templates.md | Design reference — keep as output spec (add activity log note) |
| ARCHITECTURE-V4.md | Keep as current-state reference, update stale sections per P1-D |
| BACKLOG.md | Superseded by this roadmap + GitHub Issues. Delete after issues created. |