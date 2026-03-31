# Agent Consolidation Evaluation: Specialized vs General+Skill

**Issue:** ARCH-QUAL-064
**Status:** Analysis complete
**Date:** 2026-03-30

---

## Current State: 11 Specialized Agents

| Agent | Model | Tool Count | Frequency |
|-------|-------|-----------|-----------|
| `morning-briefer` | sonnet | 12 | Daily |
| `midday-checker` | sonnet | 13 | Daily |
| `evening-wrapper` | sonnet | 13 | Daily |
| `weekend-briefer` | sonnet | 10 | 2x/week |
| `email-triager` | sonnet | 7 | On-demand |
| `weekly-reviewer` | sonnet | 14 | Weekly |
| `monthly-reviewer` | sonnet | 12 | Monthly |
| `quarterly-reviewer` | sonnet | 12 | Quarterly |
| `reminder-checker` | haiku | 6 | Every 5 min |
| `researcher` | sonnet | 6 | On-demand |
| `project-auditor` | opus | 6 | On-demand |

Each agent bundles: tool scope + behavioral spec + model selection into a single `.md` file.

---

## Proposed State: 4 General Agents + Skills

| Agent | Model | Skills it runs |
|-------|-------|----------------|
| `communicator` | sonnet | morning-brief, midday-check, evening-wrap, weekend-brief, email-triage |
| `analyst` | sonnet (opus for quarterly) | weekly-review, monthly-review, quarterly-review |
| `monitor` | haiku | reminder-check, proactive-check |
| `researcher` | sonnet | research, meeting-prep |

Skills live at `.claude/skills/<name>/SKILL.md` and are injected as a workflow overlay at dispatch time. The agent provides execution identity (tool defaults, model baseline); the skill provides the task spec.

---

## Dimension-by-Dimension Comparison

### 1. Prompt Quality

**Specialized agents (current):**
- Workflow and identity are co-located. The agent prompt IS the behavioral spec.
- No risk of context fragmentation — the full workflow is always present.
- `morning-briefer` and `midday-checker` share nearly identical steps 1-2 (Cognee + calendar + email). This is copy-paste duplication — divergence is the natural outcome over time.
- `evening-wrapper` and `weekly-reviewer` both touch taskboard, Screenpipe, and activity log with slightly different window lengths. Already drifted: evening uses `days: N/A`, weekly uses `days: 7`, but both format taskboard entries with the same ISO-timestamp prefix pattern.

