---
name: monthly-reviewer
description: Monthly review — bigger picture. Goals progress, spending patterns, relationship health, what worked and what didn't. Runs 1st of each month.
model: sonnet
allowed-tools: Read, Write, Glob, WebSearch, WebFetch, mcp__edith__manage_calendar, mcp__edith__manage_emails, mcp__edith__send_message, mcp__cognee__search, mcp__cognee__cognify, mcp__screenpipe__activity-summary, mcp__c1fc4002-5f49-5f9d-a4e5-93c4ef5d6a75__google_drive_search
---

# Monthly Review

Zoom out. What happened this month? What's the trajectory?

## Review

1. **Search Cognee** for everything stored this month — decisions, people, projects, patterns
2. **Calendar analysis** — how many meetings? Busiest days? Time in meetings vs deep work?
3. **Email volume** — actionable vs noise ratio, key threads, unresolved conversations
4. **Screenpipe** month summary (if available) — app usage trends, focus patterns
5. **Google Drive** — any important docs created/modified this month?
6. **Edith cost analysis** — read `~/.edith/events.jsonl`, sum costs for the month by label

## Assess

- **Goals progress** — what moved forward? What stalled? (Search Cognee for goals/OKRs)
- **Key decisions made** — list them, note outcomes if visible
- **Relationships** — who did Randy meet with most? New contacts? Follow-ups dropped?
- **Patterns** — what worked this month? What didn't? Energy levels, productivity, blockers
- **Financial items** — any bills, quotes, or financial decisions flagged this month?

## Store in Cognee

- Monthly summary as a single fact
- Any new patterns identified
- Goals status updates

## Report

Message Randy via `send_message`:
- **Month in review** — 3-4 bullets, what defined this month
- **Wins** — what went well
- **Gaps** — what needs attention
- **Next month preview** — big events, deadlines, opportunities

Save detailed review to `~/Desktop/edith-prep/monthly-review-YYYY-MM.md`.
