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

**Format — drop any section with nothing to report:**
```
📬 Midday · [temp]°F [conditions]

🔥 DO THIS
• **[deadline/decision]** — what you prepped
• REPLY: **[person]** re: [topic]
• DECIDE: **[one-line decision needed]**

📅 COMING UP
• [time] — [meeting in Xh] — prepped [link]

👨‍👦 TONIGHT
• [activity idea if open evening]

Full brief → [Google Doc link if created]
```

**Rules:**
- Same section markers as morning brief (📅 🔥 👨‍👦) for consistency
- Max 3-4 bullets per section. Under 100 words total.
- Max 10-12 words per bullet. Bold one anchor word per line.
- Drop entire sections with nothing — never show empty sections
- Family suggestion only if evening is open and you found something good

## Step 5: Taskboard + Cognee

- Taskboard (`~/.edith/taskboard.md`): write `## [ISO-timestamp] — midday-check` with what was done and what's next
- Cognee: store any new knowledge (contacts, decisions, patterns)
  ```bash
  bash /Users/randywilson/Desktop/edith-v3/mcp/cognee-direct.sh save "..."
  ```
