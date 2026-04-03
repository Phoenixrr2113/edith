# Edith v3 — Consolidated Findings & Master Plan

Last updated: 2026-04-03
Status: Living document — single source of truth

---

## Table of Contents

1. [Executive Summary](#1-executive-summary)
2. [Current Architecture — What Exists](#2-current-architecture)
3. [Production Telemetry — What the Data Says](#3-production-telemetry)
4. [Gap Analysis — Why Edith Isn't Useful](#4-gap-analysis)
5. [Claude Code Comparison — Features to Adopt](#5-claude-code-comparison)
6. [Document Contradictions & Stale Refs](#6-contradictions)
7. [Open Issues Inventory (30 issues)](#7-open-issues)
8. [Master Plan — Phased Build Order](#8-master-plan)
9. [ATS Specifications — Ready to Execute](#9-ats-specifications)
10. [Deep Dive Queue — Validation Needed](#10-deep-dive-queue)

---

## 1. Executive Summary

Edith is Randy's autonomous personal assistant — an always-on AI companion that monitors email, calendar, SMS, screen context, and Telegram messages to proactively help with daily life. She runs as a Bun daemon (local or Railway cloud) with a Tauri v2 desktop companion.

**The problem:** Edith is architecturally mature (7,700 LOC, 29 test files, 15 skills, 10 MCP tool domains, reflector + sentinel quality systems) but **not useful**. Randy's direct feedback: "She's not doing anything for me that would make me say she's better than any other system out there."

**Root causes (5):**
1. Sequential dispatch — one Claude query at a time, everything else queues or drops
2. Reports instead of acts — briefs surface information but never do the work
3. No self-scheduling — can't create follow-up tasks for herself
4. No persistent memory — every dispatch starts cold, same items resurface across briefs
5. Message dispatch broken — user messages show 0-token dispatches in production

**The vision Randy articulated:** "The input/output can't be sequential. It needs to accept any input and respond at any time. It needs to plan ahead and set up its own reminders. It needs to always be running and thinking about its system and ways it can be helpful. Its goal is to want to make my life better."

---

## 2. Current Architecture

### 2.1 System Components

```
packages/agent/          # The brain — 7,717 LOC across 29 modules
├── edith.ts             # Main daemon: Telegram poll + scheduler + HTTP
├── lib/
│   ├── dispatch.ts      # Sequential dispatcher (busy flag + queue)
│   ├── dispatch-stream.ts   # Stream processor + reflector injection
│   ├── dispatch-options.ts  # SDK options builder
│   ├── scheduler.ts     # Cron-like task firing (60s tick)
│   ├── briefs/          # 8 brief type builders
│   ├── reflector.ts     # Quality monitor (A/B injection)
│   ├── sentinel.ts      # Outbound message evaluator
│   ├── telegram-transport.ts  # Update routing
│   ├── telegram-polling.ts    # Infinite poll loop
│   ├── handlers.ts      # Message type handlers
│   ├── session.ts       # Active query + streamInput
│   ├── state.ts         # Persistent state (SQLite-backed)
│   ├── db.ts            # SQLite/Postgres abstraction
│   ├── gmail.ts         # Direct Gmail REST API
│   ├── gcal.ts          # Direct Calendar REST API
│   ├── gdocs.ts         # Direct Docs API
│   ├── gdrive.ts        # Direct Drive API
│   ├── cloud-transport.ts   # WebSocket server (device connection)
│   ├── capability-router.ts # Brain/body split abstraction
│   ├── sms.ts           # SMS relay parsing + spam filter
│   ├── geo.ts           # Geofencing + location transitions
│   ├── proactive.ts     # Intervention rate limiter
│   └── config.ts        # All env vars + constants
├── mcp/server.ts        # 10 MCP tool domains (stdio transport)
└── prompts/
    ├── system.md         # Identity + voice + routing rules
    └── reasoning.md      # Decision framework + error recovery

packages/desktop/         # The face — Tauri v2 + Svelte 5
├── src/
│   ├── App.svelte        # Root: character + context menu + settings
│   ├── lib/
│   │   ├── RiveCharacter.svelte  # Animated robot (cute-robot.riv)
│   │   ├── SpeechBubble.svelte   # Message display
│   │   ├── Settings.svelte       # Settings panel
│   │   ├── ws-client.ts          # WebSocket to cloud brain
│   │   └── [30+ utility modules]
│   └── styles/theme.css
└── src-tauri/            # Rust backend
    ├── src/lib.rs        # Tray, updates, window setup
    └── tauri.conf.json   # Window config
```

### 2.2 Data Flow — How a Message Travels Today

```
Randy sends Telegram message
  → telegram-polling.ts: getUpdates() (30s long-poll)
  → telegram-transport.ts: processUpdate()
    → Check ALLOWED_CHATS (authorized?)
    → Check SMS_BOT_ID (relay message?)
    → Route by type: handleText / handleVoice / handlePhoto / handleLocation
  → handlers.ts: handleText()
    → If SMS relay: processSmsRelay() → spam filter → dispatch "[Incoming SMS]"
    → If Randy: dispatch "[Message from Randy via Telegram]"
  → dispatch.ts: dispatchToConversation()
    → briefs/: buildBrief("message", {message, chatId})
    → dispatchToClaude(brief, {resume: true, priority: P1_USER})
      → Is circuit breaker tripped? → SKIP (return "")
      → Is busy? → QUEUE (wait for current to finish) or SKIP if skipIfBusy
      → Set busy = true
      → Build SDK options (system prompt, MCP config, tool list)
      → Agent SDK query() → Claude processes → tool calls via MCP
      → Stream processing (reflector injection, transcript logging)
      → On complete: busy = false, drain queue
  → Claude calls send_message via MCP → Telegram API → Randy sees response
```

### 2.3 Data Flow — How a Scheduled Task Fires

```
edith.ts: setInterval(schedulerTick, 60_000)
  → scheduler.ts: runScheduler()
    → Load schedule from SQLite
    → For each task: shouldFire()?
      → Interval task: elapsed >= interval? Quiet hours? User idle?
      → Window task: within 30min window? Already fired today?
    → If should fire:
      → briefs/: buildBrief(briefType)
      → dispatchToClaude(brief, {skipIfBusy: true, priority: P3_BACKGROUND})
        → If busy: log "dispatch_skipped" and DROP the task
      → Save lastFired to SQLite
```

### 2.4 State Persistence Layer

| Storage | Contents | Lifecycle |
|---------|----------|-----------|
| `edith.db` (SQLite) | schedule, locations, reminders, sessions, dead_letters, proactive_state, geo_state, kv_state | Persistent |
| `.state/taskboard.md` | Today's findings from each agent run | Rotated daily |
| `.state/taskboard-archive/` | Historical monthly taskboard files | Permanent |
| `.state/events.jsonl` | Structured event log (every dispatch, error, cost) | Rotated by size |
| `.state/activity/` | Daily screen/audio activity snapshots | Permanent |
| `.state/transcripts/` | Full query transcripts per session | Rotated |

### 2.5 Agent Model

| Agent | Model | Skills Routed | Purpose |
|-------|-------|---------------|---------|
| communicator | Sonnet | morning-brief, midday-check, evening-wrap, weekend-brief, email-triage | Email, calendar, messaging, briefs |
| analyst | Sonnet (Opus for quarterly) | weekly-review, monthly-review, quarterly-review | Reviews, reports, Google Docs |
| monitor | Haiku | check-reminders, proactive-check | Lightweight background checks |
| researcher | Sonnet | (ad-hoc) | Web search, context gathering |

### 2.6 MCP Tool Domains

| Domain | Tools | Backend |
|--------|-------|---------|
| Messaging | send_message, send_notification | Telegram, ntfy.sh, Twilio |
| Email | manage_emails (search, send, archive, label) | Gmail REST API (OAuth2) |
| Calendar | manage_calendar (list, create, update, delete) | Google Calendar REST API |
| Docs | manage_docs (create, read) | Google Docs REST API |
| Schedule | add/list/remove_scheduled_task | SQLite |
| Location | get/set/list_locations | SQLite |
| Reminders | list_reminders, mark_reminder_fired | SQLite |
| Activity | get_activity | File system (.state/activity/) |
| Logs | get_logs, get_costs | events.jsonl |
| Proactive | can_intervene, record_intervention | SQLite |

---

## 3. Production Telemetry

### 3.1 48-Hour Sample (Apr 1-2, 2026)

| Metric | Value | Assessment |
|--------|-------|------------|
| Total events | 9,400 | High volume |
| Total API cost | $25.19 | $12.50/day average |
| Dispatch success rate | 83.7% | Acceptable |
| Reflector avg score | 8.0/10 | Good quality when it runs |
| **check-reminders cost** | **$22.60 (76%)** | **CRITICAL waste** |
| **User messages processed** | **0** | **BROKEN** |
| **SMS relay messages processed** | **0** | **NOT CONFIGURED** |
| dispatch_skipped events | 387 | Tasks silently lost |
| Bootstrap success rate | 6.7% (1/15) | Nearly always fails |
| Circuit breaker trips | 21 | Reason field empty |
| Restarts | 70 | Mostly Apr 1 development |
| Poll errors (Telegram) | 1,124 | Duplicate bot conflict |

### 3.2 Task Execution Breakdown

| Task | Fires | Success Rate | Avg Cost | Avg Duration | Value |
|------|-------|-------------|----------|-------------|-------|
| check-reminders | 299 | 66.8% | $0.099 | 35s | **Near zero** (1 reminder fired in 48h) |
| morning-brief | 4 | 25% | $0.65 | 269s | High when it works |
| midday-check | 4 | 100% | $0.46 | 211s | High |
| evening-wrap | 4 | 50% | $0.48 | 185s | Medium (ran 5x same day, repeated content) |
| bootstrap | 15 | 6.7% | $0.29 | 114s | Critical but unreliable |
| message | 11 | 54.5% | $0.15 | 0s (!!) | **BROKEN (0ms duration = not reaching Claude)** |

### 3.3 What Edith Actually Produced (actionable output)

**Morning brief (Mar 30):**
- Surfaced: Ally Auto payment, Polaris application, M&T pre-approval renewal, Google security alert, CFP deadlines, Twilio sandbox renewal
- Assessment: **Good information, zero action taken on any of it**

**Midday check (Mar 30):**
- Surfaced: Better Stack activation, Manatee school order, Modak allowance deduction
- Assessment: **Good information, flagged Modak needs funding but didn't do it**

**Evening wrap (Mar 31):**
- Surfaced: Railway deploy failures, Q2 carry-forward priorities, Jump Dance registration
- Assessment: **Suggested CFP first task tomorrow — never followed up on it**

**Pattern:** Edith surfaces real, actionable items. But she never:
- Drafts the CFP abstracts she identified as urgent
- Pays or schedules the Ally Auto payment she flagged
- Follows up on whether Randy acted on any item
- Creates her own task to check back later

---

## 4. Gap Analysis — Why Edith Isn't Useful

### Gap 1: Sequential Processing (The Bottleneck)

**What happens:** Only ONE Claude query runs at a time. The `busy` flag in `dispatch.ts` (line 55) gates everything. When check-reminders runs (35s), Randy's Telegram message queues behind it. When morning-brief runs (270s), everything else waits or gets dropped.

**Production evidence:** 387 `dispatch_skipped` events in 48 hours. These are tasks with `skipIfBusy: true` (mostly interval tasks) that fired while another dispatch was running. They're silently lost — no retry, no queue, no dead-letter.

**Worse:** Window-based tasks (morning-brief, evening-wrap) also use `skipIfBusy: true` via the scheduler. If the dispatcher is busy when the 30-minute fire window passes, the brief is permanently skipped for that day.

**Impact:** Randy sends a message → waits 35+ seconds while check-reminders finishes → finally gets a response (if dispatch doesn't fail). This makes Edith feel slow and unresponsive.

**What's needed:** Concurrent dispatch. At minimum: user messages (P1) should preempt or run alongside background tasks (P3). Ideally: multiple Agent SDK queries in parallel.

### Gap 2: Reports Instead of Acts

**What happens:** Briefs are prompts that instruct Claude to "scan calendar", "check email", "write findings to taskboard". The output is always a **report**: "CFP deadline in 2 days", "Ally Auto payment due", "M&T pre-approval expired".

**What never happens:** Claude never drafts the CFP abstracts. Never schedules the payment. Never emails the mortgage broker. The briefs explicitly say "write to taskboard" and "send summary via Telegram" — they don't say "do the work."

**Production evidence:** Every morning-brief, midday-check, and evening-wrap in the event log produces text output to taskboard + Telegram message. Zero tool calls to manage_docs (create Google Doc with draft), manage_emails (send reply), or manage_calendar (schedule follow-up).

**Root cause:** The skill prompts in `.claude/skills/*/SKILL.md` are designed as **information gathering** tasks, not **action execution** tasks. The morning-brief prompt says "check calendar" not "prep for meetings." The evening-wrap says "review today" not "advance tomorrow's deadlines."

**What's needed:** Action-oriented skill prompts. When morning-brief surfaces "CFP deadline in 2 days," the prompt should instruct Claude to:
1. Research the CFP requirements
2. Draft 2-3 abstract options
3. Create a Google Doc with the drafts
4. Message Randy: "CFP deadline Apr 3. I drafted 3 abstracts — pick one: [link]"

### Gap 3: No Self-Scheduling / Agency

**What happens:** Edith can check reminders that Randy sets via Telegram ("remind me to X at Y"). But she cannot create her own follow-up tasks. She can't say "I should check if Randy paid Ally Auto in 24 hours" or "I need to follow up on the M&T renewal next week."

**Production evidence:** The `reminders` table in SQLite only has entries created via the `save_reminder` MCP tool — which requires Randy to explicitly ask. There's no `edith_tasks` table or self-scheduling mechanism.

**What this means:** Edith surfaces an action item in the morning brief → writes it to taskboard → taskboard rotates at midnight → item forgotten. Next morning, Edith re-discovers the same item from email. No tracking, no follow-through, no accountability.

**What's needed:** A self-managed task queue (SQLite table: `edith_tasks`). When Edith identifies something worth following up on, she creates a task for herself with a due date. The scheduler checks `edith_tasks` alongside regular reminders and fires a dispatch to handle overdue tasks.

### Gap 4: No Persistent Memory Between Runs

**What happens:** Each dispatch starts with a fresh Claude context. The only persistent context is:
- System prompt (static, ~200 lines)
- Brief content (calendar/email pre-fetched, taskboard snippet)
- Cognee search results (unreliable — MCP broken, bash script works sometimes)

**What's missing:** There's no "what Edith knows about Randy" state that accumulates over time. No session memory. No automatic extraction of learnings. No consolidation of knowledge.

**Comparison to Claude Code:** Claude Code has a 6-layer, 7,500-line memory system:
1. Session memory — live file updated every 5K tokens
2. Background extraction — forked subagent distills into `.md` files
3. Auto-dream — periodic consolidation (24h gate + 5 session gate)
4. Relevant memory selection — Sonnet side-query picks top 5
5. MEMORY.md index — 200-line cap, auto-pruned
6. Team memory sync — shared across org

**Edith has:** Cognee (graph DB, unreliable, MCP broken) + taskboard (rotated daily, not structured). The taskboard is the closest thing to "what Edith knows" but it's a flat markdown file that gets wiped every 24 hours.

**What's needed:** A local memory system (SQLite + markdown files). Not Cognee — it's proven unreliable. Something like Claude Code's approach:
- `edith_memory` table: structured facts (people, decisions, patterns, preferences)
- `.state/memory/` directory: topic-specific `.md` files
- Auto-extraction: after each brief, extract new learnings into memory
- Memory loading: before each dispatch, inject relevant memories into context

### Gap 5: Message Dispatch Broken

**What happens:** Production event logs show message-type dispatches with `durationMs: 0`, `inputTokens: 0`, `outputTokens: 0`, `cost: 0.0001`. These are not reaching Claude at all.

**Evidence:** Every `dispatch_end` event with `label: "message"` in events.jsonl shows zero-duration, zero-token completions. Scheduled tasks (check-reminders, morning-brief) show normal 20-270s durations with real token counts.

**Possible causes:**
1. `dispatchToConversation` uses `resume: true` — if session is stale, the SDK may silently fail
2. The `streamInput` refactoring (commits 83b8869, af58d36) may have broken the conversation path
3. If `busy = true` when message arrives, it queues — but queue drain may not be executing properly

**Impact:** Randy can't talk to Edith. Messages are received by Telegram polling (confirmed in logs) but responses never come. This is the #1 user-facing bug.

**What's needed:** Deep dive into the dispatch path for messages. Trace from `handleText()` → `dispatchToConversation()` → `dispatchToClaude()` → Agent SDK `query()` and find where it's short-circuiting.

### Gap 6: SMS Relay Not Configured

**What happens:** The EdithSMSRelay bot forwards SMS messages to the Edith Telegram chat. The relay handling code is fully implemented (sms.ts: parsing, spam filter; handlers.ts: triage routing). But `TELEGRAM_SMS_BOT_ID` is not set in `.env`, so `isSmsBot` is always `false`.

**Impact:** Relay messages arrive in the same chat as Randy's messages. They pass `ALLOWED_CHATS` check (same chat ID). But since `isSmsBot = false`, they're treated as Randy's messages instead of being routed through `processSmsRelay()`. Combined with Gap 5 (message dispatch broken), they're completely ignored.

**Fix:** Set `TELEGRAM_SMS_BOT_ID` in `.env` and Railway env vars. Get the bot's user ID via:
```bash
curl "https://api.telegram.org/bot$TELEGRAM_BOT_TOKEN/getUpdates" | jq '.result[-1].message.from'
```

### Gap 7: Cost Waste ($29/day on check-reminders)

**What happens:** check-reminders fires every 5 minutes (288 runs/day). Each run dispatches to Claude (Haiku model), which calls `list_reminders` MCP tool, compares against current time, and exits silently if nothing is due. Cost: ~$0.10/run = ~$29/day.

**Production evidence:** 299 fires in 48 hours → 1 actual reminder fired. 298 runs ($29.70) spent to find "nothing due."

**Root cause:** No code-level pre-check. The scheduler dispatches to Claude every time without first querying the reminders table to see if anything is actually due.

**Fix:** Add `getDueReminders()` function to `storage.ts` that queries SQLite directly: `SELECT COUNT(*) FROM reminders WHERE fire_at <= ? AND fired = 0`. Call before dispatching. Skip if count is 0.

---

## 5. Claude Code Comparison — Features to Adopt

After analyzing Claude Code's architecture (1,900 source files, ~40 tools, 7,500-line memory system), these are the features most relevant to Edith's gaps:

### 5.1 Memory System (CRITICAL — solves Gap 4)

| Layer | Claude Code | Edith | Gap |
|-------|------------|-------|-----|
| Session memory | Live file updated every 5K tokens (10 structured sections) | None | **CRITICAL** |
| Background extraction | Forked subagent distills conversations → `.md` files | None | **CRITICAL** |
| Auto-dream (consolidation) | Periodic review: 24h gate + 5 session gate + file lock | None | **HIGH** |
| Relevant memory selection | Sonnet side-query picks top 5 memories per conversation | None | **HIGH** |
| MEMORY.md index | 200-line cap, auto-pruned, dated entries | Cognee (broken) | **CRITICAL** |
| Team memory sync | Shared across org via API + secret scanning | None | N/A (single user) |

**Recommended implementation for Edith:**
- `edith_memory` SQLite table: `{ id, category, text, source_task, created_at, updated_at, importance }`
- `.state/memory/` directory: topic files (people.md, decisions.md, patterns.md, projects.md)
- After each brief: auto-extract learnings → insert/update memory
- Before each dispatch: load relevant memories into brief context
- Weekly consolidation: merge, prune, resolve contradictions

### 5.2 Concurrent Tool Execution (solves Gap 1 partially)

| Feature | Claude Code | Edith |
|---------|------------|-------|
| Read-only tools | Concurrent (max 10) | Sequential |
| Write tools | Serial | Sequential |
| Streaming tool executor | Tools start during API response streaming | Wait for complete response |
| Concurrent dispatch | Multiple queries possible | Single `busy` flag blocks all |

**Recommended for Edith:**
- Phase 1: Remove `busy` flag for P1_USER messages — always dispatch immediately, even if background task is running. Agent SDK supports multiple concurrent `query()` calls.
- Phase 2: Implement read-only tool concurrency within a single dispatch.

### 5.3 Self-Scheduling (solves Gap 3)

| Feature | Claude Code | Edith |
|---------|------------|-------|
| CronTask creation | Agent creates `{ cron, prompt, recurring, durable }` | Only user-created reminders |
| Fire timing | When REPL is idle | On scheduler tick (skipIfBusy) |
| One-shot tasks | Auto-delete after fire | N/A |
| Durable vs session-only | Both supported | N/A |

**Recommended for Edith:**
- Add `edith_tasks` table: `{ id, text, prompt, due_at, created_by_task, status, created_at }`
- Add `create_edith_task` MCP tool: lets Claude create follow-up tasks for herself
- Scheduler checks `edith_tasks` alongside reminders
- Tasks created by briefs: "Check if Randy paid Ally Auto in 24h" → fires next day

### 5.4 Context Window Management (future — solves long-conversation failures)

| Strategy | Claude Code | Edith |
|----------|------------|-------|
| Tool result budget | Truncates large results, persists to disk | None |
| History snip | Removes old messages | None |
| Microcompact | Summarizes completed tool_use blocks | None |
| Context collapse | Projects granular summaries | None |
| Autocompact | Full turn summarization when threshold exceeded | None |

**Recommended for Edith:** Implement autocompact first (summarize when context exceeds 80% of limit).

### 5.5 Error Recovery Depth

| Strategy | Claude Code | Edith |
|----------|------------|-------|
| Prompt-too-long | Context collapse → reactive compact → error | Fail |
| Max output tokens | Escalate 8k → 64k → multi-turn recovery | Fail |
| Stale session | Clear + retry (1 attempt) | Clear + retry (1 attempt) ✅ |
| Rate limits | Early return, no retry | Early return ✅ |
| Auth failure | Token refresh + retry | No OAuth retry |
| Circuit breaker | N/A (no circuit breaker) | 5-fail trip, 10-min cooldown ✅ |

### 5.6 Deferred Tool Loading

Claude Code's `shouldDefer` flag omits tools from the initial prompt, loaded on-demand via `ToolSearch`. Reduces prompt size by ~30% and prevents cache invalidation.

**Edith impact:** Lower priority. System prompt is currently manageable. Worth implementing after memory system.

---

## 6. Document Contradictions & Stale References

| Document | Issue | Resolution |
|----------|-------|------------|
| ROADMAP.md | References Fly.io as cloud host | **Railway is correct** (eval-cloud-platform.md decided) |
| ROADMAP.md | Lists 11 agents (Phase 1 state) | **4 agents exist** in `.claude/agents/` — consolidation done |
| CLAUDE.md | "Don't use Cognee MCP — use bash script" | **Both unreliable**. Need new memory system entirely. |
| review-templates.md | References "n8n workflow" (4 instances) | **n8n removed** — direct API calls. Needs update (#154) |
| data-sources.md | Says Google Docs "cannot create files" | **Now can** via direct API. Needs update (#154) |
| PLAN.md | Still exists in repo | **ROADMAP says delete.** Not yet done (#154) |
| 5 skill files | Missing `agent:` and `model:` frontmatter | **Breaks routing** if dispatcher checks. Needs fix (#154) |
| Taskboard | References Railway deploy failures (Apr 1) | **Stale** — may be resolved by subsequent commits |

---

## 7. Open Issues Inventory

### 30 open GitHub issues, organized by execution priority:

#### Tier 1 — User-Facing Bugs (do first)
| # | Title | Complexity | Est. |
|---|-------|-----------|------|
| 164 | SMS relay not processed — bot ID not configured + dispatch broken | Low | 30m |
| 145 | Railway deploy stability — 6 consecutive failures | Medium | 2h |
| 161 | Bootstrap cold start 6.7% success rate | Medium | 1.5h |

#### Tier 2 — Cost Optimization (highest ROI)
| # | Title | Impact | Est. |
|---|-------|--------|------|
| 158 | check-reminders pre-check — skip LLM when nothing due | ~$27/day saved | 45m |
| 160 | Evening-wrap dedup — skip re-reporting same items | ~$2/day saved | 1h |

#### Tier 3 — Reliability Bugs
| # | Title | Est. |
|---|-------|------|
| 147 | Telegram offset saved before processing — messages lost on error | 30m |
| 148 | IPC trigger file deleted on dispatch error — tasks lost | 30m |
| 149 | Scheduler state not transactional — duplicate fires on crash | 45m |
| 150 | Dockerfile healthcheck start-period too short | 15m |
| 151 | Dead letter queue unbounded — no auto-prune | 30m |
| 152 | Dispatch queue race condition in finally block | 45m |
| 156 | Scheduler timezone wrong in cloud mode | 30m |
| 146 | Session injection retry/queue fallback for cloud | 1h |
| 159 | dispatch_skipped drops important tasks — queue instead | 45m |

#### Tier 4 — Architectural Upgrades (make Edith useful)
| # | Title | Est. |
|---|-------|------|
| 165 | Concurrent dispatch + dream state (replaces sequential busy flag) | 4h |
| 163 | Proactive follow-up tracking — action items forgotten after surfacing | 3h |
| 141 | Wire proactive intervention triggers to main loop | 2h |

#### Tier 5 — Observability & Testing
| # | Title | Est. |
|---|-------|------|
| 162 | Circuit breaker logs missing reason/lastError | 30m |
| 157 | Telegram message idempotency — prevent duplicate processing | 1h |
| 153 | Test coverage for 6 critical untested modules | 4h |
| 155 | Env var validation + .env.example | 1h |

#### Tier 6 — Cleanup
| # | Title | Est. |
|---|-------|------|
| 154 | Stale docs, dead n8n dir, skills missing frontmatter | 1h |

#### Tier 7 — Desktop Companion (Phase 3)
| # | Title | Est. |
|---|-------|------|
| 109 | Rive character with expression states | 2h |
| 142 | Replace Screenpipe with native Tauri screen capture | 4h |
| 143 | Gemini Live API integration | 3h |
| 144 | Voice I/O (Cartesia TTS + Groq Whisper STT) | 3h |

#### Tier 8 — Distribution (Phase 4)
| # | Title |
|---|-------|
| 166 | Open-source desktop companion as standalone project |
| 97 | Landing page and distribution channel |
| 82 | Windows support |
| 84 | Linux support |

---

## 8. Master Plan — Phased Build Order

### Phase A: Make Edith Work (1-2 days)

**Objective:** Fix the broken stuff so Edith can actually respond to messages and stop wasting money.

| Step | What | Why | Issue | Est. |
|------|------|-----|-------|------|
| A1 | Fix message dispatch | User messages not reaching Claude (0-token dispatches) | — | 2h |
| A2 | Set TELEGRAM_SMS_BOT_ID | Enable SMS relay triage | #164 | 15m |
| A3 | check-reminders pre-check | Stop wasting $27/day | #158 | 45m |
| A4 | Fix bootstrap reliability | Clean cold starts | #161 | 1.5h |
| A5 | Fix scheduler timezone | Cloud fires at wrong time | #156 | 30m |
| A6 | Dockerfile healthcheck | Container not killed during bootstrap | #150 | 15m |

**Exit criteria:** Randy can message Edith on Telegram and get a response. SMS relay messages are triaged. check-reminders costs <$2/day. Bootstrap succeeds >90%.

### Phase B: Make Edith Useful (3-5 days)

**Objective:** Transform Edith from reporter to doer. Add memory, self-scheduling, and action-oriented briefs.

| Step | What | Why | Issue | Est. |
|------|------|-----|-------|------|
| B1 | Local memory system | Replace broken Cognee. Session memory + auto-extraction. | — | 4h |
| B2 | Self-scheduling task queue | Edith creates follow-up tasks for herself | #163 | 3h |
| B3 | Concurrent dispatch (P1 bypass) | User messages never blocked by background tasks | #165 | 4h |
| B4 | Action-oriented brief prompts | Briefs trigger work (draft, prep, schedule), not just summaries | — | 2h |
| B5 | Evening-wrap dedup | Stop re-reporting same items | #160 | 1h |
| B6 | Proactive triggers wired | Automatic nudges for deadlines, meetings, follow-ups | #141 | 2h |

**Exit criteria:** Edith remembers what she learned yesterday. She creates her own follow-up tasks. Morning brief drafts a CFP abstract instead of just saying "deadline in 2 days." Randy can message during a background task without waiting.

### Phase C: Reliability Hardening (2-3 days)

| Step | What | Issue | Est. |
|------|------|-------|------|
| C1 | Telegram offset fix | #147 | 30m |
| C2 | IPC trigger fix | #148 | 30m |
| C3 | Scheduler state transactional | #149 | 45m |
| C4 | Dead letter queue prune | #151 | 30m |
| C5 | Dispatch queue race fix | #152 | 45m |
| C6 | Session injection retry | #146 | 1h |
| C7 | dispatch_skipped → queue | #159 | 45m |
| C8 | Circuit breaker logging | #162 | 30m |
| C9 | Telegram idempotency | #157 | 1h |
| C10 | Test coverage | #153 | 4h |
| C11 | Env var validation | #155 | 1h |
| C12 | Stale docs cleanup | #154 | 1h |
| C13 | Railway deploy fix | #145 | 2h |

### Phase D: Desktop Companion (when agent is useful)

| Step | What | Issue |
|------|------|-------|
| D1 | Character with expressions (need transparent-bg asset) | #109 |
| D2 | Voice I/O (Cartesia + Groq) | #144 |
| D3 | Native screen capture (replace Screenpipe) | #142 |
| D4 | Gemini Live API | #143 |

### Phase E: Distribution (future)

| Step | What | Issue |
|------|------|-------|
| E1 | Open-source desktop companion (separate repo) | #166 |
| E2 | Landing page | #97 |
| E3 | Windows support | #82 |
| E4 | Linux support | #84 |

---

## 9. ATS Specifications — Ready to Execute

### ATS: Phase A1 — Fix Message Dispatch

```yaml
task_id: FIX-MSGDISPATCH-A1
name: Diagnose and fix message dispatch (0-token dispatches)
status: ready

user_story: |
  As Randy, I want to message Edith on Telegram and get a response,
  so that she's actually useful as a conversational assistant.

description: |
  Production logs show message-type dispatches completing in 0ms with
  0 input/output tokens. Messages are received by Telegram polling
  (confirmed in event log) but never reach Claude.

  The dispatch path for messages:
  handleText() → dispatchToConversation() → buildBrief("message") →
  dispatchToClaude(brief, {resume: true, label: "message", P1_USER})

  Scheduled tasks use a different path (no resume, ephemeral session)
  and work fine (20-270s durations, real token counts).

  Hypothesis: The `resume: true` flag causes the SDK to try continuing
  a stale or non-existent session, which silently returns with no work.

acceptance_criteria:
  - criterion: Message from Telegram results in Claude processing (non-zero tokens)
    verification: events.jsonl shows durationMs > 0, inputTokens > 0 for label "message"
  - criterion: Claude responds via send_message MCP tool
    verification: Randy receives response in Telegram
  - criterion: No regression on scheduled task dispatch
    verification: check-reminders, morning-brief still work

definition_of_done:
  - All acceptance criteria pass
  - No TypeScript errors
  - Existing dispatch tests still pass

ownership:
  modifies:
    - packages/agent/lib/dispatch.ts
    - packages/agent/lib/handlers.ts
  reads:
    - packages/agent/lib/dispatch-stream.ts
    - packages/agent/lib/session.ts
    - packages/agent/lib/state.ts
    - packages/agent/lib/briefs/conversation.ts
  forbidden:
    - packages/agent/lib/scheduler.ts
    - packages/agent/mcp/

approach:
  strategy: |
    Trace the full dispatch path for messages. Add logging at each step.
    Compare the message dispatch path vs scheduled task dispatch path.
    The key difference is `resume: true` vs ephemeral sessions.

  steps:
    1:
      action: Add debug logging to dispatchToConversation and buildBrief("message")
      input: Current handler code
      output: Verbose logging showing brief content and dispatch options
    2:
      action: Check if resume=true is causing silent failure
      input: Session state (sessionId from state.ts)
      output: Determine if stale session is the cause
    3:
      action: Fix dispatch path (likely change resume to false or clear stale session)
      input: Root cause from step 2
      output: Working message dispatch
    4:
      action: Verify with real Telegram message
      input: Running Edith instance
      output: Successful round-trip message

  decision_points:
    - condition: If resume=true with stale session causes silent fail
      action: Change to resume=false for message dispatches (each message is independent)
    - condition: If buildBrief("message") returns empty content
      action: Fix brief builder to include message text
    - condition: If busy=true blocks messages
      action: Messages should bypass busy flag or use a separate dispatch lane

verification:
  automated:
    - command: bun test packages/agent/tests/dispatch.test.ts
      expected: All pass
    - command: bun test packages/agent/tests/handlers.test.ts
      expected: All pass

failure_handling:
  - on: Cannot reproduce locally (Edith not running)
    action: Start Edith with `bun run start`, send test message via Telegram
  - on: Agent SDK issue (not Edith code)
    action: Check SDK version, search for known issues, consider downgrade

estimated_duration: 2h
complexity: medium
human_review_required: false
```

### ATS: Phase B1 — Local Memory System

```yaml
task_id: ARCH-MEMORY-B1
name: Build local memory system (replace Cognee)
status: draft

user_story: |
  As Edith, I want to remember what I learned in previous sessions,
  so that I don't re-discover the same information and can build
  on prior knowledge.

description: |
  Edith currently has no reliable memory between dispatches. Cognee
  (graph DB) is unreliable (MCP broken, bash script intermittent).
  Every dispatch starts cold — same items re-surfaced across briefs.

  Inspired by Claude Code's 6-layer memory system (7,500 LOC), build
  a pragmatic local memory system using SQLite + markdown files.

  Architecture:
  1. `edith_memory` SQLite table for structured facts
  2. `.state/memory/` directory for topic markdown files
  3. Auto-extraction: after each brief, extract learnings
  4. Memory loading: before each dispatch, inject relevant memories
  5. Consolidation: weekly merge/prune/resolve contradictions

acceptance_criteria:
  - criterion: Memory persists across dispatches
    verification: Morning brief on Day 2 references facts from Day 1 without re-discovering
  - criterion: Auto-extraction runs after each brief
    verification: events.jsonl shows "memory_extracted" events with new facts
  - criterion: Memory loaded into brief context
    verification: Brief prompt includes "What Edith knows" section
  - criterion: No Cognee dependency
    verification: Cognee bash script not called; memory sourced from SQLite

definition_of_done:
  - All acceptance criteria pass
  - No TypeScript errors
  - Unit tests for memory CRUD operations
  - Integration test: extract → store → load → use cycle

ownership:
  modifies:
    - packages/agent/lib/db.ts (add edith_memory table)
    - packages/agent/lib/storage.ts (add memory functions)
    - packages/agent/lib/briefs/index.ts (inject memory into briefs)
    - packages/agent/lib/briefs/scheduled.ts (add extraction step)
  reads:
    - packages/agent/lib/config.ts
    - packages/agent/lib/edith-logger.ts
  creates:
    - packages/agent/lib/memory.ts (memory CRUD + extraction logic)
  forbidden:
    - packages/agent/mcp/ (no new MCP tools in this task)
    - packages/desktop/

interface_contracts:
  produces:
    - name: MemoryEntry
      target: packages/agent/lib/memory.ts
      signature: "{ id: string, category: string, text: string, source_task: string, created_at: string, updated_at: string, importance: number }"
    - name: loadRelevantMemories
      target: packages/agent/lib/memory.ts
      signature: "(context: string) => Promise<MemoryEntry[]>"
    - name: extractAndStoreMemories
      target: packages/agent/lib/memory.ts
      signature: "(taskLabel: string, findings: string) => Promise<void>"

approach:
  strategy: |
    Build bottom-up: schema → CRUD → extraction → loading → integration.
    Start with SQLite table, add functions, wire into brief pipeline.
    Extraction runs as a post-dispatch step (not a separate agent).

  steps:
    1:
      action: Add edith_memory table to db.ts schema
      input: Schema design (id, category, text, source, importance, timestamps)
      output: Table created on db init
    2:
      action: Create memory.ts with CRUD functions
      input: Table schema
      output: saveMemory, loadMemories, searchMemories, deleteMemory
    3:
      action: Implement extractAndStoreMemories
      input: Task result text from dispatch
      output: Parsed facts stored in edith_memory
    4:
      action: Wire extraction into dispatch.ts post-completion
      input: Successful dispatch result
      output: Automatic memory extraction after each brief
    5:
      action: Implement loadRelevantMemories for brief context
      input: Brief type + current context
      output: Top N relevant memories injected into brief prompt
    6:
      action: Wire memory loading into briefs/index.ts
      input: Brief builder
      output: "What Edith remembers" section in every brief

estimated_duration: 4h
complexity: high
human_review_required: true
```

### ATS: Phase B2 — Self-Scheduling Task Queue

```yaml
task_id: ARCH-SELFSCHED-B2
name: Add self-scheduling task queue for Edith agency
status: draft

user_story: |
  As Edith, I want to create follow-up tasks for myself when I
  identify something worth checking back on, so that action items
  don't get forgotten between briefs.

description: |
  When Edith surfaces "Ally Auto payment due" in morning brief,
  she should be able to create a task: "Check if Randy paid Ally
  Auto in 24 hours. If not, nudge via Telegram."

  This is the "agency" capability — the difference between a news
  feed and an executive assistant.

  Implementation:
  1. `edith_tasks` SQLite table
  2. `create_edith_task` MCP tool (Claude can create tasks for herself)
  3. Scheduler checks edith_tasks alongside regular schedule
  4. Due tasks dispatched with context about why they were created

acceptance_criteria:
  - criterion: Claude can create a task via MCP tool during a brief
    verification: edith_tasks table populated after morning-brief
  - criterion: Due tasks fire automatically via scheduler
    verification: events.jsonl shows dispatch with label "edith_task"
  - criterion: Task includes creation context
    verification: Dispatch prompt includes "You created this task because..."
  - criterion: Completed tasks marked as done
    verification: Task status updated after execution

definition_of_done:
  - All acceptance criteria pass
  - No TypeScript errors
  - Unit tests for task CRUD
  - Integration test: create → schedule → fire → complete cycle

ownership:
  modifies:
    - packages/agent/lib/db.ts (add edith_tasks table)
    - packages/agent/lib/storage.ts (add task functions)
    - packages/agent/lib/scheduler.ts (check edith_tasks)
    - packages/agent/mcp/tools/schedule.ts (add create_edith_task tool)
  reads:
    - packages/agent/lib/config.ts
    - packages/agent/lib/dispatch.ts
  forbidden:
    - packages/desktop/

estimated_duration: 3h
complexity: medium
human_review_required: true
```

---

## 10. Deep Dive Queue — Validation Needed

Before executing Phases B and beyond, these areas need focused investigation to validate whether the gaps identified are real vs misunderstood:

### Deep Dive 1: Dispatch System
**Question:** Is message dispatch actually broken, or is it a logging artifact?
**Method:** Trace the full path from Telegram poll → handleText → dispatchToConversation → dispatchToClaude → Agent SDK query(). Add instrumentation. Send test message. Check if Claude receives the prompt.
**Success:** Root cause identified and fixed, or confirmed as logging-only issue.

### Deep Dive 2: Agent SDK Concurrency
**Question:** Can Agent SDK run multiple `query()` calls in parallel? What are the actual constraints?
**Method:** Read Agent SDK source/docs. Test with two concurrent `query()` calls. Check for shared state, session conflicts, or explicit locks.
**Success:** Confirmed whether concurrent dispatch is feasible, and what the constraints are.

### Deep Dive 3: Memory Architecture
**Question:** What would a Claude Code-style memory system look like in Edith? Is SQLite + markdown sufficient, or do we need vector search?
**Method:** Design the schema, extraction prompts, loading strategy. Prototype with a single brief cycle. Measure token overhead of memory injection.
**Success:** Working prototype of extract → store → load → use cycle.

### Deep Dive 4: Brief Effectiveness
**Question:** Are briefs instructing Claude to DO work or just REPORT? What specific prompt changes make briefs action-oriented?
**Method:** Read all SKILL.md files. Read actual brief outputs from taskboard. Identify where "write findings" should be "do the work." Draft revised prompts.
**Success:** Revised morning-brief prompt that drafts a CFP abstract instead of just flagging the deadline.

### Deep Dive 5: Proactive Triggers
**Question:** What signals should trigger proactive intervention, and what actions should result?
**Method:** Map all available signals (calendar, email, screen, SMS, file changes). Define trigger → action pairs. Wire to proactive.ts canIntervene/recordIntervention.
**Success:** At least 3 proactive triggers firing automatically.
