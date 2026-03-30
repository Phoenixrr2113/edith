# Next Session: Build the Task Pipeline

## Context
Read `ARCHITECTURE-V4.md` — specifically the **"Development Process (Planned)"** section and the **"Task Pipeline: Audit → Plan → Execute → Verify"** subsection. Everything is documented there.

## What was done last session
- Fixed dead-letter replay (3 duplicate messages), location log spam
- Added idle detection + scheduler gating (interval tasks skip when user idle >5 min)
- Fixed screen context windows (proactive 180→15 min, midday 15→240 min)
- Built activity log system (`lib/activity.ts`, MCP tool, tests)
- Updated ARCHITECTURE-V4.md with: observability plan (Langfuse + BetterStack), dev process (pre-commit, CI, integration tests), task pipeline design (audit → plan → execute → verify)
- All code changes are uncommitted — commit first

## What to do this session

### Phase 1: Commit + Foundation
1. **Commit all uncommitted changes** from last session
2. **Set up GitHub Project** board for edith-v3 with columns: Backlog, Ready, In Progress, Done, Failed
3. **Set up pre-commit hook** — Husky + `tsc --noEmit` + `bun test`

### Phase 2: Build the Task Pipeline Agents/Skills
Build these four components (see ARCHITECTURE-V4.md for full specs):

1. **`.claude/agents/project-auditor.md`** — Explore agent that:
   - Reads every doc file (ARCHITECTURE-V4.md, docs/*, CLAUDE.md, prompts/*, TODO comments in code)
   - For each requirement/feature/plan, searches codebase to verify: implemented, gap, broken, outdated
   - Creates GitHub Issues with ATS YAML format for gaps
   - Adds issues to the GitHub Project board in Backlog column

2. **`.claude/skills/plan-task/SKILL.md`** — Takes a GitHub Issue #:
   - Reads ATS spec from issue body
   - Validates file ownership, dependencies, scope
   - Marks issue as `ready` label, moves to Ready column

3. **`.claude/skills/work-task/SKILL.md`** — Pulls next ready task:
   - Queries `gh issue list --label ready --label ats`
   - Reads ATS YAML, implements following approach/steps
   - Runs verification, creates PR linked to issue
   - Moves to Done or Failed column

4. **`.claude/skills/verify-task/SKILL.md`** — Post-implementation:
   - Runs acceptance criteria commands
   - Type check + tests
   - Updates issue status

### Phase 3: Run the First Audit
Run the project-auditor agent against ARCHITECTURE-V4.md and docs/*. Let it create the initial backlog of issues in GitHub Projects.

## Key files to read first
- `ARCHITECTURE-V4.md` — full architecture + all planned features
- `docs/data-sources.md` — capability gaps
- `docs/distribution.md` — product packaging plans
- `docs/screen-awareness.md` — Gemini Live API plans
- `.claude/agents/` — existing agent patterns to follow
- `.claude/skills/` — existing skill patterns to follow

## Randy's system prompt for agents
The ATS (Atomic Task Specification) template and agent rules are in Randy's system prompt — he will provide this. Key principles: bounded scope (≤3-5 files), file ownership enforced, explicit acceptance criteria, verification commands, no partial implementations.
