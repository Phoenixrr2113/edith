---
name: morning-brief
description: "Full morning brief — calendar, email, meeting prep, Cognee memory, file prep. Runs at 8:03 AM or when Randy asks for a morning update."
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

# Morning Brief

Full morning brief. Runs at 8:03 AM or on demand. The `communicator` agent runs this skill.

## Step 1: Gather context

- **Cognee**: search for Randy, Phoenix, Diana, active projects, recent decisions
  ```bash
  bash /Users/randywilson/Desktop/edith-v3/mcp/cognee-direct.sh search "Randy Phoenix Diana active projects"
  ```
- **Calendar**: today + next 48h (`manage_calendar`, includeAllDay: true)
- **Email**: last 12h, unread (`manage_emails`, unreadOnly: true)
- **Reminders**: anything due today (`list_reminders`)
- **Weather**: Bradenton/Sarasota FL — search the web for today's forecast

## Step 2: Do the actual work

For every finding, act like a real EA — don't just report, do:

- **Meeting with someone** → search emails for context, research the person/company, find the meeting link, write talking points
- **Deadline approaching** → find the deliverable, check its state, draft what you can
- **Actionable email** → draft a reply (do NOT send without Randy's OK)
- **Open afternoon/evening** → search for Phoenix activities: parkour/ninja warrior, STEM/science, beach, outdoor. Bradenton/Sarasota area, free/cheap first.

Use web search and local file/repo access to fill gaps.

## Step 3: Create Google Doc

`manage_docs` — create a full brief doc. Title: `Morning Brief — [Month Day, Year]`

Contents:
- Full calendar with times, locations, links, context per event
- Email triage: what needs reply, what was archived, drafted replies
- Meeting prep: talking points, person research, links
- Deadline status: what's due, what you prepped
- Activity suggestions for Phoenix/family if open time (with links, times, prices)
- Health nudge if relevant
- Heads-up items for later this week

## Step 4: Telegram message

Send via `send_message`. Scannable summary only — the Google Doc has details.

Randy has ADHD. Max 10-12 words per bullet. Bold one anchor word per line. Under 150 words total.

**Format — drop any section with nothing to report:**
```
[Day] [Date] · [temp]°F [conditions]

📅 TODAY
• [time] — [event] w/ [who]
• [time] — [event]
• Phoenix pickup [time]

🔥 DO THIS
• **[deadline/decision]** — what you prepped
• REPLY: **[person]** re: [topic]
• DECIDE: **[one-line decision needed]**

👨‍👦 AFTER SCHOOL
• [free/cheap activity idea for Phoenix]
• OR: [backup option based on weather]

Full brief → [Google Doc link]
```

**Rules:**
- Emoji are section markers only — same emoji every day (📅 🔥 👨‍👦)
- Report what you DID, not what you FOUND
- Skip "calendar clear" or "no emails" — just omit the section
- 👨‍👦 section only on days with open time; pull from Phoenix's interests (parkour, ninja warrior, STEM, science, beach), weather, budget-friendly options
- Always end with the Google Doc link

**Never do this:**
- "Good morning Randy! Here's your brief..."
- "Calendar: You have no meetings today."
- "Let me know if you need anything!"

## Step 5: Store knowledge

- Cognee: new contacts, decisions, project updates, family plans, activity ideas that worked
  ```bash
  bash /Users/randywilson/Desktop/edith-v3/mcp/cognee-direct.sh save "..."
  ```
- Taskboard (`~/.edith/taskboard.md`): write `## [ISO-timestamp] — morning-brief` with what was done and what's next
