# Edith Backlog — Consolidated Plan

Last updated: 2026-03-30

## How to use this file
Each task has an ATS YAML spec. To work a task: `/plan-task <number>` → `/work-task <number>` → `/verify-task <number>`.
Tasks are tracked on the [GitHub Project board](https://github.com/users/Phoenixrr2113/projects/1).

---

## Completed (this session, 2026-03-30)

| # | Task | Issue |
|---|------|-------|
| 1 | Pre-commit hook (Husky + tsc + bun test) | — |
| 2 | GitHub Project board + labels + automations | — |
| 3 | Task pipeline (project-auditor, plan/work/verify skills) | — |
| 4 | GitHub Actions CI | #3 |
| 5 | Langfuse OTEL tracing + self-hosted Docker stack | #1 |
| 6 | BetterStack structured logging + heartbeats + alert | #2 |
| 7 | BetterStack MCP server (remote MCP URL, Edith + Claude Desktop) | — |
| 8 | Proactive intervention heuristic triggers | #5 |
| 9 | Claude Desktop scheduled tasks cleanup | #8 |
| 10 | Empty skill folders filled | — |
| 11 | Service URLs in README + ARCHITECTURE-V4.md | — |
| 12 | Project auditor dynamic doc discovery | — |

## Previously completed (PLAN.md Phases 1-2)

All 16 items in PLAN.md Phases 1-2 are done (state.ts cleanup, constant dedup, scheduler unification, storage standardization, screen context dedup, dashboard extraction, handler extraction, tick extraction, dispatch refactor).

---

## Open Tasks

### P1 — High Priority

*None currently — all P1s done. T3 partially complete (Observability header fixed, Development Process header remaining).*

### P2 — Medium Priority

#### T1: Integration tests for dispatch-to-agent flows
**GitHub Issue: #4**

```yaml
task:
  title: Add integration tests for dispatch-to-agent flows
  type: gap
  domain: testing
  priority: p2
  complexity: medium

ownership:
  modifies:
    - tests/dispatch-integration.test.ts (new)
    - tests/scheduler-integration.test.ts (new)
  reads:
    - lib/dispatch.ts
    - lib/scheduler.ts
    - lib/tick.ts
    - lib/briefs.ts

context:
  description: |
    Unit tests cover isolated functions but nobody tests the actual
    dispatch → agent → tool call flows. Add integration tests with
    mocked LLM calls that test real flows end-to-end.
  acceptance_criteria:
    - Test: scheduler tick → shouldFire() → brief building → dispatch
    - Test: message received → dispatch → response
    - Test: dead-letter save → restart → replay → delivery
    - Test: idle detection → scheduler skips interval tasks
    - All tests pass with mocked Agent SDK (no real LLM calls)
  approach:
    - Create test helpers that mock Agent SDK query() responses
    - Test scheduler tick fires correct tasks at correct times
    - Test dispatch handles success, timeout, and circuit breaker
    - Test brief building for each type (morning, midday, evening, proactive)

verification:
  automated:
    - bun run tsc --noEmit
    - bun test
```

#### T2: Archive taskboard entries before rotation
**GitHub Issue: #7**

```yaml
task:
  title: Archive taskboard entries before rotation for review history
  type: gap
  domain: activity-log
  priority: p2
  complexity: small

ownership:
  modifies:
    - lib/taskboard.ts
  reads:
    - lib/config.ts
    - lib/activity.ts

context:
  description: |
    rotateTaskboard() prunes entries >12h old with no archiving.
    Weekly/monthly reviewers can't see what happened on previous days.
    Archive pruned entries to monthly files before deleting.
    Note: activity log (lib/activity.ts) partially fills this gap
    for screen context, but taskboard has richer data (email triage
    results, meeting prep, decisions made).
  acceptance_criteria:
    - rotateTaskboard() writes pruned entries to ~/.edith/taskboard-archive/YYYY-MM.md
    - Archive file is append-only
    - getTaskboardArchive(months) export for review agents
    - Existing rotation behavior unchanged
  approach:
    - Before filtering, collect entries that will be pruned
    - Append to ~/.edith/taskboard-archive/YYYY-MM.md
    - Add getTaskboardArchive() export
    - Update weekly/monthly reviewer agent prompts to reference archive

verification:
  automated:
    - bun run tsc --noEmit
    - bun test
    - "grep -q 'taskboard-archive' lib/taskboard.ts"
```

#### T3: Update ARCHITECTURE-V4.md with current state (partially done)
**No GitHub issue yet — doc cleanup task**

Observability header already fixed. Remaining work:

```yaml
task:
  title: Update ARCHITECTURE-V4.md to reflect implemented features
  type: improvement
  domain: infra
  priority: p2
  complexity: small

ownership:
  modifies:
    - ARCHITECTURE-V4.md
  reads:
    - lib/telemetry.ts
    - lib/logger.ts
    - .github/workflows/ci.yml
    - .husky/pre-commit

context:
  description: |
    Development Process section (line 623) still says "Planned" despite
    pre-commit, CI, and task pipeline being implemented. Agent count
    may need updating (11 agents exist). Near-term checklist has
    completed items that should be removed.
  acceptance_criteria:
    - Development Process header says "Development Process" not "Development Process (Planned)"
    - Near-term next steps list only contains undone items
    - Agent count is correct (11)
  approach:
    - Change Development Process header from (Planned) to current
    - Update near-term checklist, remove completed items
    - Fix agent count if stale
    - Mark implemented features as such in their descriptions

verification:
  automated:
    - "! grep -q 'Development Process (Planned)' ARCHITECTURE-V4.md"
```

#### T4: Update docs/data-sources.md — fix Google Docs blocker status
**No GitHub issue yet**

```yaml
task:
  title: Update data-sources.md — fix Google Docs status, update review-templates.md
  type: improvement
  domain: infra
  priority: p2
  complexity: trivial

ownership:
  modifies:
    - docs/data-sources.md
    - docs/review-templates.md
  reads:
    - lib/activity.ts
    - mcp/server.ts

context:
  description: |
    data-sources.md lists Google Docs creation as a "HIGH BLOCKER"
    (line 72) but it's implemented via manage_docs MCP tool.
    docs/review-templates.md still references Screenpipe as primary
    data source without noting activity log as replacement.
  acceptance_criteria:
    - Google Docs blocker removed or marked implemented
    - review-templates.md notes activity log alongside Screenpipe
  approach:
    - Update Google Docs status from blocker to implemented
    - Update review-templates.md data source references

verification:
  automated:
    - "! grep -q 'BLOCKER' docs/data-sources.md"
```

### P3 — Low Priority / Future

#### T5: Set up Grafana as unified observability dashboard
**GitHub Issue: #9**

```yaml
task:
  title: Set up Grafana as unified observability dashboard
  type: gap
  domain: observability
  priority: p3
  complexity: medium

ownership:
  modifies:
    - docker-compose.langfuse.yml
    - ARCHITECTURE-V4.md
    - README.md
  reads:
    - lib/logger.ts
    - lib/telemetry.ts

context:
  description: |
    Single dashboard for Langfuse traces + BetterStack logs.
    Grafana pulls from Clickhouse (Langfuse) and Logtail API (BetterStack).
  acceptance_criteria:
    - Grafana at localhost:3001 via Docker
    - Langfuse + BetterStack data sources connected
    - At least one dispatch metrics dashboard
    - Service URL in README + ARCHITECTURE-V4.md
  approach:
    - Add Grafana to docker-compose.langfuse.yml
    - Configure Clickhouse + Logtail data sources
    - Build "Edith Operations" dashboard

verification:
  automated:
    - "curl -s http://localhost:3001/api/health | grep ok"
```

#### T6: Split MCP tool registrations into separate files
**From PLAN.md Phase 3, item 17**

```yaml
task:
  title: Split MCP tool registrations into separate files
  type: improvement
  domain: mcp
  priority: p3
  complexity: small

ownership:
  modifies:
    - mcp/server.ts
    - mcp/tools/telegram.ts (new)
    - mcp/tools/schedule.ts (new)
    - mcp/tools/calendar.ts (new)
  reads: []

context:
  description: |
    mcp/server.ts has all tool registrations in one file.
    Split into domain-specific files for maintainability.
  acceptance_criteria:
    - Each tool domain in its own file under mcp/tools/
    - mcp/server.ts imports and registers from tool files
    - All MCP tools still work
  approach:
    - Create mcp/tools/ directory
    - Extract tool groups (telegram, schedule, calendar, email, etc.)
    - Update server.ts to import from tool files

verification:
  automated:
    - bun run tsc --noEmit
    - bun test
```

#### T7: Extract dashboard data-access functions
**From PLAN.md Phase 3, item 18**

```yaml
task:
  title: Extract dashboard data-access functions to lib/
  type: improvement
  domain: infra
  priority: p3
  complexity: small

ownership:
  modifies:
    - dashboard.ts
    - lib/dashboard-data.ts (new)
  reads: []

context:
  description: |
    Dashboard has inline data-access functions (getStatus, getStats,
    readEventsFile) that could be reused by MCP tools or agents.
  acceptance_criteria:
    - Data-access functions extracted to lib/dashboard-data.ts
    - Dashboard imports from lib/
    - No functional change
  approach:
    - Extract getStatus, getStats, readEventsFile to new module
    - Import in dashboard.ts

verification:
  automated:
    - bun run tsc --noEmit
    - bun test
```

### Future (design phase, not yet actionable)

These are documented but need design decisions before they become tasks:

- **Desktop companion** (Tauri + Rive) — `docs/desktop-companion.md`
- **Gemini Live screen awareness** — `docs/screen-awareness.md`
- **Product distribution** — `docs/distribution.md`
- **Remove Docker dependency** (n8n as child process)
- **Email approval flow** (send via n8n + confirmation)
- **Slack/WhatsApp inbound**
- **Dashboard UI improvements** (cost charts, reminder management)

---

## Files to clean up

| File | Action |
|------|--------|
| `PLAN.md` | Phase 1-2 done. Keep Phase 3 + Future, or remove and use this file |
| `NEXT-SESSION.md` | Fully completed. Delete. |
| `ARCHITECTURE-V4.md` | Update stale "Planned" headings (T3 above) |
| `docs/data-sources.md` | Add activity log, fix Google Docs status (T4 above) |
| `docs/distribution.md` | Mark Phase 1 as complete |
| `docs/review-templates.md` | Note activity log replaces screenpipe for history |
