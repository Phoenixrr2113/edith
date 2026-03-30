# Edith v4: Orchestrator Architecture

## North Star: The Cortana/Bonzi Spectrum

Edith is modeled on Cortana from Halo — an AI partner embedded in your life, not a tool you query. She sees what you see, knows your context, acts before you ask, and has real judgment about when to speak and when to stay silent.

The anti-pattern is Bonzi Buddy — the proactive desktop assistant that interrupted constantly with nothing useful. The line between Cortana and Bonzi is razor thin. Both are "proactive AI assistants." The difference is judgment.

**The twist**: Bonzi wasn't bad because it was quirky or visible — it was bad because it was dumb. A Bonzi with Cortana's brain would be delightful. Edith should be:
- **Cortana's brain** — smart, contextual, proactive with judgment, earns every interruption
- **Bonzi's charm** — visible presence, personality, character, not hidden in a chat window
- **Neither's worst traits** — not annoying, not a corporate AI voice, not spyware

### Design Principles

1. **Every interruption must earn its cost.** Randy's attention is the scarcest resource. If what you have isn't worth breaking his flow, don't.
2. **Do the work first, decide if it's worth mentioning second.** Don't say "I noticed X." Fix X, then tell him what you did.
3. **Silence is the default.** Speaking up is the exception that requires justification.
4. **Never state the obvious.** If Randy can see it on his screen, don't tell him. ("Looks like you're writing an email!" = Bonzi)
5. **Have a personality.** Sharp, witty, opinionated. A brilliant friend, not a corporate assistant.
6. **Be a presence, not a service.** Edith should feel like someone who's WITH you — not an app you open.

### The Presence Question

Edith needs a face. Not a status dashboard. Not just a Telegram chat. Something that makes her feel like a companion on your machine:
- Desktop widget / floating avatar / menu bar presence?
- Reacts to what's happening (screen awareness feeds state)
- Visual indicator of what she's doing (workers running, thinking, idle)
- Personality expressed through motion/state, not just text

This is an open design question — the form factor matters as much as the intelligence.

---

## Why

Edith v3 is single-threaded — one Claude session at a time, FIFO queue, busy flag. This means:
- Randy waits with no visibility while work runs (just a typing indicator)
- If a morning brief takes 3 minutes, messages queue up
- If something breaks mid-session, nobody knows until timeout
- 27 lib files handle queuing, session management, reflection, dead-letters — complexity from a fundamentally limited model

**v4 Goal**: Edith becomes an orchestrator that spawns sub-agents for work, stays responsive, and streams live progress to Telegram. Way more capability with way less code.

## Decision Log

- **Claude Desktop migration**: Abandoned. Claude Desktop's scheduler can't match Edith's battle-tested dispatch (dead-letter recovery, circuit breakers, session continuity, brief building). Delete the migrated scheduled tasks at `~/.claude/scheduled-tasks/` and services at `~/.claude/services/`.
- **Dashboard**: Deprioritized. `dashboard.ts` still exists (localhost:3456) but isn't actively maintained. Telegram is the primary visibility channel.
- **Orchestrator scope**: Brain handles lightweight tasks directly (quick questions, reminders, status checks). Only heavy work spawns workers.

---

## Architecture (Implemented)

### How It Works Today

**edith.ts** (TypeScript daemon) handles Telegram polling, scheduling, and dispatching. When a message or scheduled task arrives, it dispatches to a persistent Claude session via the Agent SDK.

**The orchestrator** is Edith herself (the Claude session). Her system prompt tells her to:
- Handle light tasks directly (quick questions, lookups, reminders)
- Spawn background agents via the Agent tool for heavy work (email triage, meeting prep, briefs)
- Stay responsive while background agents run

**Background agents** are defined in `.claude/agents/` with scoped tools and system prompts. They run as ephemeral sessions spawned by the Agent tool with `run_in_background: true`.

### Message Flow

```
Telegram message → edith.ts → dispatch to Claude session
  → Edith decides:
     Light? → handles directly (manage_calendar, send_message)
     Heavy? → spawns Agent with run_in_background: true
  → Background agent does the work (email, calendar, Cognee, files)
  → task_started / task_progress / task_notification events stream through
  → dispatch.ts logs all events
  → Agent finishes → Edith reads result, sends summary to Randy
```

### Scheduled Tasks

```
Scheduler fires "morning-brief" at 8:03
  → edith.ts dispatches to Claude session with "[Scheduled: morning-brief]"
  → Edith spawns morning-briefer agent in background
  → Agent does all the work
  → Edith stays free for incoming messages (when busy flag is resolved)
```

### Progress Visibility

Task events stream through the parent query and are logged by `dispatch.ts` to console and JSONL:
- `🚀 task_started` — agent spawned with description
- `📊 task_progress` — periodic updates with `last_tool_name`, token count, tool uses, duration
- `🏁 task_notification` — completion/failure with summary and usage stats

**Note:** These events are logged locally only. No live Telegram progress updates yet — Randy only sees the final result message when the agent completes.

### Verified Behavior (2026-03-28)

