# Edith v3 — Consolidated Findings & Plan

Last updated: 2026-04-03

This document consolidates all planning docs, GitHub issues, production data, architecture analysis, and the Claude Code comparison into one source of truth for what's wrong, what's working, and what to build next.

---

## The Core Problem

Edith is architecturally sound but **not useful**. She has 7,700 LOC, 29 test files, 15 skills, 10 MCP tool domains, a reflector system, a sentinel, and comprehensive observability. But she doesn't actually help Randy day-to-day. The reasons:

1. **Sequential processing** — one Claude query at a time. A 35s reminder check blocks all messages.
2. **Reports, doesn't act** — "CFP deadline in 2 days" but never drafts the abstracts.
3. **No self-scheduling** — can't create her own follow-up tasks. "Check back on this tomorrow" isn't possible.
4. **No memory between runs** — every dispatch starts cold. Same items re-surfaced across briefs.
5. **Message dispatch broken** — production logs show 0-token dispatches for user messages.
6. **SMS relay dead** — `TELEGRAM_SMS_BOT_ID` not configured. Messages from EdithSMSRelay ignored.
7. **$29/day wasted** — check-reminders fires 288x/day at $0.10 each, found 1 reminder in 48h.

---

## What Works Today

| Feature | Status | Notes |
|---------|--------|-------|
| Telegram polling + webhook | ✅ Working | But message dispatch to Claude broken |
| Scheduled tasks (briefs) | ✅ Working | Morning, midday, evening, weekend, reviews |
| Google APIs (Gmail, Calendar, Docs, Drive) | ✅ Working | Direct OAuth2, no n8n dependency |
| SQLite state persistence | ✅ Working | Schedule, reminders, sessions, dead-letters |
| Reflector (quality monitoring) | ✅ Working | 8.0/10 avg score, A/B testing |
| Sentinel (message evaluation) | ✅ Working | Fire-and-forget quality checks |
| Geofencing + location reminders | ✅ Working | OwnTracks webhook integration |
| Desktop companion (Tauri) | ✅ Working | Rive character, draggable, right-click menu |
| Observability (BetterStack) | ✅ Working | Logs + uptime monitoring |
| Circuit breaker + error recovery | ✅ Working | 5-fail trip, 10-min cooldown |

---

## Production Data (48h sample, Apr 1-2 2026)

| Metric | Value |
|--------|-------|
| Total events | 9,400 |
| Total API cost | $25 |
| Dispatch success rate | 83.7% |
| Reflector avg score | 8.0/10 |
| check-reminders cost | $22 (76% of total) |
| User messages processed | 0 (dispatch broken) |
| SMS relay messages processed | 0 (bot ID missing) |
| dispatch_skipped events | 387 (tasks silently lost) |
| Bootstrap success rate | 6.7% (1/15) |
| Circuit breaker trips | 21 (reason field empty) |
| Evening-wrap duplicate runs | 5 (same content repeated) |

---

## 30 Open GitHub Issues (by priority)

### Tier 1 — User-Facing Bugs (fix now)
| # | Title | Complexity |
|---|-------|-----------|
| 164 | SMS relay not processed (bot ID + dispatch broken) | Low |
| 145 | Railway deploy stability (6 consecutive failures) | Medium |
| 161 | Bootstrap 6.7% success rate | Medium |

### Tier 2 — Cost / Efficiency (high ROI)
| # | Title | Impact |
|---|-------|--------|
| 158 | check-reminders pre-check (skip LLM when nothing due) | ~$27/day saved |
| 160 | Evening-wrap dedup (skip re-reporting same items) | ~$2/day saved |

### Tier 3 — Reliability Bugs
| # | Title |
|---|-------|
| 147 | Telegram offset — messages lost on processing error |
| 148 | IPC trigger deleted on dispatch error |
| 149 | Scheduler state not transactional (duplicate fires on crash) |
| 150 | Dockerfile healthcheck too short |
| 151 | Dead letter queue unbounded |
| 152 | Dispatch queue race condition in finally block |
| 156 | Scheduler timezone wrong in cloud |
| 146 | Session injection retry/queue fallback |
| 159 | dispatch_skipped drops important tasks |

### Tier 4 — Helpfulness / Quality
| # | Title |
|---|-------|
| 163 | Follow-up tracking (action items forgotten after surfacing) |
| 141 | Proactive intervention triggers (infrastructure exists, not wired) |
| 162 | Circuit breaker logging (reason field empty) |
| 157 | Telegram message idempotency |
| 165 | Replace sequential dispatch with concurrent + dream state |

### Tier 5 — Cleanup / Testing
| # | Title |
|---|-------|
| 153 | Test coverage for 6 critical untested modules |
| 154 | Stale docs, dead n8n dir, skill frontmatter |
| 155 | Env var validation + .env.example |

### Tier 6 — Phase 3 (Desktop)
| # | Title |
|---|-------|
| 109 | Rive character with expression states |
| 142 | Tauri screen capture (replace Screenpipe) |
| 143 | Gemini Live API |
| 144 | Voice I/O (Cartesia + Groq) |

### Tier 7 — Phase 4 (Distribution)
| # | Title |
|---|-------|
| 166 | Open-source desktop companion |
| 97 | Landing page |
| 82 | Windows support |
| 84 | Linux support |

---

## Lessons from Claude Code (gaps Edith should close)

