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
- **Dashboard**: Killed. Telegram progress updates give enough visibility. Dashboard was extra maintenance.
- **Orchestrator scope**: Brain handles lightweight tasks directly (quick questions, reminders, status checks). Only heavy work spawns workers.

---

## Architecture: Three Layers

### Layer 1: edith.ts (TypeScript daemon)
Pure TypeScript. No Claude session. Always alive.
- Polls Telegram (30s long-poll)
- Runs scheduler (60s tick)
- Manages worker pool (spawn, monitor, cancel)
- Routes messages to the orchestrator brain
- Relays worker progress to Telegram

### Layer 2: Orchestrator Brain (persistent Claude session)
A long-lived Claude session that IS Edith's intelligence.
- Receives all Telegram messages via `streamInput()`
- Decides what to do: answer directly OR spawn a worker
- Has MCP tools: `spawn_worker`, `list_workers`, `worker_status`, `cancel_worker` + conversation tools (`send_message`, etc.)
- Handles lightweight tasks directly (quick questions, reminders, "what's happening?")
- Never does heavy work (no email scanning, no meeting prep, no research)
- Persistent session survives across messages (like current model)

### Layer 3: Workers (ephemeral Claude sessions)
Short-lived sessions for actual work.
- Spawned by the orchestrator via `spawn_worker(prompt, label)` MCP tool
- Each gets full MCP tool access (calendar, email, Cognee, web, files)
- Runs independently — multiple can run in parallel (max 4)
- Progress streamed to Telegram via edith.ts
- Results optionally injected back into orchestrator for context

---

## Message Flows

### Incoming Telegram Message
```
Telegram → edith.ts
  → forward to orchestrator brain via streamInput()
  → brain decides:
     Light task? → handles directly (send_message reply)
     Heavy task? → calls spawn_worker("research X and draft reply", "user-request")
  → edith.ts receives spawn_worker tool call
  → starts ephemeral query() with the prompt
  → sends Telegram: "⚡ Working on it..."
  → streams progress: "⚡ searching web... checking email... drafting..."
  → worker finishes → "✅ Done (18s, 6 turns)"
  → worker's final output sent as Telegram message
```

### Scheduled Task
```
Scheduler fires "morning-brief" at 8:03
  → edith.ts injects into orchestrator: "[Scheduled: morning-brief] Run the morning brief."
  → orchestrator calls spawn_worker with morning brief prompt
  → worker does all the work (calendar, email, Cognee, prep)
  → progress streams to Telegram
  → worker sends brief via send_message when done
```

### Meta-question ("what's happening?")
```
Randy: "what are the agents doing?"
  → orchestrator calls list_workers()
  → gets back: [{id: "w-1", label: "morning-brief", status: "running", elapsed: "45s", lastTool: "manage_emails"}]
  → orchestrator replies directly via send_message
```

---

## Progress Reporting

Each worker gets ONE Telegram message that edits in place (`editMessageText` API):

```
⚡ morning-brief: starting...
⚡ morning-brief: manage_calendar (5s)
⚡ morning-brief: manage_emails (12s)
⚡ morning-brief: cognee search (18s)
✅ morning-brief complete (25s, 8 turns, $0.04)
```

- Debounced: edits every 3s max (Telegram rate limits)
- Tool names extracted from `assistant` messages with `tool_use` blocks
- Final edit includes duration, turns, cost
- Worker's actual output (the brief, the reply, etc.) sent as a separate message

---

## Orchestrator Implementation (Confirmed)

**No new modules needed.** The Agent SDK's background task system handles everything:

### How It Works
1. Edith (Claude) receives messages via the existing dispatch engine
2. For heavy work, she uses the **Agent tool** with `run_in_background: true`
3. Background agents are defined in `.claude/agents/` with scoped tools and system prompts
4. Task events stream through the parent query:
   - `task_started` — agent spawned, includes description
   - `task_progress` — periodic updates with `last_tool_name`, token count, tool uses
   - `task_notification` — completion/failure with summary and usage stats