Test: "check my email from the last 24 hours, triage everything, prep for any meetings"
- Edith acknowledged immediately ("On it — triaging...")
- Spawned background agent: "Email triage and meeting prep"
- Agent ran 14 tool calls over 142 seconds
- Called: manage_emails, cognee search, manage_calendar, cognee cognify, send_message
- Sent results to Randy via Telegram: 2 actionable items flagged, 14 archived
- Total cost: $0.40

---

## What Changed (2026-03-28)

**No new modules needed.** The orchestrator pattern was achieved with:

- `prompts/system.md` — added orchestrator instructions (light vs heavy tasks, how to spawn background agents)
- `lib/dispatch.ts` — ~20 lines added to log `task_started`, `task_progress`, `task_notification` SDK events
- `.claude/agents/` — 10 agent definitions:
  - **morning-briefer** — calendar, email, Cognee, meeting prep, file prep (sonnet)
  - **midday-checker** — catch changes, prep afternoon, advance deadlines (sonnet)
  - **evening-wrapper** — day review, tomorrow prep, Cognee storage (sonnet)
  - **weekend-briefer** — family activities, local events, weather, beach (sonnet)
  - **email-triager** — scan inbox, archive noise, draft replies (sonnet)
  - **weekly-reviewer** — GTD weekly review, Google Doc output (sonnet)
  - **monthly-reviewer** — scorecard, life areas, retrospective (sonnet)
  - **quarterly-reviewer** — strategic review, trajectory (sonnet)
  - **researcher** — web + codebase research (sonnet)
  - **reminder-checker** — time-based reminders only (haiku)

The Agent tool handles spawning. `stopTask(taskId)` on the Query interface handles cancellation. No custom MCP tools, no WorkerPool class, no orchestrator module. Everything else (dispatch engine, session management, scheduler, Telegram) works as-is.

---

## Internal Subsystems (Underdocumented)

These systems exist in the codebase and are actively used, but weren't covered in the original architecture doc.

### Brief Building (`lib/briefs.ts`, `lib/prewake.ts`)
Before Claude wakes, Edith pre-fetches calendar and email from n8n and assembles a context brief. 8 brief types: boot, morning, midday, evening, message, location, scheduled, proactive. Pre-wake optimization saves Claude turns by front-loading context.

### Reflection System (`lib/reflector.ts`)
Observes running sessions and injects contextual feedback via `streamInput()`. Triggers after every Nth tool call, on context compaction, and on irreversible tool use (send_message, manage_emails writes). Guards geofencing-sensitive operations. Non-blocking fire-and-forget.

### Screen Awareness (`lib/screenpipe.ts`, `lib/gemini.ts`, `lib/audio-extract.ts`)
- **Screenpipe client** — health check, OCR + audio context, app usage tracking, continuous activity calculation
- **Gemini summarization** — Gemini 2.5 Flash for screen context summaries, skips LLM for trivial cases
- **Audio extraction** — Qwen 3 235B (OpenRouter) extracts structured knowledge from meeting audio (decisions, action items)

Workers (morning-briefer, midday-checker, evening-wrapper, reviewers) all have `mcp__screenpipe__activity-summary` in their allowed tools.

### Transcript Logging (`lib/transcript.ts`)
Every session is logged to JSONL — tool uses, text blocks, results, costs. Skips stream events to minimize size. Used for debugging and the `/costs` skill.

### Proactive Interventions (`lib/proactive.ts`)
Rate limiting infrastructure for proactive messages: quiet hours (22:00–08:00), per-category cooldowns (60min), max 2 interventions/hour. `canIntervene()` and `recordIntervention()` are wired into the MCP server. **Gap:** The trigger that decides WHEN to proactively intervene is not connected to the main loop — infrastructure exists but no automatic firing.

### Session Injection (`lib/session.ts`)
Tracks the active Agent SDK query handle. Exposes `streamInput()` for mid-session message injection — new messages/tasks inject into the running session instead of waiting in the dispatch queue.

### Caffeinate (`lib/caffeinate.ts`)
Prevents macOS sleep while Edith is running (`caffeinate -dis -w PID`).

### Idle Detection (`lib/screenpipe.ts`)
Uses macOS `ioreg -c IOHIDSystem` to read HIDIdleTime (nanoseconds since last keyboard/mouse input). `isUserIdle(thresholdSeconds = 300)` returns true when user has been idle >5 min. The scheduler (`lib/scheduler.ts`) checks idle once per tick and skips all interval-based tasks (proactive-check, check-reminders) when idle — no brief building, no LLM calls, nothing. Window-based tasks (morning/midday/evening) always fire regardless of idle since they run once at a fixed time.

### Activity Log (`lib/activity.ts`)
Source-agnostic record of what Randy was doing. Two tiers:

- **L1 snapshots** — appended automatically by `gatherScreenContext()` in `lib/briefs.ts` every time screen context is gathered (proactive-check every 10 min, midday-check at noon). Timestamped ~3-5 line blocks with apps, audio, context.
- **L2 daily summary** — generated by evening-wrap. Claude reads the day's L1 entries and writes a summary paragraph at the bottom of the file.

Files live at `~/.edith/activity/YYYY-MM-DD.md`, never rotated. MCP tool `get_activity` lets agents query: `days=1` for today, `days=7` for a week, `days=30` for a month. L2 summaries are returned when available, L1 entries as fallback.

