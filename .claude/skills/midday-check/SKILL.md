---
name: midday-check
description: "Midday check-in — catch changes since morning, prep afternoon meetings, execute actionable items, advance deadline work. Runs at 12:07 PM or when Randy asks 'anything new?'."
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
  - Agent
  - mcp__edith__manage_emails
  - mcp__edith__manage_calendar
  - mcp__edith__manage_docs
  - mcp__edith__send_message
  - mcp__edith__list_reminders
  - mcp__edith__get_activity
  - mcp__edith__create_edith_task
  - mcp__codegraph__knowledge
  - mcp__screenpipe__activity-summary
---

# Midday Check

Midday check-in. Runs at 12:07 PM or on demand. The `communicator` agent runs this skill.

## Step 1: Scan for changes

- **Email**: last 4h, unread (`manage_emails`)
- **Calendar**: next 6h (`manage_calendar`)
- **Reminders**: anything due today (`list_reminders`)
- **Taskboard**: read `packages/agent/.state/taskboard.md` — what did morning-brief do? What tasks are pending? Avoid repeating done work.
- **CodeGraph**: recall anything relevant to upcoming meetings or deadlines
  - `knowledge({ action: "recall", text: "[person or topic]", semantic: true })`

## Step 2: Do the work

Act, don't just report:

- **Meeting < 4h away** → prep now: research attendees, find links, write talking points. Save to Google Doc via `manage_docs`
- **Deadline approaching** → advance the work (draft, research, write)
- **Actionable emails** → draft replies (do NOT send without Randy's OK)
- **Pending tasks on taskboard** → pick one and execute it
- **Open evening** → quick search for family activity ideas: Phoenix interests are parkour, STEM, outdoor, beach near Bradenton/Sarasota

## Step 3: Follow through

After scanning, evaluate what you found:

- **Can do now** (simple, reversible) → do it silently. Register for event, submit form, create PR, add calendar event.
- **Needs Randy's OK** (irreversible, costs money) → include in message with one-line ask.
- **Needs more time** → `create_edith_task` with context and due date so proactive loop picks it up.

## Step 4: Decide — message or stay silent

**Message Randy ONLY if:**
- He needs to decide or approve something
- A meeting is < 2h away and you prepped materials
- Something urgent came in
- You completed something worth reporting
- You found a great family activity for tonight

**Stay silent if:**
- Nothing new since morning brief
- Everything is routine
- You only did background work (just write to taskboard)

Do NOT message "nothing to report" or "just checking in."

## Step 5: Telegram message (only if messaging)

**Format — drop any section with nothing to report:**
```
📬 Midday · [temp]°F [conditions]

✅ DONE
• **[what you executed]** — registered, submitted, drafted

🔥 NEED YOUR OK
• **[action needing approval]** — one-line ask
• REPLY: **[person]** re: [topic] — draft ready

📅 COMING UP
• [time] — [meeting in Xh] — prepped [link]

👨‍👦 TONIGHT
• [activity idea if open evening]

Full brief → [Google Doc link if created]
```

**Rules:**
- Max 3-4 bullets per section. Under 100 words total.
- Max 10-12 words per bullet. Bold one anchor word per line.
- Drop entire sections with nothing — never show empty sections
- Lead with what you DID, then what needs Randy's input
- Family suggestion only if evening is open and you found something good

## Step 6: Taskboard + CodeGraph

- **Taskboard** (`packages/agent/.state/taskboard.md`): write `## [ISO-timestamp] — midday-check` with what was DONE and what tasks were created
- **CodeGraph**: store any new knowledge (contacts, decisions, patterns)
  - `knowledge({ action: "store", text: "...", extract: true })`