**General + skill (target):**
- Base agent prompt is stable (doesn't change per-task).
- Skill workflow is injected as a second pass into the same session.
- Risk: if the agent's base prompt and skill workflow make conflicting assumptions (e.g., base communicator allows `send_message` freely; email-triage skill should not send messages, only draft), the agent must resolve the conflict. Without runtime tool scope enforcement, the base prompt wins.
- Benefit: shared sub-steps (Cognee lookup, taskboard read) can live in the base agent prompt and execute once, not duplicated per skill. This is a meaningful quality improvement for multi-step briefs.

**Verdict:** Slight edge to specialized agents now due to co-location clarity. General+skill wins long-term if sub-step deduplication is done and tool scope enforcement is real.

---

### 2. Tool Scoping

**Specialized agents (current):**
- Tool allowlists are declared in agent frontmatter.
- The `allowed-tools` field is respected by Claude Code's agent invocation — tools not listed are unavailable.
- `reminder-checker` correctly restricts to 6 tools; running it through a general agent with 12+ tools introduces accidental capability surface.
- Actual enforcement is at Claude Code's skill/agent invocation layer, not in the Agent SDK's `query()` call. The `lib/dispatch.ts` hardcodes `allowedTools` as a static list of broad Claude Code built-ins (Read, Write, Edit, Bash, Glob, Grep, WebFetch, WebSearch, Agent, Skill) plus whichever MCP servers are in `.mcp.json`. It does NOT read agent frontmatter.
- This means the current specialized agent tool scope is effectively documentation — not enforced at dispatch time.

**General + skill (target):**
- The design (per `docs/design-skill-library.md`) proposes skill-level `tools.allowed` injected before the session spawns.
- This requires `lib/dispatch.ts` to parse the skill's SKILL.md before calling `query()` and use the parsed list as the `allowedTools` parameter.
- This is an improvement over current state (where tool scope isn't enforced at all in the dispatch path).
- Fine-grained action-level deny (e.g., `manage_emails#delete`) is not currently possible with the Claude Agent SDK — the `allowedTools` array is at the tool name level. This feature is aspirational.

**Verdict:** Neither approach actually enforces tool scope today — it's both documented, not enforced. The general+skill approach provides a better forcing function to implement real enforcement because skills define scope explicitly in a machine-parseable format.

---

### 3. Cost Per Dispatch

Observed patterns (from `~/.edith/events.jsonl` log structure, costs tracked per label):

- `reminder-checker` uses haiku: lowest cost by far, ~$0.0001-0.0003 per run.
- Daily briefs (morning/midday/evening) are the largest cost driver — they use sonnet and do web search, email, calendar, and doc creation.
- `quarterly-reviewer` uses opus: highest cost per run but runs 4x/year.

**Specialized agents (current):**
- Each agent declares its own model. Cost is baked into the agent definition.
- `morning-briefer` on sonnet: appropriate. No opus overhead for a daily task.

**General + skill (target):**
- Skills override model per-task (haiku for reminder-check, opus for quarterly-review).
- The monitor base agent defaults to haiku — reminder-check stays cheap without any override needed.
- Risk: if routing logic sends the wrong task to the wrong base agent (e.g., reminder-check routes to communicator instead of monitor), it runs on sonnet instead of haiku. At 288 daily runs, that's a meaningful cost error.

**Verdict:** Cost profile is equivalent if routing is correct. The general+skill routing table (hardcoded in `SKILL_ROUTING` in `lib/briefs.ts`) makes cost decisions explicit and auditable. Specialized agents have the cost decision distributed across 11 files — harder to audit.

---

### 4. Complexity at Dispatch Time

**Specialized agents (current):**
- `lib/dispatch.ts` is model-agnostic. It receives a prompt (built by `buildBrief()`) and dispatches it.
- `lib/briefs/scheduled.ts` builds task-specific prompts using `BRIEF_TYPE_MAP`.
- Routing is: task name → brief type → `buildBrief()` → flat prompt string.
- Adding a new scheduled task requires: (a) a new agent `.md`, (b) a new skill `.md` file that says "run the agent", (c) a new case in `BRIEF_TYPE_MAP`, (d) a new build function in `briefs/scheduled.ts`.
- The current skill files under `.claude/skills/` (morning-brief, midday-check, etc.) are thin delegators that just say "run the corresponding agent." They add a file layer without adding capability.

**General + skill (target):**
- Adding a new task requires: (a) a new SKILL.md with full workflow, (b) a routing table entry in `SKILL_ROUTING`.
- Eliminates the agent file + thin skill file split that exists now.
- `lib/dispatch.ts` would need to: load SKILL.md, parse frontmatter, build tool list, inject workflow as system context. This is new complexity in the dispatch path.
- Complexity moves from "many simple files" to "one smarter dispatch function." Net complexity is probably similar; the dispatch function's complexity is easier to test than 11 independent agent files.

**Verdict:** Comparable complexity now. General+skill reduces total file count and eliminates the agent+thin-skill duplication pattern that currently exists in the repo.

---

### 5. Maintainability

**Specialized agents (current):**

Duplication audit across the 11 agent files:

- Cognee search step: identical or near-identical in morning-briefer, midday-checker, evening-wrapper, weekly-reviewer, monthly-reviewer, quarterly-reviewer (6/11 agents).
- Taskboard read: identical in morning-briefer, midday-checker, evening-wrapper, weekly-reviewer, monthly-reviewer (5/11).
- Telegram message format rules: repeated in full in every communication agent (morning, midday, evening, weekend, email-triager).
- "Randy has ADHD" communication note: appears in morning-briefer explicitly; implied in others.

When the Telegram message format needs to change (it has changed multiple times based on git log), every communication agent file must be updated. Missed updates create inconsistency.

**General + skill (target):**
- Base communicator prompt holds the Telegram format rules once.
- Cognee search pattern lives in the base agent prompt once.
- Skills inherit these defaults and only specify what's different.
- Changes to shared behavior = edit one file.

**Verdict:** General+skill wins clearly on maintainability. The current duplication is already causing drift (midday-checker and morning-briefer have diverged on weather step presence; evening-wrapper omits Cognee search setup that morning-briefer includes).

---

## Summary Scorecard

| Dimension | Specialized (now) | General + Skill (target) | Winner |
|-----------|------------------|--------------------------|--------|
| Prompt clarity | Co-located, clear | Requires two files | Specialized (slight) |
| Tool scope enforcement | Not enforced in dispatch | Better forcing function | General+skill |
| Cost auditability | Distributed across 11 files | Centralized routing table | General+skill |
| Dispatch complexity | Simple, flat | Requires smarter dispatch | Tie |
| Maintainability | High duplication, drift risk | Single source for shared rules | General+skill |
| File count | 11 agents + 9 thin skills = 20 | 4 agents + 11 skills = 15 | General+skill |

---

## Key Finding: Current Skill Files Are Vestigial

The existing `.claude/skills/` directory contains 9 skill files (morning-brief, midday-check, evening-wrap, weekend-brief, check-reminders, plan-task, verify-task, work-task, skill-creator). All of them are implemented as thin delegators or as full workflows that duplicate the corresponding agent file. They add a file layer without structural benefit. The design in `docs/design-skill-library.md` correctly identifies this as the problem to solve — the migration IS the consolidation.

---

## Recommendation: Proceed with General + Skill Architecture

The quality comparison favors consolidation. The main risk (prompt fragmentation from two-file skill injection) is manageable and is outweighed by the maintainability gains from eliminating duplication across 6+ agent files.

The issue spec (ARCH-QUAL-064) asks for 5 live A/B test runs before deciding. Given the analysis above, the architecture decision can be made without waiting for live telemetry — the duplication problem is observable statically. Live A/B testing is still valuable for validating that the general agent prompt + skill injection produces equivalent output quality to the specialized agent, and for catching any regression in the morning-brief format.

**Recommendation: proceed with consolidation. Run the A/B test in parallel to validate, not to decide.**

---

## Migration Order

Priority is determined by: (1) frequency (highest impact first), (2) simplicity (easier wins to validate the pattern), (3) blast radius (lower stakes first).

### Phase 1: Format existing skills (no behavior change)

Convert existing thin skill files to the full SKILL.md format with frontmatter. No agent changes. Validates the format before touching dispatch.

1. **`reminder-check`** — simplest workflow, haiku model, fires every 5 minutes. Easy to validate (fires or doesn't).
2. **`morning-brief`** — highest frequency, most visible output. Format the skill, keep morning-briefer agent as reference until Phase 2 removes it.
3. **`email-triage`** — standalone agent with clean boundaries. Good test of tool scope declaration.
4. **`midday-check`** and **`evening-wrap`** — similar to morning-brief; migrate together.
5. **`weekend-brief`** — lower frequency, safe to migrate after weekday briefs are stable.

### Phase 2: Create general agents (ARCH-AGENTS-062)

After all skills are formatted:

1. **`monitor`** — simplest base agent. Only needs `list_reminders`, `mark_reminder_fired`, `send_message`. Replaces `reminder-checker` immediately.
2. **`researcher`** — already close to target shape (minimal workflow, tool-only agent). Minor cleanup.
3. **`communicator`** — most complex. Absorbs morning-briefer, midday-checker, evening-wrapper, weekend-briefer, email-triager. The shared Cognee/taskboard steps move into the base prompt.
4. **`analyst`** — absorbs weekly/monthly/quarterly reviewers. Lower urgency (weekly frequency).

### Phase 3: Dispatch updates (ARCH-ROUTING-063)

After general agents exist:

1. Update `lib/dispatch.ts` to read skill frontmatter and build `allowedTools` from `tools.allowed`.
2. Update `lib/briefs/index.ts` `BRIEF_TYPE_MAP` to use the `SKILL_ROUTING` table format.
3. Archive the 8 specialized agent files.

### What NOT to Migrate

- **`project-auditor`** — opus model, specialized codebase tooling, infrequent use. Keep as-is. The design doc (`design-skill-library.md`) correctly labels this as "DevOps domain — not refactored."
- **`researcher`** — stays close to current form, minimal changes needed.

---

## A/B Test Setup (If Running Live Comparison)

Per the issue spec, if live telemetry validation is desired:

1. Set `REFLECTOR_EVAL_ONLY_RATIO=1.0` in `.env` during test period — all dispatches get Reflector evals.
2. Run 5 morning briefs with `morning-briefer` (current), note Langfuse trace IDs.
3. Migrate `morning-brief` skill to full SKILL.md format, point dispatch to `communicator` base agent.
4. Run 5 more morning briefs.
5. Compare via BetterStack/Langfuse: tool call count, turns, cost, Reflector eval score.

**Metrics to compare:**
- Tool call count per dispatch (lower = more focused)
- Number of turns (lower = more efficient)
- Cost per dispatch (should be equivalent if same model)
- Reflector eval score (0-10 quality score)
- Output format compliance (does the Telegram message match the expected structure)

**Go/no-go criteria:** If Reflector eval score drops >1 point on average or output format compliance breaks, revert and diagnose the base prompt + skill injection handoff.
