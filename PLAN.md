# Edith v3 — Improvement Plan

Generated from full codebase audit + .claude folder restructure analysis.

---

## Phase 1: Critical Bugs (data loss / broken features)

### 1.1 Fix geo.ts / server.ts file path mismatch
- `geo.ts` reads reminders/locations from project root
- `server.ts` reads from `~/.edith/`
- **Result:** Location reminders created via MCP tool never fire
- **Fix:** Update `geo.ts` to read from `~/.edith/` (same as server.ts)

### 1.2 Fix git staging of secrets
- `.env` with real API keys is staged (`git add` was forced)
- `n8n/data/database.sqlite` with OAuth tokens is staged
- `n8n/workflows.json` exposes email addresses
- `locations.json` and `reminders.json` with personal data staged
- **Fix:** `git rm --cached` all sensitive files, verify `.gitignore` covers them

### 1.3 Fix Telegram Markdown parse errors
- `edith.ts` sends with `parse_mode: "Markdown"` (legacy)
- Claude output has unmatched `*`, `_`, `[` — Telegram API rejects silently
- **Fix:** Try MarkdownV2 with escaped content, fall back to plain text on error

### 1.4 Fix n8n WEBHOOK_URL inside container
- Set to `localhost:5679` but container internal port is 5678
- **Fix:** Remove WEBHOOK_URL or set to `http://localhost:5678`

---

## Phase 2: Security Hardening

### 2.1 Restrict send_message chat_id
- Currently accepts any chat_id — Claude could be prompted to message arbitrary chats
- **Fix:** Allowlist check against TELEGRAM_CHAT_ID before sending

### 2.2 Fix n8n default password
- Hardcoded `changeme` fallback in docker-compose.yml
- **Fix:** Add N8N_PASSWORD to setup.sh, generate random default

### 2.3 Validate reminder fireAt timestamps
- No validation that fireAt is a valid ISO timestamp
- **Fix:** Parse with `new Date()`, reject if invalid

---

## Phase 3: .claude Folder Restructure

### 3.1 Gut CLAUDE.md to ~20 lines
Current CLAUDE.md repeats tool descriptions already in MCP server. Article says >200 lines reduces adherence. Keep only:
- Memory rules (what to store in Cognee, what goes on taskboard)
- Taskboard file location
- Scheduling overview (1 line)
- Current date injection

### 3.2 Create `.claude/rules/` folder
Split behavioral instructions into focused rule files:

```
.claude/rules/
  autonomy.md      — Never ask Randy to do things. Research, propose, execute.
                      When something fails, retry or find alternative. Don't punt.
                      When texting via Telegram, Randy is away from computer.
  communication.md — Be direct and concise. No emoji spam. ADHD-optimized.
                      Short paragraphs. Bold key info. Skip pleasantries.
  memory.md        — When to cognify vs taskboard. What patterns to notice.
                      Store: people, decisions, preferences, project facts.
                      Taskboard: transient (today's calendar, flagged emails).
  security.md      — Only send messages to authorized chat IDs.
                      Never leak API keys or personal data.
                      Verify before executing destructive operations.
```

### 3.3 Create `.claude/agents/` folder
Define specialized agents for different task types:

```
.claude/agents/
  reminder-checker.md  — model: haiku, tools: Read/Write only
                          Cheap/fast for the every-5-min reminder check
  researcher.md        — model: sonnet, tools: WebSearch/WebFetch/Read
                          For when Edith needs to look something up
```

### 3.4 Create `.claude/commands/` folder
Manual slash commands Randy can invoke:

```
.claude/commands/
  status.md    — System health check (docker, n8n, Cognee, session)
  costs.md     — Parse events.jsonl and report today's API spend
  debug.md     — Dump last 10 events, active processes, session state
```

### 3.5 Move system prompt into rules
Current `prompts/system.md` loaded via `--append-system-prompt-file`. Move personality/voice into `.claude/rules/personality.md` so it loads automatically with the standard .claude mechanism. Keep `--append-system-prompt-file` only if needed for the Edith identity block.

