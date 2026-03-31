# Skill Library Design

**Status:** Draft
**Issue:** ARCH-SKILLS-061
**Blocks:** ARCH-AGENTS-062 (agent refactor), ARCH-ROUTING-063 (orchestrator routing)

---

## Problem Statement

Edith currently has 11 specialized agents. Each agent bundles three concerns together:

1. **Tool scope** — which MCP tools and bash commands it can use
2. **Behavioral spec** — what it actually does (the workflow steps)
3. **Execution identity** — which model it runs on (sonnet, haiku, opus)

This coupling means adding a new capability requires a new agent file. It also means the orchestrator must know about every agent by name when routing.

The Phase 2 target: collapse to 4 general agents (`communicator`, `researcher`, `analyst`, `monitor`). Skills replace specialization — each agent has a base identity and receives a skill overlay per task. The skill IS the spec; the agent is just the execution engine.

---

## What is a Skill?

A skill is a self-contained capability definition with four required sections:

| Section | Purpose |
|---------|---------|
| `metadata` | Name, domain, description, trigger patterns |
| `tool-scope` | Explicit allowlist of tools this skill may use |
| `context-requirements` | What must be gathered before the skill runs |
| `workflow` | The step-by-step behavioral spec |
| `output-format` | What the skill produces (message, doc, file, silent) |
| `termination-conditions` | When the skill is done — what "complete" means |

Skills are **not** agents. An agent is a running Claude session with a base prompt. A skill is a prompt overlay + tool constraints injected into that session at invocation time.

---

## Skill Format

Each skill lives at `.claude/skills/<skill-name>/SKILL.md`. The format:

```markdown
---
name: <skill-name>
domain: <communication | research | analysis | monitoring | devops>
description: "One sentence. When to use this skill."
agent: <communicator | researcher | analyst | monitor>
model: <sonnet | haiku | opus>
triggers:
  - "scheduled: morning-brief"
  - "message: asks for morning update"
  - "message: what's on my calendar"
tools:
  allowed:
    - mcp__edith__manage_calendar
    - mcp__edith__manage_emails
    - mcp__edith__send_message
    - WebSearch
    - Read
    - Write
  denied:
    - mcp__edith__manage_emails#delete   # fine-grained: action-level deny
composable-with:
  - email-triage      # can be called as a sub-step
  - calendar-check
context-requirements:
  - cognee: "Randy, Phoenix, Diana, active projects"
  - calendar: "today + 48h"
  - email: "last 12h, unread"
  - taskboard: "read current"
output:
  type: <message | doc | file | silent>
  channel: telegram          # for message type
  doc-title: "Morning Brief — {date}"   # for doc type
termination:
  - "Telegram message sent with today's summary"
  - "Google Doc created (or skipped if nothing substantial)"
  - "Taskboard entry written"
---

# Skill: Morning Brief

[Full workflow steps here — replaces the agent's step-by-step content]
```

### Field Reference

**`domain`** — groups skills for routing and display. Domains:
- `communication` — email, calendar, messaging, docs
- `research` — web search, codebase search, context gathering
- `analysis` — reviews, reports, cost analysis, data synthesis
- `monitoring` — reminders, proactive triggers, screen context
- `devops` — project audit, task planning, task execution (internal tooling)

**`agent`** — which general agent runs this skill. Routing starts here.

**`model`** — overrides the agent's default model when the skill has different cost/quality needs. The `reminder-check` skill uses `haiku`; the `quarterly-review` skill uses `opus`.

**`tools.allowed`** — explicit allowlist. The general agent's base tool list is a superset; skills narrow it down. This ensures an analyst running a review skill can't accidentally send messages.

**`tools.denied`** — optional. Denies specific actions within a tool (e.g., deny `manage_emails#delete` but allow `manage_emails#get` and `manage_emails#archive`).

**`composable-with`** — declares which other skills this skill may invoke as sub-steps. Enables composition (see below).

**`context-requirements`** — what the orchestrator pre-fetches before waking the agent. Maps to `lib/briefs.ts` brief types. Reduces Claude turns by front-loading data.

**`termination`** — explicit completion criteria. The agent checks these before declaring done. Prevents both premature exit ("I sent the message, done") and runaway sessions ("keep researching forever").

---

## Skill Taxonomy

Current capabilities mapped to the new taxonomy:

### Communication Domain

| Skill | Current Agent | Agent Target |
|-------|--------------|--------------|
| `morning-brief` | morning-briefer | communicator |
| `midday-check` | midday-checker | communicator |
| `evening-wrap` | evening-wrapper | communicator + analyst |
| `weekend-brief` | weekend-briefer | communicator |
| `email-triage` | email-triager | communicator |

