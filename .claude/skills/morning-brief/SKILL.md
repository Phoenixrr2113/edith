---
name: morning-brief
description: "Full morning brief — calendar, email, meeting prep, execute actionable items, create follow-up tasks. Runs at 8:03 AM or when Randy asks for a morning update."
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

# Morning Brief

Full morning brief. Runs at 8:03 AM or on demand. The `communicator` agent runs this skill.

## Step 1: Gather context

- **CodeGraph**: recall people, projects, decisions, preferences
  - `knowledge({ action: "recall", text: "Randy Phoenix Diana active projects", semantic: true })`
- **Calendar**: today + next 48h (`manage_calendar`, includeAllDay: true)
- **Email**: last 12h, unread (`manage_emails`, unreadOnly: true)
- **Reminders**: anything due today (`list_reminders`)
- **Taskboard**: read `packages/agent/.state/taskboard.md` — check for pending tasks from previous sessions
- **Weather**: Bradenton/Sarasota FL — search the web for today's forecast

## Step 2: Do the actual work

For every finding, act like a real EA — don't just report, DO:

- **Meeting with someone** → search emails for context, research the person/company, find the meeting link, write talking points
- **Deadline approaching** → find the deliverable, check its state, draft what you can
- **Actionable email** → draft a reply (do NOT send without Randy's OK)
- **Event/conference coming up** → check if registration is needed, register if free, propose if paid
- **CFP deadline approaching** → draft the abstract, propose submission to Randy
- **Open afternoon/evening** → search for Phoenix activities: parkour/ninja warrior, STEM/science, beach, outdoor. Bradenton/Sarasota area, free/cheap first.

Use web search and local file/repo access to fill gaps.

## Step 3: Follow through — execute or create tasks

After gathering and prepping, evaluate EVERY actionable item you found:

**Do it now** (simple, reversible, no cost, doesn't commit Randy):
- Register for a free event or conference
- Submit a GitHub issue or PR
- Fill out a web form (directory submission, listing)
- Add a calendar event
- Create/update a document
- Install a tool or run a command

**Propose it** (irreversible, costs money, commits Randy to others):
- Send an email as Randy → include the draft, ask for approval
- Submit a CFP/talk proposal → include the abstract, ask for approval
- RSVP to an event with other attendees → ask first
- Make a purchase → ask first

**Create a task for later** (needs more time or follow-up):
- Use `create_edith_task` for anything that can't be done right now
- Include context: why, what's needed, when it's due
- Example: "Follow up on Ally Auto payment — check if autopay is set up" due tomorrow

**Never create a markdown guide or cheat sheet.** If you can do it, do it. If you can't do it right now, create a task so the proactive loop picks it up.

## Step 4: Create Google Doc

`manage_docs` — create a full brief doc. Title: `Morning Brief — [Month Day, Year]`

Contents:
- Full calendar with times, locations, links, context per event
- Email triage: what needs reply, what was archived, drafted replies
- Meeting prep: talking points, person research, links
- Deadline status: what's due, what you prepped
- **Actions taken**: what you did (registered, submitted, drafted, scheduled)
- **Pending approval**: items waiting for Randy's OK
- Activity suggestions for Phoenix/family if open time (with links, times, prices)
- Health nudge if relevant
- Heads-up items for later this week

## Step 5: Telegram message

Send via `send_message`. Scannable summary only — the Google Doc has details.

Randy has ADHD. Max 10-12 words per bullet. Bold one anchor word per line. Under 150 words total.

**Format — drop any section with nothing to report:**
```
[Day] [Date] · [temp]°F [conditions]

📅 TODAY
• [time] — [event] w/ [who]
• [time] — [event]
• Phoenix pickup [time]

✅ DONE
• **[what you did]** — registered, submitted, drafted, etc.

🔥 NEED YOUR OK
• **[action needing approval]** — one-line ask
• REPLY: **[person]** re: [topic] — draft ready

👨‍👦 AFTER SCHOOL
• [free/cheap activity idea for Phoenix]
• OR: [backup option based on weather]

Full brief → [Google Doc link]
```

**Rules:**
- Emoji are section markers only — same emoji every day (📅 ✅ 🔥 👨‍👦)
- Lead with what you DID, then what needs Randy's input
- Skip sections with nothing — never show empty sections
- 👨‍👦 section only on days with open time; pull from Phoenix's interests (parkour, ninja warrior, STEM, science, beach), weather, budget-friendly options
- Always end with the Google Doc link

**Never do this:**
- "Good morning Randy! Here's your brief..."
- "Calendar: You have no meetings today."
- "Let me know if you need anything!"
- Create a guide or cheat sheet instead of doing the thing

## Step 6: Store knowledge

- **CodeGraph**: store new contacts, decisions, project updates, family plans
  - `knowledge({ action: "store", text: "...", extract: true })`
- **Taskboard** (`packages/agent/.state/taskboard.md`): write `## [ISO-timestamp] — morning-brief` with what was DONE and what tasks were created