**Screen context windows:** Proactive-check pulls 15 min (since last check). Midday-check pulls 240 min (full morning since 8am brief). Previously these were backwards (180 min proactive, 15 min midday).

---

## Next Steps

### Near-term (POC hardening)
- ~~Fix busy flag~~ Done — streamInput injection handles mid-session messages (see Known Limitations)
- ~~Add more agent types~~ Done — 10 agents covering briefs, reviews, email, research, reminders
- ~~Idle detection + scheduler gating~~ Done — macOS HIDIdleTime check, interval tasks skip when user idle >5 min (see Idle Detection)
- ~~Activity log system~~ Done — L1 snapshots every 10 min, L2 daily summaries, MCP tool for queries (see Activity Log)
- ~~Fix screen context windows~~ Done — proactive 180→15 min, midday 15→240 min (see Activity Log)
- Observability: Langfuse self-hosted — full trace of every LLM call, tool invocation, agent step (see Observability)
- Remove Docker dependency — run n8n as child process, Cognee via MCP stdio (see Embedded Services). Docker still required today.
- Clean up disabled Claude Desktop scheduled tasks at `~/.claude/scheduled-tasks/`
- Wire proactive intervention triggers into main loop (infrastructure built in lib/proactive.ts, trigger not connected)
- Stream task progress to Telegram (currently only logged to console/JSONL)

### Future (when ready)
- Desktop companion (Tauri + Rive) — see Desktop Companion section
- Screen awareness (Gemini Live API) — see Future: Real-Time Screen Awareness
- Product packaging — see Distribution: Edith as a Product
- Code cleanup — remove unused lib files as orchestrator pattern proves stable

---

## Future: Real-Time Screen Awareness (v5 vision)

### The Idea
Kill Screenpipe. Stream Randy's screen to Gemini Live API continuously. Edith watches what he's doing in real-time, researches in the background, offers contextual suggestions, and can take over tasks when asked.

### What's Viable Now