### Analysis Domain

| Skill | Current Agent | Agent Target |
|-------|--------------|--------------|
| `weekly-review` | weekly-reviewer | analyst |
| `monthly-review` | monthly-reviewer | analyst |
| `quarterly-review` | quarterly-reviewer | analyst |

### Monitoring Domain

| Skill | Current Agent | Agent Target |
|-------|--------------|--------------|
| `reminder-check` | reminder-checker | monitor |
| `proactive-check` | (inline in briefs.ts) | monitor |

### Research Domain

| Skill | Current Agent | Agent Target |
|-------|--------------|--------------|
| `research` | researcher | researcher (stays as-is) |
| `meeting-prep` | (inline in morning-briefer) | researcher |

### DevOps Domain (internal tooling — not refactored)

| Skill | Current Agent | Agent Target |
|-------|--------------|--------------|
| `plan-task` | project-auditor | stays as-is |
| `work-task` | project-auditor | stays as-is |
| `verify-task` | project-auditor | stays as-is |

---

## The Four General Agents

Each general agent has a base prompt that defines its identity and default tool set. Skills override the tool scope and inject the workflow spec.

### `communicator`
- **Identity:** Handles outbound and inbound communication — emails, calendar, messages, Google Docs
- **Default tools:** `manage_emails`, `manage_calendar`, `manage_docs`, `send_message`, `send_notification`, `WebSearch`, `WebFetch`, `Read`, `Write`
- **Default model:** sonnet
- **Skills:** morning-brief, midday-check, evening-wrap, weekend-brief, email-triage, meeting-prep

### `researcher`
- **Identity:** Finds information. Web, codebase, or context gathering. Reports findings; does not act on them.
- **Default tools:** `WebSearch`, `WebFetch`, `Read`, `Glob`, `Grep`, `Bash`
- **Default model:** sonnet
- **Skills:** research, meeting-prep (as sub-skill to communicator)
- **Note:** researcher stays close to its current form — no refactor needed

### `analyst`
- **Identity:** Synthesizes data into structured output (Google Docs, reports). Looks backward at history. No messaging unless the output IS the message.
- **Default tools:** `Read`, `Write`, `manage_calendar`, `manage_emails`, `manage_docs`, `get_activity`, `screenpipe/activity-summary`
- **Default model:** sonnet (quarterly-review skill overrides to opus)
- **Skills:** weekly-review, monthly-review, quarterly-review, cost-analysis

### `monitor`
- **Identity:** Lightweight background worker. Checks state, fires reminders, watches for triggers. Silent unless firing.
- **Default tools:** `list_reminders`, `mark_reminder_fired`, `send_message`, `proactive_history`, `record_intervention`, `Read`, `Write`
- **Default model:** haiku (fast and cheap for frequent checks)
- **Skills:** reminder-check, proactive-check

---

## Skill Discovery and Invocation

### Discovery

Skills are discovered by scanning `.claude/skills/*/SKILL.md` and parsing the frontmatter. The orchestrator builds a routing table at startup:

```
trigger pattern → skill name → agent + model + tool scope
```

The Claude Code skill loader (`SKILL.md` frontmatter with `name` and `description`) handles discovery for interactive `/skill-name` invocations. The `triggers` field in the new format extends this to handle scheduled and message-based invocations.

### Invocation Path

```
Signal arrives (scheduled task, Telegram message, proactive trigger)
  ↓
lib/briefs.ts — buildBrief() — identifies brief type, pre-fetches context
  ↓
lib/dispatch.ts — dispatchToClaude() — selects skill from brief type
  ↓
Skill SKILL.md loaded — tool scope extracted, workflow injected as system context
  ↓
Agent SDK session spawned with:
  - Agent base prompt (communicator/researcher/analyst/monitor)
  - Skill workflow appended
  - Tool allowlist applied
  - Pre-fetched context injected as user turn
  ↓
Agent executes workflow steps
  ↓
Termination conditions checked
  ↓
Session closes, cost logged to events.jsonl
```

### Routing Table (Orchestrator Logic)

The routing logic lives in `lib/briefs.ts` (brief type → skill mapping) and `lib/dispatch.ts` (dispatch options → agent selection). After the Phase 2 refactor this becomes explicit:

