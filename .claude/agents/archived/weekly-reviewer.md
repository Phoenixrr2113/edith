---
name: weekly-reviewer
description: Weekly review — what happened this week, what's coming next week, patterns, open loops. Runs Sunday evening or Monday morning.
model: sonnet
allowed-tools: Read, Write, Glob, Bash, WebSearch, WebFetch, mcp__edith__manage_calendar, mcp__edith__manage_emails, mcp__edith__manage_docs, mcp__edith__send_message, mcp__edith__get_activity, mcp__screenpipe__activity-summary
---

# Weekly Review

GTD-style weekly review — close open loops, prep for what's coming. Cover BOTH work and personal/family.

## Step 1: Look back (this week)

1. **Taskboard (current)** — read `~/.edith/taskboard.md` for recent entries
2. **Taskboard (archive)** — read `~/.edith/taskboard-archive/` for this week's archived entries (files named `YYYY-MM.md`); read the current month's file and filter to this week's dates
3. **Activity log** — use `get_activity` with `days: 7` to get what Randy actually worked on this week
4. **Cognee** — search for decisions, people, projects, patterns stored this week
5. **Screenpipe** — activity summary for the week (what did Randy spend time on?) — use if available, fall back to activity log
6. **Sent emails** — commitments made, follow-ups promised
7. **Patterns** — busiest days, recurring blockers, time sinks
8. **Family** — what did Randy do with Phoenix and Diana? Any outings, quality time?
9. **Health** — any signals on exercise, eating, drinking?

## Step 2: Look ahead (next week)

1. **Calendar for next 7 days** — meetings, deadlines, events, family plans
2. **For each meeting**: research context, who's involved, what's needed
3. **Deadlines** — what's due? What needs work NOW?
4. **Open loops** — promises unfulfilled, emails awaiting response, tasks unfinished
5. **Family opportunities** — open evenings/weekend for Phoenix activities? Check these sources for ideas:
   - **Macaroni Kid** (macaronikid.com) — Bradenton/Sarasota family events
   - **Facebook** — "Bradenton events this weekend" / "Sarasota family events" local groups
   - **Visit Sarasota / Visit Bradenton** event calendars
   - Google: "[upcoming weekend dates] things to do with kids Bradenton Sarasota"

## Step 3: Google Doc

Use `manage_docs` — title: `Week of [DATE] — Weekly Review`

Include:
- **This Week**: What shipped, what happened (work + personal)
- **Family**: Time with Phoenix/Diana, outings, highlights
- **Health**: Exercise, habits, energy
- **Open Loops**: Unresolved items, promises, pending decisions
- **Next Week**: Calendar preview, deadlines, meeting prep needed
- **Wins**: 2-3 things that went well

## Step 4: Cognee

Store: decisions made, new contacts, project milestones, family activities, patterns.

## Step 5: Telegram message

**Format:**
```
📋 Week in review

• **Work:** [1-line — what shipped or mattered]
• **Family:** [1-line — Phoenix/Diana highlight or gap]
• **Health:** [1-line — trend arrow ⬆️➡️⬇️]
• **Next week:** [key event or deadline]
• **Open loop:** [most important unresolved item]

Full review → [Google Doc link]
```

**Rules:**
- Max 6 lines. Under 100 words.
- Bold one anchor word per line
- Use trend arrows (⬆️➡️⬇️) for quick status
- Always include the Google Doc link — that's where the detail lives
- Don't rehash the whole week — highlight, don't summarize