5. `dispatch.ts` logs these events; could relay to Telegram for visibility
6. Edith stays responsive while agents work in background

### Agent Definitions (`.claude/agents/`)
- **morning-briefer** — calendar, email, Cognee, meeting prep, file prep (sonnet)
- **midday-checker** — catch changes, prep afternoon, advance deadlines (sonnet)
- **evening-wrapper** — day review, tomorrow prep, Cognee storage (sonnet)
- **email-triager** — scan inbox, archive noise, draft replies (sonnet)
- **researcher** — web/codebase research, Cognee storage (sonnet)
- **reminder-checker** — check and fire due reminders (haiku)

### What Changed
- `prompts/system.md` — orchestrator instructions (light vs heavy tasks, how to spawn agents)
- `lib/dispatch.ts` — ~20 lines added for task event logging (task_started, task_progress, task_notification)
- `.claude/agents/` — 4 new agent definitions

### No New MCP Tools
The Agent tool handles spawning. `stopTask(taskId)` on the Query interface handles cancellation. No custom worker management tools needed.

---

## Current Orchestrator (Implemented)

No code rewrite needed. The existing `edith.ts` + `dispatch.ts` already handles everything. The orchestrator pattern is achieved through:

1. **System prompt** (`prompts/system.md`) — tells Edith to delegate heavy work to background agents
2. **Agent definitions** (`.claude/agents/`) — specialized agents for each task type
3. **Task event logging** (`lib/dispatch.ts`) — logs `task_started`, `task_progress`, `task_notification` events from background agents

Edith's existing dispatch engine, session management, scheduler, and Telegram handling all work as-is. The only change is behavioral — Edith now spawns agents instead of doing heavy work herself.

---

## File Disposition

### Keep as-is (10 files)
- `lib/config.ts` — env vars, paths
- `lib/storage.ts` — JSON file I/O
- `lib/n8n-client.ts` — n8n webhook client
- `lib/twilio.ts` — SMS/WhatsApp
- `lib/notify.ts` — macOS notifications
- `lib/caffeinate.ts` — prevent Mac sleep
- `lib/util.ts` — shared utilities
- `lib/mcp-helpers.ts` — MCP response builders
- `mcp/geo.ts` — geofencing
- `mcp/types.ts` — shared types

### Simplify (2 files)
- `lib/state.ts` — remove dispatch queue, dead-letter queue. Keep: offset, session-id, events log, active processes
- `lib/telegram.ts` — add `editMessage(chatId, messageId, text)` and `sendAndGetId(chatId, text)`

### Rewrite (when ready for v4 full refactor)
- `edith.ts` — simplified orchestrator loop
- `lib/scheduler.ts` — just check schedule and inject into orchestrator

### Remove (when ready for v4 full refactor, 15 files)
- `lib/dispatch.ts` — replaced by workers.ts + orchestrator.ts
- `lib/session.ts` — no single-session tracking needed
- `lib/handlers.ts` — all messages forward to orchestrator
- `lib/briefs.ts` — orchestrator writes worker prompts dynamically
- `lib/reflector.ts` — workers are short-lived, don't drift
- `lib/tick.ts` — folded into edith.ts main loop
- `lib/prewake.ts` — workers gather their own context
- `lib/context.ts` — orchestrator has its own system prompt
- `lib/transcript.ts` — simplified or use SDK defaults
- `lib/taskboard.ts` — replaced by orchestrator memory + Cognee
- `lib/proactive.ts` — becomes a scheduled worker
- `lib/screenpipe.ts` — workers use Screenpipe MCP directly
- `lib/gemini.ts` — workers handle their own summarization
- `lib/audio-extract.ts` — becomes a worker task
- `dashboard.ts` — killed (Telegram progress is enough)
- `dashboard.html` — killed

**Net: 27 lib files + dashboard → 14 files. ~3500 lines → ~1500 lines.**

---

## Implementation Phases

### Phase 1: Foundation
- Add `editMessage` and `sendAndGetId` to telegram.ts
- Build WorkerPool class (lib/workers.ts)
- Build Orchestrator class (lib/orchestrator.ts)
- Unit tests for WorkerPool (mock query())