```typescript
const SKILL_ROUTING: Record<BriefType, SkillRoute> = {
  morning:    { skill: 'morning-brief',   agent: 'communicator', model: 'sonnet' },
  midday:     { skill: 'midday-check',    agent: 'communicator', model: 'sonnet' },
  evening:    { skill: 'evening-wrap',    agent: 'communicator', model: 'sonnet' },
  message:    { skill: null,              agent: 'communicator', model: 'sonnet' }, // no skill overlay for ad-hoc messages
  scheduled:  { skill: 'reminder-check', agent: 'monitor',      model: 'haiku'  },
  proactive:  { skill: 'proactive-check',agent: 'monitor',      model: 'haiku'  },
  // ...
};
```

---

## Skill Composition

Composition allows one skill to call another as a sub-step. This replaces the current pattern where the morning-briefer agent does email triage, calendar check, AND meeting prep — all in one monolithic prompt.

### Design

A composed skill invokes sub-skills in sequence (or parallel where safe). Each sub-skill runs within the same agent session — no new session spawned. The parent skill declares composition intent in `composable-with`; the sub-skill declares itself composable by including `composable: true` in frontmatter.

Example — morning-brief as a composed skill:

```markdown
# Skill: Morning Brief

## Step 1: Calendar check
Invoke sub-skill: `calendar-check` (tools: manage_calendar, read)

## Step 2: Email triage
Invoke sub-skill: `email-triage` (tools: manage_emails)

## Step 3: Meeting prep (for each meeting < 8h away)
Invoke sub-skill: `meeting-prep` (tools: WebSearch, WebFetch, manage_docs)

## Step 4: Synthesize and send brief
[Synthesis logic + send_message]
```

The tool scope for a composed execution is the union of all sub-skill allowlists, capped by the parent skill's declared `tools.allowed`.

### Composition vs. Monolith Tradeoff

The current monolithic agent approach has one advantage: the agent can see the full context of all steps at once and synthesize naturally. Composition adds structure but may fragment context.

