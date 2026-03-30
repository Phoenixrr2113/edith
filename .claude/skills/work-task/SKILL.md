---
name: work-task
description: "Pull the next ready ATS task from GitHub Issues and implement it. Usage: /work-task [issue-number]"
---

# Work Task

Implements the next ready ATS task. Optionally takes a specific issue number; otherwise pulls the highest-priority ready task.

## Step 1: Find the task

If an issue number was provided, use it. Otherwise:
```bash
gh issue list --repo Phoenixrr2113/edith --label ready --label ats --json number,title,labels --limit 10
```

Pick the highest-priority issue (p0 > p1 > p2 > p3). If multiple at same priority, pick the one with fewest dependencies.

## Step 2: Claim the task

```bash
gh issue edit <NUMBER> --repo Phoenixrr2113/edith --remove-label ready --add-label in-progress
```

Update project board status to "In Progress" if available.

## Step 3: Parse ATS spec

Extract YAML from the issue body. Read every file in `ownership.reads` and `ownership.modifies` to understand the current state.

## Step 4: Implement

Follow the `context.approach` steps exactly. Key rules:

- **Only modify files listed in `ownership.modifies`** — if you need to touch other files, stop and update the ATS spec first
- **Follow existing patterns** — read neighboring code, match style
- **No partial implementations** — either complete the task fully or don't start
- **No extra features** — implement exactly what the acceptance criteria require
- **Security checklist**: no hardcoded secrets, no command injection, validate inputs at boundaries

## Step 5: Verify

Run every command in `verification.automated`:
```bash
bun run tsc --noEmit
bun test
# ... any task-specific verification commands
```

If verification fails, fix the issue. If you can't fix it after 2 attempts, mark the issue as `failed` with a comment explaining what went wrong.

## Step 6: Create PR

```bash
git checkout -b ats/<NUMBER>-<short-slug>
git add <modified files only>
git commit -m "feat: <title> (closes #<NUMBER>)"
git push -u origin ats/<NUMBER>-<short-slug>
gh pr create --repo Phoenixrr2113/edith \
  --title "<title>" \
  --body "Closes #<NUMBER>

## Changes
<bullet list of what changed>

## Verification
<paste verification output>

## ATS Spec
See #<NUMBER>"
```

## Step 7: Update issue

On success:
```bash
gh issue edit <NUMBER> --repo Phoenixrr2113/edith --remove-label in-progress --add-label complete
```

On failure:
```bash
gh issue edit <NUMBER> --repo Phoenixrr2113/edith --remove-label in-progress --add-label failed
gh issue comment <NUMBER> --repo Phoenixrr2113/edith --body "❌ Failed: <reason>. PR: <url or 'none'>"
```

Update project board status accordingly.

Print result: `DONE: Issue #<N> — PR #<PR>` or `FAILED: Issue #<N> — <reason>`
