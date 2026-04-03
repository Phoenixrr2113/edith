# Next Session Prompt — Edith v3

## Context

You are continuing work on Edith v3, an autonomous AI personal assistant. The previous session did a comprehensive audit and produced:

1. **FINDINGS.md** — Single source of truth. Read this FIRST: `/Users/randywilson/Desktop/edith-v3/FINDINGS.md`
2. **architecture.html** — Interactive architecture diagrams (open in browser): `/Users/randywilson/Desktop/edith-v3/architecture.html`
3. **30 GitHub issues** filed (run `gh issue list --state open --limit 50 --repo Phoenixrr2113/edith`)
4. **Desktop companion** — Rive robot character integrated (Tauri v2 + Svelte 5)

## What to Do

### Step 1: Read FINDINGS.md completely

The file has 10 sections covering gaps, production data, Claude Code comparison, and a phased master plan. The master plan (Section 8) defines 5 phases with ~30 steps. Only 3 have ATS specs — the rest need them.

### Step 2: Create ATS GitHub Issues for All Phase A & B Steps

Phase A (Make Edith Work) has 6 steps. Phase B (Make Edith Useful) has 6 steps. Each needs a GitHub issue with full ATS spec (see Section 9 of FINDINGS.md for the format, and existing closed issues like #140, #127 for examples).

**Phase A issues to create:**
- A1: Fix message dispatch (0-token dispatches) — ATS exists in FINDINGS.md, needs GitHub issue
- A2: Set TELEGRAM_SMS_BOT_ID — quick fix, issue #164 exists but needs the actual fix executed
- A3: check-reminders pre-check — issue #158 exists with ATS
- A4: Bootstrap reliability — issue #161 exists with ATS
- A5: Scheduler timezone fix — issue #156 exists, needs ATS body update
- A6: Dockerfile healthcheck — issue #150 exists with ATS

**Phase B issues to create (NEW — no GitHub issues yet):**
- B1: Local memory system (replace Cognee) — ATS exists in FINDINGS.md, needs GitHub issue
- B2: Self-scheduling task queue — ATS exists in FINDINGS.md, needs GitHub issue
- B3: Concurrent dispatch (P1 bypass) — issue #165 exists but needs ATS body
- B4: Action-oriented brief prompts — NO issue exists, create new
- B5: Evening-wrap dedup — issue #160 exists with ATS
- B6: Proactive triggers wired — issue #141 exists, needs ATS body update

### Step 3: Start Deep Dive 1 — Fix Message Dispatch

This is the #1 blocker. Nothing else works if Randy can't message Edith.

**Investigation steps:**
1. Start Edith locally: `cd packages/agent && bun run start`
2. Send a test message via Telegram
3. Check events.jsonl for the dispatch — does it show 0-token or real processing?
4. If 0-token: trace the code path from `handleText()` → `dispatchToConversation()` → `dispatchToClaude()`
5. Key suspect: `resume: true` in `dispatchToConversation()` (line 334 of dispatch.ts) — may cause stale session failure
6. Compare with scheduled task path which uses `resume: false` and works fine
7. Fix and verify with a real Telegram round-trip

### Step 4: Execute Phase A Quick Fixes

After message dispatch works:
- Set `TELEGRAM_SMS_BOT_ID` in `.env` (get from `curl "https://api.telegram.org/bot$TELEGRAM_BOT_TOKEN/getUpdates" | jq '.result[-1].message.from'`)
- Add `getDueReminders()` pre-check to scheduler.ts (#158)
- Fix scheduler timezone (#156)
- Fix Dockerfile healthcheck (#150)

### Step 5: Begin Phase B (Memory System)

Design and implement the local memory system (B1):
- `edith_memory` SQLite table
- `.state/memory/` topic files
- Auto-extraction after each brief
- Memory loading into brief context
- See Section 9 of FINDINGS.md for full ATS spec

## Key Files

| File | Purpose |
|------|---------|
| `FINDINGS.md` | Master plan & gap analysis — READ FIRST |
| `architecture.html` | Interactive architecture diagrams |
| `ROADMAP.md` | High-level direction (some parts stale — FINDINGS.md is authoritative) |
| `packages/agent/edith.ts` | Main daemon entry point |
| `packages/agent/lib/dispatch.ts` | Core dispatch engine (the bottleneck) |
| `packages/agent/lib/handlers.ts` | Message type handlers |
| `packages/agent/lib/scheduler.ts` | Task scheduling |
| `packages/agent/lib/briefs/` | Brief builders (8 types) |
| `packages/agent/.state/events.jsonl` | Production event log |
| `packages/agent/.state/taskboard.md` | Today's findings |
| `.claude/skills/*/SKILL.md` | Skill prompts |
| `.claude/agents/*.md` | Agent definitions |

## Rules

Follow the agent rules in CLAUDE.md. Key points:
- Randy has ADHD — 3-5 lines max per message, bold key info, bullets
- Never ask Randy to do something you can do yourself
- Research before acting — read files before modifying them
- Run Biome lint check before every commit
- Create ATS specs for non-trivial work
- Use `gh issue create --repo Phoenixrr2113/edith` for GitHub issues
