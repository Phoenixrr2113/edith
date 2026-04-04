---
name: sentinel-review
description: "Evaluate recent outbound messages for accuracy, timing, dedup, and improvement opportunities. Run after briefs or on demand."
agent: analyst
model: sonnet
tools:
  - Read
  - Write
  - Bash
  - Grep
  - Glob
  - WebSearch
  - mcp__edith__manage_emails
  - mcp__edith__manage_calendar
  - mcp__edith__list_reminders
  - mcp__screenpipe__activity-summary
---

# Sentinel Review

Evaluate recent messages Edith sent to Randy. Find inaccuracies, missed context, duplicates, and system issues.

## Step 1: Gather recent outbound messages

Read `packages/agent/.state/events.jsonl` and extract the last 5 `message_sent` events. For each, note the timestamp, label, and message text.

```bash
grep '"message_sent"' packages/agent/.state/events.jsonl | tail -5
```

## Step 2: Cross-reference against live data

For each message, verify claims against current state:

- **BetterStack**: Check if any mentioned incidents are still active or have been resolved
- **Calendar** (`manage_calendar`): Verify meeting times, attendees, links match what was reported
- **Email** (`manage_emails`): Check if any flagged emails have been replied to or are stale
- **Reminders** (`list_reminders`): Verify any mentioned reminders are still pending
- **Screenpipe** (`activity-summary`): Check if Randy's recent activity makes any action items stale

## Step 3: Check for patterns across messages

- **Duplicates**: Same item mentioned in multiple briefs without resolution
- **Timing drift**: Skills firing outside their expected windows
- **Error spikes**: Repeated errors in events.jsonl that indicate system bugs
- **Cost efficiency**: Sessions that produced trivial output at high cost

```bash
# Check for error patterns
grep '"error"' packages/agent/.state/events.jsonl | tail -20 | grep -oP '"type":"[^"]+' | sort | uniq -c | sort -rn
```

## Step 4: Score and report

For each message, assign a score (1-10) and list findings:

- **9-10**: Excellent — accurate, timely, well-formatted, complete
- **7-8**: Good — minor issues (formatting, slightly stale data)
- **4-6**: Needs work — missing important context, duplicates, wrong timing
- **1-3**: Bad — inaccurate claims, broken system, wrong label

## Step 5: Act on findings

- **Critical issues** (score < 5): Create GitHub issue via `gh issue create` with label `sentinel-detected`
- **Pattern issues** (same problem 3+ times): Create GitHub issue with `improvement` label
- **System bugs** (error spikes, scheduler drift): Create GitHub issue with `bug` label
- **All findings**: Append to `packages/agent/.state/sentinel-report.md`

Write findings to taskboard so the next scheduled skill is aware.

## Step 6: CodeGraph

Store any new patterns or insights:
- `knowledge({ action: "store", text: "Sentinel finding: [description]", extract: true })`
