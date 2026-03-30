---
name: plan-task
description: "Validate and approve an ATS GitHub Issue for execution. Usage: /plan-task <issue-number>"
---

# Plan Task

Takes a GitHub Issue number, validates the ATS spec, and marks it as ready for execution.

## Input

Argument: GitHub Issue number (e.g., `42`)

## Step 1: Read the issue

```bash
gh issue view <NUMBER> --repo Phoenixrr2113/edith --json title,body,labels,state
```

Verify:
- Issue has `ats` label
- Issue is open
- Body contains an ATS YAML block inside `<details>` tags

## Step 2: Parse and validate ATS spec

Extract the YAML from the issue body. Validate:

1. **Files exist**: Every file in `ownership.modifies` must exist in the repo (or be a new file that the task creates — check if the approach says "create")
2. **Dependencies resolved**: Every issue in `dependencies.blocked_by` must have label `complete` or be closed
3. **Bounded scope**: `ownership.modifies` has ≤5 files
4. **Acceptance criteria defined**: At least 1 criterion in `context.acceptance_criteria`
5. **Verification commands present**: At least `bun run tsc --noEmit` and `bun test` in `verification.automated`

## Step 3: Estimate complexity

Read each file in `ownership.modifies` and `ownership.reads`. Count total lines. Estimate:
- trivial: <100 lines changed
- small: 100-300 lines
- medium: 300-800 lines
- large: 800+ lines (consider splitting)

If complexity is `large`, suggest splitting into sub-tasks and stop — don't mark as ready.

## Step 4: Mark as ready

If validation passes:
```bash
gh issue edit <NUMBER> --repo Phoenixrr2113/edith --add-label ready
```

Update the project board status to "Ready" if a project board exists.

Comment on the issue:
```bash
gh issue comment <NUMBER> --repo Phoenixrr2113/edith --body "✅ ATS validated. Files exist, dependencies clear, scope bounded. Ready for /work-task."
```

## Step 5: Report

If validation fails, comment on the issue with what failed and what needs fixing. Do NOT add the `ready` label.

Print result:
- `READY: Issue #<N> — <title>` or
- `BLOCKED: Issue #<N> — <reason>`
