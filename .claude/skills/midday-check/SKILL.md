---
name: midday-check
description: "Midday check-in — catch changes since morning, prep afternoon meetings, advance deadline work. Runs at 12:07 PM or when Randy asks 'anything new?'."
agent: communicator
model: sonnet
tools:
  - Read
  - Write
  - Edit
  - Glob
  - Grep
  - Bash
  - WebFetch
  - WebSearch
  - mcp__edith__manage_emails
  - mcp__edith__manage_calendar
  - mcp__edith__manage_docs
  - mcp__edith__send_message
  - mcp__edith__list_reminders
  - mcp__edith__get_activity
  - mcp__screenpipe__activity-summary
---

# Midday Check

Midday check-in. Runs at 12:07 PM or on demand. The `communicator` agent runs this skill.

## Step 1: Scan for changes

- **Email**: last 4h, unread (`manage_emails`)
- **Calendar**: next 6h (`manage_calendar`)
- **Reminders**: anything due today (`list_reminders`)
- **Taskboard**: read `~/.edith/taskboard.md` — what did morning-brief do? Avoid repeating it.

## Step 2: Do the work

Act, don't just report:

- **Meeting < 4h away** → prep now: research attendees, find links, write talking points. Save to `~/Desktop/edith-prep/` or create Google Doc via `manage_docs`
- **Deadline approaching** → advance the work (draft, research, write)
- **Actionable emails** → draft replies (do NOT send without Randy's OK)
- **Open evening** → quick search for family activity ideas: Phoenix interests are parkour, STEM, outdoor, beach near Bradenton/Sarasota

## Step 3: Decide — message or stay silent

**Message Randy ONLY if:**
- He needs to decide or approve something
- A meeting is < 2h away and you prepped materials
- Something urgent came in
- You found a great family activity for tonight

**Stay silent if:**
- Nothing new since morning brief
- Everything is routine
- You only did background work (just write to taskboard)

Do NOT message "nothing to report" or "just checking in."

## Step 4: Telegram message (only if messaging)

**Format — drop any section with nothing:**
```
📬 Midday

• **[Actionable item]** — what you did or need from Randy
• **[Meeting in Xh]** — prepped [link]
• DECIDE: **[decision needed]**
• 👨‍👦 Tonight: [activity idea if open evening]

[Google Doc link if created]
```

**Rules:**
- Max 3-4 bullets. Under 100 words.
- Bold one anchor word per line
- Clear call-to-action: what does Randy need to do?
- Family suggestion only if evening is open and you found something good

## Step 5: Taskboard + Cognee

- Taskboard (`~/.edith/taskboard.md`): write `## [ISO-timestamp] — midday-check` with what was done and what's next
- Cognee: store any new knowledge (contacts, decisions, patterns)
  ```bash
  bash /Users/randywilson/Desktop/edith-v3/mcp/cognee-direct.sh save "..."
  ```