### 1. Memory System (CRITICAL — biggest gap)
Claude Code has a **6-layer memory system** (~7,500 LOC):
- Session memory: live file updated every 5K tokens (current state, files, errors)
- Background extraction: forked subagent distills conversations into `.md` files
- Auto-dream: periodic consolidation of session logs (24h gate + 5 session gate)
- Relevant memory selection: Sonnet side-query picks top 5 memories
- MEMORY.md index: 200-line cap, auto-pruned, dated entries
- Team memory sync: shared across org via API

**Edith has:** Cognee (unreliable, MCP broken) + taskboard (transient, rotated daily). No session memory, no auto-extraction, no consolidation. This is why she forgets everything.

**Action:** Build a local memory system inspired by Claude Code's architecture. Use SQLite + markdown files, not Cognee.

### 2. Concurrent Tool Execution
Claude Code: read-only tools run concurrently (max 10), write tools serial. Streaming tool executor starts tools while API response streams in.

**Edith has:** One query at a time, one tool at a time. 35s check-reminders blocks everything.

**Action:** Implement concurrent dispatch for independent tasks. At minimum, user messages should never be blocked by background tasks.

### 3. Context Window Management
Claude Code has 5 compaction strategies: tool result budget, history snip, microcompact, context collapse, autocompact.

**Edith has:** None. Hits context limits and fails.

**Action:** Implement at least autocompact (summarize when context exceeds threshold).

### 4. Self-Scheduling (Cron System)
Claude Code: agent creates `CronTask { cron, prompt, recurring, durable }` for itself. Tasks fire when REPL is idle.

**Edith has:** Can check reminders Randy sets. Cannot say "I should follow up on this tomorrow" and create a task for herself.

**Action:** Add `edith_tasks` table in SQLite. Edith writes tasks for herself. Scheduler picks them up. This is the "agency" breakthrough.

### 5. Error Recovery Depth
Claude Code: 7+ recovery strategies layered (prompt-too-long → collapse → compact, output limits → escalate → multi-turn).

**Edith has:** Circuit breaker + 1 retry. Much more fragile.

**Action:** Add at least prompt-too-long recovery and output limit escalation.

### 6. Deferred Tool Loading
Claude Code: tools with `shouldDefer` omitted from initial prompt, loaded on-demand via ToolSearch. Reduces token waste.

**Edith has:** All tools loaded every time. System prompt bloat.

**Action:** Lower priority but worth implementing after memory system.

---

## Known Document Contradictions

| Contradiction | Resolution |
|--------------|------------|
| ROADMAP says Fly.io; eval says Railway | **Railway is correct** (eval-cloud-platform.md decided) |
| ROADMAP says 11→4 agents; code has both | **Consolidation in progress** — archived agents exist alongside new ones |
| CLAUDE.md says "don't use Cognee MCP"; ROADMAP lists Cognee as primary memory | **Cognee MCP is broken**, bash script works but is unreliable. Need new memory system. |
| review-templates.md references n8n (4 places) | **n8n removed** — docs need update (#154) |
| data-sources.md says "Docs can't create files" | **Now can** via direct API — docs need update (#154) |
| PLAN.md still exists | **ROADMAP says delete** — not yet done (#154) |
| 5 skills missing agent/model frontmatter | **Will break routing** if dispatcher checks — needs fix (#154) |

---

## Recommended Build Order

### Phase A — Make Edith Actually Work (1-2 days)
1. **Fix message dispatch** — investigate why user messages show 0-token dispatches
2. **Set TELEGRAM_SMS_BOT_ID** — 5 min fix, enables SMS triage
3. **check-reminders pre-check (#158)** — 45 min, saves $27/day
4. **Bootstrap reliability (#161)** — readiness gate before dispatch

### Phase B — Make Edith Useful (3-5 days)
5. **Local memory system** — SQLite-backed session memory + auto-extraction (inspired by Claude Code)
6. **Self-scheduling task queue (#163 + #165)** — Edith creates her own follow-up tasks
7. **Concurrent dispatch** — user messages never blocked by background tasks
8. **Action-oriented briefs** — briefs trigger work (draft abstracts, prep docs), not just summaries

### Phase C — Reliability Hardening (2-3 days)
9. Fix reliability bugs: #147, #148, #149, #150, #156, #159
10. Evening-wrap dedup (#160)
11. Test coverage for critical modules (#153)
12. Circuit breaker logging (#162)
13. Cleanup stale docs (#154)

### Phase D — Desktop Companion Polish (when ready)
14. Rive character with expressions (#109) — need transparent-bg asset with expressions
15. Voice I/O (#144)
16. Screen capture (#142) + Gemini Live (#143)

### Phase E — Distribution (future)
17. Open-source desktop companion (#166)
18. Landing page (#97)
19. Platform support (#82, #84)

---

## Deep Dive Areas (for next sessions)

To validate whether the gaps identified above are real vs lack of understanding, do focused deep dives on:

1. **Dispatch system** — is message dispatch actually broken, or is it a logging artifact? Trace the full path from Telegram poll to Claude response.
2. **Memory architecture** — what would a Claude Code-style memory system look like in Edith's architecture? Design the schema, extraction triggers, and consolidation loop.
3. **Concurrent dispatch** — can Agent SDK run parallel queries? What are the actual constraints? Design the non-blocking dispatch.
4. **Brief effectiveness** — read the actual brief prompts and outputs. Are they instructing Claude to DO work or just REPORT? What specific prompt changes would make briefs action-oriented?
5. **Proactive triggers** — the infrastructure exists but isn't wired. What signals should trigger proactive intervention, and what actions should result?
