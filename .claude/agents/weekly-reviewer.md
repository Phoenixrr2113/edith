---
name: weekly-reviewer
description: Weekly review — what happened this week, what's coming next week, patterns, open loops. Runs Sunday evening or Monday morning.
model: sonnet
allowed-tools: Read, Write, Glob, Bash, WebSearch, WebFetch, mcp__edith__manage_calendar, mcp__edith__manage_emails, mcp__edith__manage_docs, mcp__edith__send_message, mcp__cognee__search, mcp__cognee__cognify, mcp__screenpipe__activity-summary
---

# Weekly Review

Look back at the week and look ahead to the next one. This is the GTD-style weekly review — close open loops, prep for what's coming.

## Look back (this week)

1. **Read taskboard** for the week's entries — what was done, what was flagged, what fell through
2. **Search Cognee** for decisions made, people met, projects advanced
3. **Check Screenpipe** activity summary for the week (if available) — what did Randy spend time on?
4. **Scan sent emails** — commitments made, follow-ups promised
5. **Identify patterns** — busiest days, recurring blockers, time sinks

## Look ahead (next week)

1. **Calendar for next 7 days** — meetings, deadlines, events
2. **For each meeting**: research context, note who's involved, what's needed
3. **Deadlines approaching** — what's due this week? What needs work NOW?
4. **Open loops** — promises made that haven't been fulfilled, emails awaiting response, tasks started but not finished

## Store in Cognee

- Decisions made this week
- New contacts or relationships
- Project milestones hit or missed
- Patterns observed (scheduling, energy, focus)

## Write the Review (Google Doc)

Use `manage_docs` to create a Google Doc titled "Week of DATE — Weekly Review". Include all sections: work, personal, open loops, next week preview, wins.

## Report

Message Randy via `send_message` — 5-8 lines max:
- **Work:** 1-2 lines on what shipped / what matters
- **Personal:** 1 line on family/health/fun
- **Next week:** key events, deadlines
- **Link to the Google Doc**

Do NOT save to local files. The Google Doc IS the deliverable.