### Phase 2: MCP Tools
- Add spawn_worker, list_workers, worker_status, cancel_worker to mcp/server.ts
- Wire tools to WorkerPool instance

### Phase 3: Main Loop Rewrite
- Rewrite edith.ts with new orchestrator + worker pattern
- Simplify scheduler to inject messages into orchestrator
- Remove handlers.ts, tick.ts

### Phase 4: Cleanup
- Delete removed files
- Simplify state.ts
- Update tests

### Phase 5: Polish
- Tune progress reporting (debounce interval, format)
- Cost tracking across workers
- Orchestrator system prompt refinement

---

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

---

## n8n as Integration Backend

n8n already handles Gmail and Calendar via webhooks. The pattern: **build integrations as n8n workflows, expose as webhook endpoints, Edith calls them like APIs.** n8n becomes Edith's integration backend — handles OAuth, retries, and error handling. Visually editable without touching code.

### Current n8n Workflows
- `gmail` — get, archive, trash, batch manage emails
- `calendar` — get, create, update, delete events
- `notify` — multi-channel notifications (email, Slack, Discord)

### New Workflows to Build
- **twilio** — SMS + WhatsApp (kills `lib/twilio.ts`)
- **transcribe** — voice → text via OpenAI (simplifies voice handling in edith.ts)
- **google-tasks** — create, list, update tasks
- **google-drive** — search, read, share docs
- **google-contacts** — lookup, create contacts
- **web-research** — HTTP requests, scraping, search
- **image-gen** — Google Imagen / DALL-E

### How It Connects

```
Edith Orchestrator (brain)
  → calls spawn_worker("check emails and draft replies", "email-triage")
  → Worker (Claude session) needs to read emails
  → Worker calls manage_emails MCP tool
  → MCP tool POSTs to n8n webhook: POST /webhook/gmail { action: "get", hoursBack: 4 }
  → n8n handles OAuth, pagination, formatting
  → Returns structured data to Worker
  → Worker drafts replies, calls send_email MCP tool
  → MCP tool POSTs to n8n: POST /webhook/gmail { action: "send", to: "...", body: "..." }
```

### MCP Server Simplification

`mcp/server.ts` becomes mostly thin wrappers around n8n webhooks:

```typescript
// Before: custom Twilio implementation in lib/twilio.ts
// After: one n8n webhook call
server.tool("send_sms", async ({ to, body }) => {
  return await n8nPost("twilio", { channel: "sms", to, body });
});
```

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

---

## Known Limitations

### Busy flag blocks scheduled tasks during background agent execution
The dispatch engine's `busy` flag in `lib/dispatch.ts` is set to `true` while the orchestrator session is running — including while it waits for a background agent to complete. This means scheduled tasks (check-reminders, proactive-check) get `skipIfBusy` dropped during long operations.

**Impact:** If a background agent runs for 2+ minutes, scheduled tasks that fire during that window are skipped entirely.

**Fix (future):** The busy flag exists because `query()` is single-session. Options:
1. Run scheduled tasks as separate `query()` calls (parallel sessions) instead of going through the dispatch queue
2. Let the orchestrator handle scheduled task messages via `streamInput()` injection even while a background agent is running (the stream is still open)
3. Full v4 refactor where the orchestrator session is always alive and scheduled tasks are just injected messages

**Workaround (now):** Background agents typically finish in 1-3 minutes. The 5-minute check-reminders and 3-minute proactive-check will catch up on the next tick. Morning brief at 8:03 AM is the longest operation — during that window, reminders may be delayed by a few minutes.

---

## Open Questions

- How should worker results flow back to the orchestrator? Options: inject summary into brain session, or brain polls via worker_status
- Should the orchestrator have access to Screenpipe directly for context awareness, or only through workers?
- What happens when the orchestrator's context window fills up? Auto-restart with Cognee context reload?
- Should workers be able to spawn sub-workers? (Probably not — keep it flat)
- Cost budget per worker? Per day? Alert thresholds?
