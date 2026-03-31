---
name: weekly-review
description: "Weekly review — what happened this week, what's coming next week, patterns, open loops. Runs Sunday evening or Monday morning."
agent: analyst
model: sonnet
tools:
  - Read
  - Write
  - Glob
  - Bash
  - WebSearch
  - WebFetch
  - mcp__edith__manage_calendar
  - mcp__edith__manage_emails
  - mcp__edith__manage_docs
  - mcp__edith__send_message
  - mcp__edith__get_activity
  - mcp__screenpipe__activity-summary
---

# Weekly Review

GTD-style weekly review. Runs Sunday evening or Monday morning. The `analyst` agent runs this skill.

Cover BOTH work and personal/family — not just work.

## Step 1: Look back (this week)

1. **Taskboard (current)** — `~/.edith/taskboard.md`, recent entries
2. **Taskboard (archive)** — `~/.edith/taskboard-archive/YYYY-MM.md` for this month; filter to this week's dates
3. **Activity log** — `get_activity` with `days: 7` — what Randy actually worked on
4. **Cognee** — search decisions, people, projects, patterns from this week:
   ```bash
   bash /Users/randywilson/Desktop/edith-v3/mcp/cognee-direct.sh search "this week decisions projects"
   ```
5. **Screenpipe** — activity summary for the week; fall back to activity log if unavailable
6. **Sent emails** — commitments made, follow-ups promised
7. **Family** — what did Randy do with Phoenix and Diana? Outings, quality time?
8. **Health** — signals on exercise, eating, drinking

## Step 2: Look ahead (next week)

1. **Calendar for next 7 days** — meetings, deadlines, events, family plans
2. **For each meeting** → research context, who's involved, what's needed
3. **Deadlines** — what's due? What needs work NOW?
4. **Open loops** — promises unfulfilled, emails awaiting response, unfinished tasks
5. **Family opportunities** — open evenings/weekends for Phoenix activities. Check:
   - **Macaroni Kid** (macaronikid.com) — Bradenton/Sarasota family events
   - **Visit Sarasota / Visit Bradenton** event calendars
   - Google: "[upcoming weekend dates] things to do with kids Bradenton Sarasota"

## Step 3: Google Doc

`manage_docs` — title: `Week of [DATE] — Weekly Review`

Sections:
- **This Week**: What shipped, what happened (work + personal)
- **Family**: Time with Phoenix/Diana, outings, highlights
- **Health**: Exercise, habits, energy trends
- **Open Loops**: Unresolved items, promises, pending decisions
- **Next Week**: Calendar preview, deadlines, meeting prep needed
- **Wins**: 2-3 things that went well

## Step 4: Cognee

Store: decisions made, new contacts, project milestones, family activities, patterns:
```bash
bash /Users/randywilson/Desktop/edith-v3/mcp/cognee-direct.sh save "..."
```

## Step 5: Telegram message

**Format:**
```
📋 Week in review

• **Work:** [1-line — what shipped or mattered]
• **Family:** [1-line — Phoenix/Diana highlight or gap]
• **Health:** [1-line — trend ⬆️➡️⬇️]
• **Next week:** [key event or deadline]
• **Open loop:** [most important unresolved item]

Full review → [Google Doc link]
```

**Rules:**
- Max 6 lines. Under 100 words.
- Bold one anchor word per line
- Use trend arrows (⬆️➡️⬇️) for quick status
- Always include the Google Doc link
- Highlight, don't summarize — the doc has the detail