**Passive screen awareness via Gemini Live API:**
- Native screen share via WebSocket, 1 FPS, 320ms latency
- Cost: ~$2.22/8hr day on Gemini 2.5 Flash (viable for always-on)
- Session limits: unlimited with context compression, ~10min connection lifetime with 2hr resumption tokens
- Replaces Screenpipe's OCR snapshots with actual visual understanding
- Could trigger Edith workers based on what Randy is doing (e.g., sees him in a code editor → spawns a worker to research the library he's using)

**Architecture sketch:**
```
Screen capture (macOS) → Gemini Live API (1 FPS, always watching)
  → Gemini understands context: "Randy is writing TypeScript in VS Code, file: auth.ts"
  → Sends context updates to Edith orchestrator
  → Orchestrator decides: spawn worker for background research? offer suggestion? stay silent?
  → If Randy asks "take over" → Claude computer use kicks in (screenshot-based, proven)
```

### What's NOT Viable Yet

**Real-time computer control with video feedback:**
- The bottleneck is LLM thinking time (1-5s per decision), not screenshot capture (~100ms)
- Continuous video wouldn't make computer use faster — the AI still thinks at the same speed
- Current best: Claude Opus 4.6 at 72.7% on OSWorld, 2-5s per action cycle
- Later steps take ~3x longer as context window grows (quadratic prefill)

**The hybrid pattern (emerging but unshipped):**
- Fast local model (OmniParser V2, Microsoft, 0.6s on A100) for UI element parsing
- Smart remote model (Claude/GPT-4o) for decision-making only when triggered
- SAM2 (Meta, open source) for real-time object tracking at 13-44 FPS — could track cursor/windows but not designed for UI
- Nobody has combined these into a working computer-use agent yet

### Cost Analysis

| Approach | Cost/hour | 8hr day |
|----------|-----------|---------|
| Gemini Flash passive watching (1 FPS) | ~$0.28 | ~$2.22 |
| Hybrid: local model + Gemini on change detection | ~$0.25 | ~$2.00 |
| GPT-4o continuous (1 FPS, high detail) | ~$9.94 | ~$79.50 |
| Claude Sonnet continuous (1 FPS) | ~$11.95 | ~$95.60 |

Gemini Flash is ~40x cheaper than alternatives for image-heavy workloads. Only viable option for always-on.

### Implementation Path (not yet planned)
1. Screen capture module (macOS CGDisplayStream or similar → frames)
2. Gemini Live API WebSocket client (send frames, receive context summaries)
3. Context bridge → Edith orchestrator (structured updates about what Randy is doing)
4. Proactive worker spawning (research, suggestions based on screen context)
5. Computer use integration (Claude screenshot-based, triggered on "take over" requests)

### Key References
- Gemini Live API: native screen share, 258 tokens/sec video
- OmniParser V2 (Microsoft): local UI parsing, 0.6s on A100
- StreamingVLM (MIT/NVIDIA): unbounded video VLM at 8 FPS on H100 (research)
- GetStream Vision Agents: open source SDK wrapping Gemini Live + YOLO
- Dispider (CVPR 2025): parallel perception/decision/reaction for video LLMs
- OSWorld-Human paper: LLM prefill is 75-94% of agent latency

---

## n8n as Integration Backend

n8n already handles Gmail and Calendar via webhooks. The pattern: **build integrations as n8n workflows, expose as webhook endpoints, Edith calls them like APIs.** n8n becomes Edith's integration backend — handles OAuth, retries, and error handling. Visually editable without touching code.

### Current n8n Workflows
- `calendar` — get, create, update, delete events (both Google accounts)
- `gmail` — get, send, reply, draft, archive, trash, batch manage (both accounts)
- `docs` — create Google Docs with content
- `notify` — route notifications to Telegram, WhatsApp, SMS

### Not in n8n (direct API)
- **Transcription** — Groq Whisper via `mcp/server.ts` (n8n HTTP Request had connectivity issues)
- **SMS/WhatsApp** — `lib/twilio.ts` handles directly for the MCP `send_notification` tool
- **Image gen** — Google Imagen via `@google/generative-ai` SDK

### Potential Future Workflows
- **google-tasks** — create, list, update tasks
- **google-drive** — search, read, share docs
- **google-contacts** — lookup, create contacts

### How It Connects

```
Edith spawns background agent (Agent tool, run_in_background: true)
  → Agent needs to read emails
  → Agent calls manage_emails MCP tool
  → MCP tool POSTs to n8n webhook: POST /webhook/gmail { action: "get", hoursBack: 4 }
  → n8n handles OAuth, pagination, formatting
  → Returns structured data to Agent
  → Agent drafts replies, calls manage_emails to send
  → MCP tool POSTs to n8n: POST /webhook/gmail { action: "send", to: "...", body: "..." }
```

### MCP Server Structure

`mcp/server.ts` (540+ lines) registers 25+ tools. Most Google tools are thin wrappers around `n8nPost()`. Telegram, Twilio, image generation, and transcription call APIs directly. See `n8n/WORKFLOWS.md` for details on what's in n8n vs direct API.

### What n8n Does NOT Handle
- Orchestrator brain (persistent Claude session — Agent SDK only)
- Worker pool (parallel Claude sessions — Agent SDK only)
- Telegram polling (needs persistent connection, not webhook-friendly for real-time)
- Desktop companion (Tauri app, local process)
- Screen awareness (Gemini Live stream, local process)
- Cognee memory (separate Docker service, MCP)

### Tradeoff
More n8n = less TypeScript code, easier to modify integrations, visual editing. But adds a dependency — n8n must be running and healthy. Current setup already depends on n8n for Gmail/Calendar, so this just extends that pattern.

### n8n and Distribution: The Problem

n8n **cannot** be bundled in a packaged app for end users:
- **$50K/year embed license** — required for any product that ships n8n to users
- **OAuth injection broken** — n8n's API blocks writing `oauthTokenData`, so the parent app can't handle Google login and pass tokens to n8n. Users would see n8n's UI.

**For a packaged product, n8n gets replaced entirely:**
- Google OAuth handled natively via `tauri-plugin-oauth` (login screen in Edith's app UI)
- `googleapis` npm package for Gmail, Calendar, Drive, Tasks, Contacts
- Tokens stored in macOS Keychain / Windows Credential Manager (secure, automatic)
- No background process, no licensing fees

**The transition path:**
```
Now (personal use):
  n8n handles Gmail/Calendar — quick, visual, already working

Packaged product (later):
  Tauri app handles OAuth + Google APIs directly
  n8n goes away entirely
  MCP tool interface stays identical — workers don't know the difference
```

This means the MCP tool layer (`manage_emails`, `manage_calendar`) is an abstraction that can swap backends without changing anything upstream.

---

## Desktop Companion (Tauri App)

Edith needs a face — not a dashboard, a character. A visible presence on the desktop like a smart Bonzi Buddy.

### Tech Stack
- **Tauri v2** — Rust + web view, 30-50MB RAM (vs Electron's 150-300MB)
- **Rive** — character animation with state machine (idle, thinking, talking, sleeping). Free editor, tiny `.riv` files. Used by Duolingo.
- **React** — UI chrome (speech bubbles, status indicators)
- Transparent, frameless, always-on-top window with click-through

### How It Works
- `NSPanel` equivalent via Tauri: floating, non-activating, appears on all Spaces
- Click-through when not interacting (clicks pass to apps behind)
- Character reacts to Edith's state: idle (nothing happening), thinking (worker running), talking (message from Edith), sleeping (night mode)
- Speech bubbles for messages alongside Telegram
- Can show worker progress visually (character "working" animation + subtle status text)

### Connection to Edith
- Connects to orchestrator via WebSocket or local HTTP
- Another input/output channel alongside Telegram
- Can accept voice input (mic → transcribe → orchestrator)
- Can show screen awareness reactions (Edith noticed something)

### Reference Projects
- **WindowPet** (Tauri + React + Phaser) — overlay/window mechanics
- **Open-LLM-VTuber** (Electron + Live2D + LLM) — AI companion with desktop pet mode

---

## Distribution: Edith as a Product

### The Vision
A downloadable app anyone can install. No Docker, no n8n, no Screenpipe, no terminal. Just Edith.

### Install Experience
```
1. Download Edith.dmg (macOS) / Edith.exe (Windows) / Edith.AppImage (Linux)
2. Open → Edith appears on your desktop
3. "Hi, I'm Edith. Let's get you set up."
4. Sign in with Google (OAuth in-app) → Gmail, Calendar, Drive, Tasks connected
5. Enter Claude API key (or sign in with Anthropic account)
6. Optional: Enter Gemini API key for screen awareness
7. Done — Edith is watching, thinking, helping
```

### What's Inside the Binary

| Component | Technology | Purpose |
|-----------|-----------|---------|
| Desktop companion | Tauri v2 + Rive | The visible character, UI, speech bubbles |
| Orchestrator brain | Claude Agent SDK | Persistent session, decision-making |
| Worker pool | Claude Agent SDK | Parallel ephemeral sessions for work |
| Google integrations | googleapis + tauri-plugin-oauth | Gmail, Calendar, Drive, Tasks, Contacts |
| Screen awareness | Gemini Live API | Real-time screen understanding (optional) |
| Memory | Local SQLite + vector embeddings | Replaces Cognee for packaged version |
| Notifications | Native OS notifications | macOS/Windows/Linux |
| Voice | Whisper API or local model | Speech-to-text input |

### What the User Provides
- Claude API key (or Anthropic account login)
- Google account (OAuth — handled in-app)
- Optional: Gemini API key for screen awareness
- Optional: Telegram bot token (for mobile access)

### What Goes Away
- Docker (no containers)
- n8n (direct API calls instead)
- Screenpipe (Gemini Live API instead)
- Cognee (local SQLite + embeddings instead)
- Bun runtime (Tauri bundles everything)
- Terminal / CLI (desktop app only)
- Manual env var configuration

### Architecture Layers (Product Version)

```
┌─────────────────────────────────────────────┐
│              Tauri Desktop App               │
│  ┌─────────┐  ┌──────────┐  ┌───────────┐  │
│  │  Rive   │  │  Speech  │  │  Settings  │  │
│  │Character│  │ Bubbles  │  │   Panel    │  │
│  └────┬────┘  └────┬─────┘  └─────┬─────┘  │
│       └────────────┼──────────────┘         │
│                    │                         │
│  ┌─────────────────┴─────────────────────┐  │
│  │         Orchestrator Brain             │  │
│  │    (Persistent Claude Session)         │  │
│  └──┬──────────┬──────────┬──────────┬──┘  │
│     │          │          │          │      │
│  ┌──┴──┐  ┌───┴──┐  ┌───┴──┐  ┌───┴──┐   │
│  │Work-│  │Work- │  │Work- │  │Work- │   │
│  │er 1 │  │er 2  │  │er 3  │  │er 4  │   │
│  └──┬──┘  └──┬───┘  └──┬───┘  └──┬───┘   │
│     └────────┼─────────┼────────┘         │
│              │         │                    │
│  ┌───────────┴─────────┴─────────────────┐  │
│  │        Integration Layer               │  │
│  │  Gmail │ Calendar │ Drive │ Contacts   │  │
│  │  (googleapis + OAuth tokens)           │  │
│  └───────────────────────────────────────┘  │
│                                              │
│  ┌──────────┐  ┌──────────┐  ┌───────────┐  │
│  │  Local   │  │  Gemini  │  │ Telegram   │  │
│  │  Memory  │  │  Screen  │  │  Bridge    │  │
│  │ (SQLite) │  │ (Live API)│ │ (optional) │  │
│  └──────────┘  └──────────┘  └───────────┘  │
└─────────────────────────────────────────────┘
```

### Phasing Strategy

**Phase 1 — POC (now):** Build everything on n8n + Claude Agent SDK + Bun. Fast iteration, visual workflows, already working. Ship the orchestrator/worker architecture, screen awareness, desktop companion. Get it working for Randy.

**Phase 2 — Polish (when it works):** Harden the system, tune the orchestrator prompt, add more n8n workflows for new integrations. Still personal use. n8n is fine here.

**Phase 3 — Product (if/when investors):** Replace n8n with direct API calls in Rust/Node. Replace Cognee with bundled SQLite + vector DB. Package as Tauri binary. Build onboarding flow. This is the expensive phase — only do it if there's a business case.

**The MCP tool interface is the abstraction boundary.** `manage_emails`, `manage_calendar`, `send_notification` — same inputs, same outputs, regardless of backend. Workers and the orchestrator never know what's behind the tools. Swap n8n for native code without touching anything upstream.

### Cross-Platform Considerations
- Tauri v2 supports macOS, Windows, Linux
- Screen capture APIs differ per OS (macOS: CGDisplayStream, Windows: DXGI, Linux: PipeWire)
- Keychain/credential storage is OS-specific (Tauri handles this)
- Always-on-top window behavior varies (Tauri abstracts most of it)
- Computer use (when added) is OS-specific (mouse/keyboard control)

---

## Embedded Services (No Docker)

Docker has been a pain point — port conflicts, stale containers, extra dependency. Both n8n and Cognee can run without Docker.

### n8n (child process)
- `npx n8n start` — Node.js app, SQLite by default, no Postgres
- Edith spawns as child process in `launch-edith.sh`
- Point `N8N_USER_FOLDER` at `./n8n/data` (existing workflows + credentials carry over)
- Set `N8N_ENCRYPTION_KEY` from `.env` (must match across restarts)
- ~100MB RAM idle
- Import workflows: `n8n import:workflow --input=./workflows.json`

### Cognee (MCP stdio)
- Switch from Docker SSE to local stdio mode in `.mcp.json`:
  ```json
  "cognee": { "command": "uv", "args": ["--directory", "./cognee-mcp", "run", "cognee"] }
  ```
- Uses SQLite + LanceDB + NetworkX — all file-based, zero servers
- Embedding model upgrade: **`BAAI/bge-base-en-v1.5`** (replaces nomic-embed-text-v1.5)
  - +1.27 MTEB points (63.55 vs 62.28)
  - 2.5x smaller (210MB vs 520MB)
  - Faster on CPU (~22ms vs ~42ms per 1K tokens)
  - Same 768 dims — drop-in replacement
  - No prefix prompts needed
- Config: `EMBEDDING_PROVIDER=fastembed`, `EMBEDDING_MODEL=BAAI/bge-base-en-v1.5`

### Result
`launch-edith.sh` becomes:
1. Start n8n as child process
2. Start Edith (Cognee starts automatically via MCP stdio)
3. Done — no Docker, no port conflicts, no stale containers

---

## Observability

### Service URLs

| Service | URL | Login | Purpose |
|---------|-----|-------|---------|
| **Langfuse** | http://localhost:3000 | randy@edith.local / edith-local | LLM traces, cost dashboard, latency analysis |
| **BetterStack Logs** | https://telemetry.betterstack.com | (your BetterStack account) | Structured logs, search, alerts |
| **BetterStack Uptime** | https://uptime.betterstack.com | (your BetterStack account) | Heartbeat monitoring, incident alerts |
| **n8n** | http://localhost:5679 | admin / (N8N_PASSWORD in .env) | Workflow automation |
| **Cognee** | http://localhost:8001 | — | Memory/knowledge graph |
| **GitHub Project** | https://github.com/users/Phoenixrr2113/projects/1 | — | Task backlog and pipeline |

### Problem
Edith is hard to debug. Errors surface only in console logs. There's no way to trace a user message through dispatch → agent → tool calls → LLM responses → final output. Cost tracking is manual (`/costs` skill parses events.jsonl). When something breaks, diagnosing requires re-reading all the code.

### Solution: Two-Layer Observability

**Layer 1 — LLM Tracing: Langfuse (self-hosted, free)**

Open-source LLM observability, self-hosted via Docker Compose. Unlimited, nothing leaves the machine.

What it traces automatically:
- Every Claude Agent SDK dispatch (input prompt, output, cost, latency, token counts)
- Every tool call within a session (MCP tools, Agent spawns)
- Background agent steps (sub-traces nested under parent)
- Gemini and OpenRouter calls (via OTEL instrumentation)
- Full request/response for debugging

Setup:
1. Add Langfuse stack (Postgres + Clickhouse + Redis + Langfuse) to `launch-edith.sh` via Docker Compose
2. Install `@arizeai/openinference-instrumentation-claude-agent-sdk` + `@langfuse/otel`
3. Programmatic OTEL init at top of `edith.ts` (before all other imports — required for Bun)
4. Auto-instruments: every `query()` call in `dispatch.ts`, every MCP tool invocation, every agent spawn

UI at localhost:3000:
- Trace waterfall: see every step of a morning-brief from dispatch to final Telegram message
- Cost dashboard: per-task, per-day, per-model cost breakdown
- Latency analysis: which tasks are slow, which tool calls timeout

**Layer 2 — Infra/Ops: BetterStack (cloud, free tier)**

Structured logging, uptime monitoring, error tracking, incident management.

What it covers:
- Daemon health heartbeats (edith.ts alive? n8n alive? Screenpipe alive?)
- Structured operational logs (startup, shutdown, errors, task completions) via `@logtail/node`
- Error tracking with stack traces and context
- Uptime alerts (Edith down, n8n unreachable)
- Incident management (create, acknowledge, resolve)
- ClickHouse SQL queries against log history

Setup:
1. Install `@logtail/node` (Bun-compatible, first-class TS)
2. Replace bare `console.log/error` with structured Logtail calls in critical paths
3. Add heartbeat pings from `edith.ts` main loop
4. BetterStack MCP server (`https://mcp.betterstack.com`) — lets Edith query her own logs and manage incidents

Free tier: 3 GB logs, 3-day retention, 10 monitors, 100k exceptions/month.

**Why both:** Langfuse can't do heartbeats or uptime alerts. BetterStack can't trace LLM prompts or tool calls. Zero overlap, full coverage.

### Integration Detail

**Langfuse — passive, zero-touch**

A telemetry init file runs before all other imports. OTEL hooks into the Claude Agent SDK automatically — no changes to dispatch.ts or any business logic.

```typescript
// lib/telemetry.ts — imported FIRST in edith.ts, before all other imports
import { NodeSDK } from "@opentelemetry/sdk-node";
import { LangfuseExporter } from "@langfuse/otel";
import { ClaudeAgentSdkInstrumentation } from "@arizeai/openinference-instrumentation-claude-agent-sdk";

new NodeSDK({
  traceExporter: new LangfuseExporter({ baseUrl: "http://localhost:3000" }),
  instrumentations: [new ClaudeAgentSdkInstrumentation()],
}).start();
```

Every `query()` call, tool invocation, and agent spawn is traced automatically. Edith's code doesn't know Langfuse exists. Randy opens `localhost:3000` to see waterfall traces, cost breakdowns, latency analysis.

**BetterStack — active logger + heartbeats + MCP**

Three integration points:

1. **Structured logger** — replaces key `console.log/error` calls in critical paths:
```typescript
// lib/logger.ts
import { Logtail } from "@logtail/node";
export const log = new Logtail(process.env.BETTERSTACK_TOKEN!);

// In dispatch.ts:
log.info("Dispatch started", { label: "morning-brief", session: sessionId });
log.error("Dispatch failed", { label, error: errMsg, duration_ms: elapsed });
```

2. **Heartbeat** — pings from the scheduler tick loop. If Edith crashes or hangs, BetterStack alerts:
```typescript
// In edith.ts scheduler interval:
fetch("https://uptime.betterstack.com/api/v1/heartbeat/xxx").catch(() => {});
```

3. **MCP server** — Edith can query her own logs. When Randy asks "any errors today?", Edith calls the BetterStack MCP tool, runs ClickHouse SQL against the log history, and reports back. Add to `.mcp.json` or use the remote MCP at `https://mcp.betterstack.com`.

**What each layer answers:**

| Question | Layer |
|----------|-------|
| "Why did the morning brief cost $0.40?" | Langfuse — trace waterfall shows each tool call + tokens |
| "What prompt did proactive-check send?" | Langfuse — full input/output for every dispatch |
| "Did Edith crash last night?" | BetterStack — heartbeat gap triggers alert |
| "How many poll errors this week?" | BetterStack — ClickHouse SQL against structured logs |
| "Which tasks are slowest?" | Langfuse — latency analysis per task label |
| "Is n8n healthy right now?" | BetterStack — uptime monitor |

**Alternatives considered and rejected:**
- **OpenLIT** — simpler but weaker agent tracing UI than Langfuse
- **LangSmith** — broken subagent tracing (GitHub issue #2091), cloud-only for non-enterprise
- **Sentry** — good for errors but no LLM trace analysis, overlaps with BetterStack
- **Datadog** — expensive, cloud-only, overkill for local daemon

---

## Development Process (Planned)

### Problem
Edith is developed ad-hoc — no pre-commit checks, no CI, no integration tests, no backlog, no specs. Bugs are discovered when Randy runs the app and reads logs. Type errors and broken imports ship because nothing runs `tsc` before code lands. Unit tests cover isolated functions but nobody tests the actual dispatch → agent → tool call flows that break in production.

### Pre-Commit Hook
Husky + pre-commit hook running `tsc --noEmit` + `bun test`. Takes 2 seconds, catches type errors and regressions before they land.

### CI: GitHub Actions
Runs on push to main:
- `tsc --noEmit` — type check
- `bun test` — full test suite
- Blocks broken code from landing

### Integration Tests
Test the real flows end-to-end with mocked LLM calls:
- Scheduler tick → `shouldFire()` → brief building → activity log write
- Message received → dispatch → tool calls → response
- Dead-letter save → restart → replay → delivery
- Idle detection → scheduler skips interval tasks

### Task Pipeline: Audit → Plan → Execute → Verify

No off-the-shelf tool does "audit existing project docs against existing code and generate tasks." Taskmaster, spec-kit, etc. are all designed for new projects from a PRD. For an ongoing project like Edith, we build the loop ourselves using Claude Code agents and skills.

**Architecture:**

```
┌──────────────────────────────────────────────────────────────┐
│                    Task Pipeline                             │
│                                                              │
│  1. AUDIT (agent: project-auditor)                           │
│     Reads: ARCHITECTURE-V4.md, docs/*, prompts/*,            │
│            .claude/agents/*, CLAUDE.md, TODO comments         │
│     Cross-refs: actual code in lib/, mcp/, edith.ts          │
│     Output: gap report → GitHub Issues (ATS format)          │
│                                                              │
│  2. PLAN (skill: /plan-task)                                 │
│     Input: GitHub Issue with ATS spec                        │
│     Validates: file ownership, dependencies, scope           │
│     Output: approved ATS in issue body, status: ready        │
│                                                              │
│  3. EXECUTE (skill: /work-task)                              │
│     Pulls next `ready` issue via `gh issue list`             │
│     Reads ATS spec from issue body                           │
│     Implements with file ownership enforced                  │
│     Runs verification commands from ATS                      │
│     Output: code changes + PR linked to issue                │
│                                                              │
│  4. VERIFY (skill: /verify-task)                             │
│     Runs acceptance criteria from ATS                        │
│     Type check + tests + integration check                   │
│     Updates issue: complete or failed + notes                │
│                                                              │
│  Scheduling: run audit weekly or on-demand via /audit        │
│  Store: GitHub Issues with labels (ats, ready, in-progress,  │
│         complete, failed) — queryable via gh CLI              │
└──────────────────────────────────────────────────────────────┘
```

**Components to build:**

1. **`.claude/agents/project-auditor.md`** — Explore agent that:
   - Reads every doc file (ARCHITECTURE-V4.md, docs/*, CLAUDE.md, prompts/*)
   - For each requirement/feature/plan mentioned, searches the codebase to verify status
   - Categorizes: implemented, partially implemented, gap, broken, outdated
   - Creates GitHub Issues for gaps using ATS YAML format (see below)
   - Uses Randy's custom system prompt (Section 7 ATS template from his agent rules)

2. **`.claude/skills/plan-task/SKILL.md`** — Takes a GitHub Issue #, validates the ATS spec:
   - Confirms files in `ownership.modifies` exist
   - Checks `dependencies.blocked_by` tasks are complete
   - Estimates context tokens
   - Marks issue as `ready` with label

3. **`.claude/skills/work-task/SKILL.md`** — Pulls next `ready` issue:
   - `gh issue list --label ready --label ats --json number,title,body --limit 1`
   - Parses ATS YAML from issue body
   - Implements following the approach/steps
   - Runs verification commands
   - Creates PR linked to issue
   - Updates issue status label

4. **`.claude/skills/verify-task/SKILL.md`** — Post-implementation verification:
   - Runs all commands in `verification.automated`
   - Checks acceptance criteria
   - Updates issue: `complete` or `failed` with notes

**Task store: GitHub Issues + GitHub Projects**

Two layers — Issues for the data, Projects for the workflow:

**GitHub Issues** (data layer):
- Bugs and gaps auto-created by `/audit` agent
- ATS YAML specs stored in issue body (collapsible `<details>` block)
- Labels for type: `ats`, `bug`, `gap`, `improvement`
- Labels for domain: `observability`, `activity-log`, `scheduler`, `dispatch`, `mcp`, etc.
- Queryable: `gh issue list --label ats --json number,title,body`
- PRs reference issues, issues reference PRs

**GitHub Projects** (workflow layer):
- Board view with status columns: `Backlog → Ready → In Progress → Done → Failed`
- Custom fields: `priority`, `complexity`, `domain`, `blocked_by`, `estimated_tokens`
- Automation: auto-move to "Done" on PR merge, auto-move to "In Progress" when `/work-task` starts
- Roadmap view for milestone planning
- Table view for triage and prioritization

**How agents interact with it:**
```bash
# Audit agent creates issue + adds to project
gh issue create --title "..." --body "..." --label ats,gap,scheduler
gh project item-add PROJECT_NUMBER --owner OWNER --url ISSUE_URL

# /work-task pulls next ready item
gh project item-list PROJECT_NUMBER --format json --limit 1  # filter by status=Ready
gh project item-edit --id ITEM_ID --field-id STATUS_FIELD --value "In Progress"

# /verify-task updates on completion
gh project item-edit --id ITEM_ID --field-id STATUS_FIELD --value "Done"
# or on failure:
gh project item-edit --id ITEM_ID --field-id STATUS_FIELD --value "Failed"
```

All free, all via `gh` CLI, no MCP server needed. Full visibility in GitHub's web UI.

**Randy's system prompt** (agent rules with ATS template, strict code standards, security checklist) is embedded in the agent/skill definitions. Every task execution follows: Understand → Research → Validate → Plan → Implement → Verify.

**What this replaces:**
- Ad-hoc development (ideas scattered across docs and chat)
- Manual bug discovery (audit catches gaps and broken features)
- No verification (each task has explicit acceptance criteria and commands)

**Note:** Randy built `feature-spec.com` (at `~/Desktop/teature-spec-app`) — a full-featured spec authoring platform. It's a product for writing detailed PRDs, not a task tracker. Could generate ATS specs for major features, with tasks pushed to GitHub Issues for execution.

---

## Known Limitations

### Busy flag mitigated with streamInput injection
The dispatch engine's `busy` flag in `lib/dispatch.ts` is set to `true` while the orchestrator session is running. When a new message or scheduled task arrives while busy, `dispatch()` now attempts `streamInput()` injection into the active session (line 296-301). If injection succeeds, the message is handled inline without queuing.

**Remaining gap:** If injection fails (e.g., session not in a state that accepts input), `skipIfBusy` tasks are still dropped. In practice this is rare — most injections succeed.

---

## Resolved Questions

- **Worker results → orchestrator?** Resolved: `task_notification` SDK events stream back automatically. Orchestrator reads the summary and acts on it. See `dispatch.ts` line 196.
- **Screenpipe access?** Resolved: Workers (midday-checker, evening-wrapper, morning-briefer, reviewers) have `mcp__screenpipe__activity-summary` in their allowed tools. Orchestrator accesses it through workers, not directly.
- **Context window fills up?** Handled by Claude Code's automatic context compression. Sessions continue with compressed history.
- **Sub-workers?** No. Flat structure — orchestrator spawns agents, agents don't spawn sub-agents.

## Open Questions

- Cost budget per worker? Per day? Alert thresholds? (Currently tracked via `/costs` skill but no enforcement. Langfuse will provide per-task cost dashboards when implemented.)
- Linear vs GitHub Issues for backlog? (Start with GitHub Issues, evaluate Linear if needed.)
- SDD MCP server vs spec-kit for spec workflow? (Start lightweight, upgrade if valuable.)
