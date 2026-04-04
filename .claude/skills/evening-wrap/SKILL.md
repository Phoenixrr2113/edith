---
name: evening-wrap
description: "End-of-day wrap-up — review today, prep tomorrow, execute pending tasks, store decisions. Runs at 4:53 PM or when Randy asks to 'wrap up the day'."
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
  - mcp__edith__get_activity
  - mcp__edith__create_edith_task
  - mcp__codegraph__knowledge
  - mcp__screenpipe__activity-summary
---

# Evening Wrap

End-of-day wrap-up. Runs at 4:53 PM or on demand. The `communicator` agent runs this skill.

This is family time (4-8pm). Keep it tight. Only message if tomorrow needs attention tonight.

## Step 1: Review today

- **Taskboard** (`packages/agent/.state/taskboard.md`): what did morning/midday accomplish? What tasks are still pending?
- **Screenpipe**: activity summary — what did Randy actually work on today? (if available)
- **Email**: any loose ends from today? (`manage_emails`)
- **Calendar**: anything from today worth noting? (`manage_calendar`)

## Step 2: Execute pending work

Before prepping tomorrow, finish today's loose ends:

- **Pending tasks on taskboard** → pick simple ones and do them now
- **Emails needing replies** → draft replies, queue for Randy's approval
- **Anything surfaced today that wasn't acted on** → do it now if simple, create a task if complex

**Do it now** (simple, reversible): register for event, submit form, create PR, add calendar event.
**Create a task** (needs more time): `create_edith_task` with context and due date.

## Step 3: Prep tomorrow

- **Calendar**: tomorrow + next 48h
- **Meetings** → research context, find links, prep talking points for each
- **Deadlines < 48h** → advance the work now (draft, research, write)
- Save substantial prep to Google Doc via `manage_docs`

## Step 4: Family awareness

- Check tomorrow's calendar for family time / open blocks
- If weekend ahead → quick search for family activity ideas (Phoenix: parkour, STEM, science, outdoor, beach. Budget-friendly. Bradenton/Sarasota area.)
- Check weather for tomorrow/weekend (Bradenton/Sarasota FL)

## Step 5: Store knowledge

- **CodeGraph**: decisions made today, new contacts, project updates, patterns, family plans
  - `knowledge({ action: "store", text: "...", extract: true })`
- **Taskboard**: write `## [ISO-timestamp] — evening-wrap` with what was DONE today, tasks created, and what's prepped for tomorrow

## Step 6: Telegram message

Only message if tomorrow needs attention tonight OR you completed something worth reporting. If nothing → write taskboard, stay silent.

**Format — drop any section with nothing to report:**
```
🌙 Evening · [temp]°F tomorrow

✅ TODAY
• **[What got done]** — actions taken, not just findings
• **[Task completed]** — submitted, registered, drafted

🔥 TOMORROW
• [time] — [meeting/deadline] — prepped [link]
• DECIDE: **[anything needed tonight]**

👨‍👦 TOMORROW
• [family idea if weekend/open time]

Full prep → [Google Doc link]
```

**Rules:**
- Max 3-4 bullets per section. Under 100 words total.
- Max 10-12 words per bullet. Bold one anchor word per line.
- Drop entire sections with nothing — never show empty sections
- Lead with accomplishments (what got DONE), then what's next
- Family suggestion only if relevant (weekend coming, open evening tomorrow)
- Do NOT message "wrapping up" or "have a good evening"