---

## Phase 4: Code Quality

### 4.1 Fix duplicate code
- `tgCall` and `sendMessage` duplicated in edith.ts and server.ts
- `ScheduleEntry`, `Reminder`, `LocationEntry` interfaces duplicated
- **Fix:** Create shared `types.ts`, import from both files

### 4.2 Fix generate_image
- Uses wrong Gemini model (`gemini-2.0-flash-exp` instead of imagen model)
- `numberOfImages` param is dead code
- **Fix:** Use correct model, implement multi-image support or remove param

### 4.3 Fix test-e2e.sh
- Uses `--session-id` (wrong flag, should be `--resume`)
- References `mcp__edith__send_message` instead of `send_message`
- **Fix:** Update flags and tool names

### 4.4 Fix setup.sh
- Overwrites entire .env (loses existing keys not prompted for)
- Doesn't set N8N_PASSWORD
- `sed -i ''` breaks on Linux
- **Fix:** Merge into existing .env instead of overwriting, add N8N_PASSWORD prompt

---

## Phase 5: Robustness

### 5.1 Add Markdown send fallback
- When Telegram rejects Markdown, retry as plain text
- Apply to both edith.ts and server.ts sendMessage functions

### 5.2 Drain dispatch queue on shutdown
- SIGINT/SIGTERM currently drops queued messages silently
- **Fix:** Dead-letter any queued messages before exit

### 5.3 Add fireAt validation
- Parse ISO timestamp on save, reject malformed dates
- Also reject dates in the past

### 5.4 Add inbox cleanup
- `~/.edith/inbox/` grows unbounded (voice notes, photos)
- **Fix:** Delete files older than 7 days on startup

### 5.5 Make --mcp-config path absolute
- Currently relative `.mcp.json` — fragile if cwd changes
- **Fix:** Use `join(process.cwd(), ".mcp.json")` or `import.meta.dir`

---

## Phase 6: Infrastructure

### 6.1 Own the n8n stack
- Export workflows from life-guardian-n8n (port 5678)
- Import into edith-n8n (port 5679)
- Auto-import workflows on `docker compose up` via n8n API or init script
- Remove dependency on life-guardian project

### 6.2 Fix Cognee volume mount
- Data lives at `/app/.venv/lib/python3.12/site-packages/cognee/.cognee_system/`
- Volume mounted to `/app/data/` (empty, unused)
- **Fix:** Mount volume to correct path, or set COGNEE env var to use `/app/data/`

### 6.3 Clean up stale Docker containers
- `tony-n8n` sitting in "Created" state
- `life-guardian-n8n` still running on 5678
- **Fix:** Remove tony-n8n, document life-guardian dependency or migrate

### 6.4 Add Docker pre-flight check to launch script
- If Docker daemon isn't running, launch-edith.sh continues anyway
- **Fix:** Check `docker info` before `docker compose up`, exit with clear error

### 6.5 Add logs/ directory creation to launch script
- launchd plist routes to `logs/` but launch-edith.sh doesn't create it
- **Fix:** `mkdir -p logs` in launch-edith.sh

---

## Phase 7: Nice to Have

### 7.1 Dashboard auth
- Currently zero auth on localhost:3456
- Add basic token auth or bind to 127.0.0.1 only

### 7.2 Root tsconfig.json
- edith.ts and dashboard.ts have no TypeScript config
- Add root tsconfig for IDE tooling

### 7.3 Cost tracking in dashboard
- events.jsonl already has cost data
- Add daily spend widget to dashboard

### 7.4 Journal system (ROADMAP item)
- Daily ops log in `~/.edith/journal/YYYY-MM-DD.md`
- Better than taskboard for cross-day continuity

### 7.5 Remove vendored skill-creator
- `.claude/skills/skill-creator/` is a large third-party tool (32KB SKILL.md + subdirs)
- Should be installed separately, not committed to repo