**Recommendation:** Use composition for genuinely independent sub-tasks (email triage doesn't need to know about the calendar result). Keep monolithic for synthesis tasks (evening-wrap needs all context before writing the Cognee entry).

---

## Concrete Examples

### Example 1: `reminder-check` (simple skill, haiku model)

```markdown
---
name: reminder-check
domain: monitoring
description: "Check for due time-based reminders and fire them. Runs every 5 minutes."
agent: monitor
model: haiku
triggers:
  - "scheduled: check-reminders"
  - "message: do I have any reminders?"
  - "message: what's due?"
tools:
  allowed:
    - mcp__edith__list_reminders
    - mcp__edith__mark_reminder_fired
    - mcp__edith__send_message
    - Read
    - Write
context-requirements: []
output:
  type: message
  channel: telegram
termination:
  - "All due reminders fired via send_message"
  - "Fired reminders marked via mark_reminder_fired"
  - "Nothing due: exit silently (no message)"
---

# Skill: Reminder Check

1. Call `list_reminders` — get all time-based reminders
2. For each reminder where `due_at <= now` and `fired = false`:
   - Send Telegram message to Randy
   - Call `mark_reminder_fired` with the reminder ID
3. If nothing is due, exit silently — do NOT send "no reminders" message
```

### Example 2: `morning-brief` (complex skill, sonnet model)

```markdown
---
name: morning-brief
domain: communication
description: "Full morning brief — calendar, email, meeting prep, Cognee memory. Runs at 8:03 AM."
agent: communicator
model: sonnet
triggers:
  - "scheduled: morning-brief"
  - "message: morning update"
  - "message: what's on my calendar"
  - "message: good morning"
tools:
  allowed:
    - mcp__edith__manage_calendar
    - mcp__edith__manage_emails
    - mcp__edith__manage_docs
    - mcp__edith__send_message
    - mcp__edith__list_reminders
    - mcp__edith__get_activity
    - mcp__screenpipe__activity-summary
    - WebSearch
    - WebFetch
    - Read
    - Write
    - Bash
composable-with:
  - email-triage
  - meeting-prep
context-requirements:
  - cognee: "Randy, Phoenix, Diana, active projects, recent decisions"
  - calendar: "today + 48h, includeAllDay"
  - email: "last 12h, unread"
  - taskboard: "read current"
  - weather: "Bradenton/Sarasota FL"
output:
  type: message
  channel: telegram
  doc-title: "Morning Brief — {date}"
termination:
  - "Telegram message sent summarizing calendar, email, and any prep completed"
  - "Google Doc created if prep work is substantial (meeting notes, research)"
  - "Taskboard entry written with today's findings and actions taken"
  - "Cognee updated with any new people, decisions, or patterns observed"
---

# Skill: Morning Brief

[Full workflow — see current .claude/agents/morning-briefer.md for step-by-step]
```

### Example 3: `weekly-review` (analysis skill, produces a doc)

```markdown
---
name: weekly-review
domain: analysis
description: "GTD-style weekly review — close open loops, prep for next week. Runs Sunday evening."
agent: analyst
model: sonnet
triggers:
  - "scheduled: weekly-review"
  - "message: weekly review"
tools:
  allowed:
    - mcp__edith__manage_calendar
    - mcp__edith__manage_emails
    - mcp__edith__manage_docs
    - mcp__edith__send_message
    - mcp__edith__get_activity
    - mcp__screenpipe__activity-summary
    - Read
    - Write
    - Glob
    - Bash
    - WebSearch
    - WebFetch
context-requirements:
  - taskboard: "read current and this month's archive"
  - cognee: "decisions and people from this week"
  - activity: "last 7 days"
output:
  type: doc
  doc-title: "Weekly Review — {week-ending-date}"
  message: "telegram summary linking to doc"
termination:
  - "Google Doc created with title 'Weekly Review — {date}'"
  - "Telegram message sent with shareable Doc URL"
  - "Open loops documented in doc"
  - "Next week's calendar reviewed and prepped"
---
```

---

## Migration Path

### Phase 1: Format the existing skills (no behavior change)

The 9 existing skill files are thin delegators — they say "run the X agent." The first migration step converts each to the new format while keeping the same behavior. This is mechanical:

1. Add frontmatter fields: `domain`, `agent`, `model`, `triggers`, `tools.allowed`, `context-requirements`, `output`, `termination`
2. Move the workflow steps from the corresponding agent `.md` file into the SKILL.md body
3. Keep the agent `.md` file as a read-only reference until Phase 2 removes it

Priority order (simplest first):
1. `reminder-check` — simplest skill, haiku model, easy to validate
2. `morning-brief` — highest frequency, catches any issues early
3. `email-triage` — currently standalone agent, good test of tool scope enforcement

### Phase 2: Agent consolidation (ARCH-AGENTS-062)

After skills are formatted, the 11 specialized agents collapse to 4. The agent `.md` files that remain become base-prompt definitions — they no longer contain workflow steps (those live in skills). Steps:

1. Create `communicator.md`, `analyst.md`, `monitor.md` as base agents
2. Update `researcher.md` (minor cleanup — it's already close to the target shape)
3. Update `lib/dispatch.ts` to load skill files and apply tool scope
4. Update `lib/briefs.ts` routing table to use skill names instead of agent names
5. Archive or delete the 8 specialized agent files

### Phase 3: Routing update (ARCH-ROUTING-063)

After agents are refactored, `lib/briefs.ts` and `lib/dispatch.ts` get the explicit routing table. The `triggers` frontmatter field enables message-driven skill selection without hardcoding signal patterns in TypeScript.

---

## Skill Discovery File (index)

To avoid scanning the filesystem on every dispatch, a generated index file at `.claude/skills/index.json` caches the routing table. Regenerated when any SKILL.md changes (watch or on-startup check).

```json
{
  "skills": [
    {
      "name": "morning-brief",
      "domain": "communication",
      "agent": "communicator",
      "model": "sonnet",
      "triggers": ["scheduled: morning-brief", "message: morning update"],
      "tools": ["mcp__edith__manage_calendar", "mcp__edith__manage_emails", "..."]
    }
  ],
  "generated": "2026-03-30T08:00:00Z"
}
```

---

## Open Questions

1. **Tool scope enforcement:** The Agent SDK doesn't natively enforce per-session tool allowlists from a skill file — the tool list is set at session creation. Implementation must build the tool list from the skill's `tools.allowed` before spawning the session. If `lib/dispatch.ts` does this, it needs to load and parse SKILL.md at dispatch time.

2. **Composition session model:** Sub-skills sharing a session means shared tool scope (unioned allowlists). This needs a test — does the analyst accidentally get access to `send_message` when composing with an email-triage sub-step?

3. **Trigger matching for messages:** The `triggers` field has `"message: ..."` patterns. These need a matcher in the message handler — either exact string match, regex, or LLM classification. The ROADMAP doesn't spec this yet. For Phase 2, hardcode the routing table in TypeScript and use triggers as documentation only.

---

## Dependencies

- **Blocks:** ARCH-AGENTS-062 — agent refactor must wait for this design to be finalized
- **Blocks:** ARCH-ROUTING-063 — routing update depends on the skill format being stable
- **Parallel:** ARCH-QUAL-064 — quality comparison can run in parallel once first skills are migrated
- **Depends on:** None — this is the first task in the P2-D chain
