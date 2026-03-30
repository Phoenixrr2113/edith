---
name: verify-task
description: "Post-implementation verification of an ATS task. Usage: /verify-task <issue-number>"
---

# Verify Task

Runs acceptance criteria and verification commands for a completed ATS task. Updates the issue status.

## Input

Argument: GitHub Issue number

## Step 1: Read the issue

```bash
gh issue view <NUMBER> --repo Phoenixrr2113/edith --json title,body,labels,state
```

Verify issue has `ats` label and either `complete` or `in-progress` label.

## Step 2: Parse ATS spec

Extract YAML from issue body. Get:
- `verification.automated` — commands to run
- `verification.manual` — things to check by reading code
- `context.acceptance_criteria` — what must be true

## Step 3: Run automated verification

Run each command in `verification.automated` and capture output:
```bash
bun run tsc --noEmit
bun test
# ... task-specific commands
```

Record pass/fail for each.

## Step 4: Check acceptance criteria

For each criterion in `context.acceptance_criteria`:
- Search the codebase to verify it's been met
- Read modified files to confirm the implementation matches
- Check for edge cases mentioned in the criterion

## Step 5: Manual verification

For each item in `verification.manual`:
- Perform the check (read files, grep for patterns, test endpoints)
- Record result

## Step 6: Update issue

If ALL checks pass:
```bash
gh issue edit <NUMBER> --repo Phoenixrr2113/edith --remove-label in-progress --add-label verified
gh issue comment <NUMBER> --repo Phoenixrr2113/edith --body "$(cat <<'BODY'
✅ **Verified**

## Automated
- [x] tsc --noEmit: pass
- [x] bun test: pass
<other commands>

## Acceptance Criteria
- [x] <criterion 1>
- [x] <criterion 2>

## Manual
- [x] <check 1>
BODY
)"
```

Update project board status to "Done".

If ANY check fails:
```bash
gh issue edit <NUMBER> --repo Phoenixrr2113/edith --remove-label complete --add-label failed
gh issue comment <NUMBER> --repo Phoenixrr2113/edith --body "$(cat <<'BODY'
❌ **Verification failed**

## Results
- [x] tsc --noEmit: pass
- [ ] bun test: FAIL — <details>
- [x] <criterion 1>
- [ ] <criterion 2> — <what's wrong>

## Next Steps
<what needs to be fixed>
BODY
)"
```

Update project board status to "Failed".

Print result: `VERIFIED: Issue #<N>` or `FAILED: Issue #<N> — <failing checks>`
