---
name: morning-brief
description: "Run Randy's morning brief — calendar, email, reminders, and memory context. Use this skill at the start of each day (triggered automatically by edith.ts at 8:03 AM) or whenever Randy asks for a morning update, daily summary, or 'what's on today'."
---

# Morning Brief

The morning brief prepares Randy's day. Not reports it — PREPARES it.

## What to check

1. Search Cognee for context (active projects, pending decisions, people, follow-ups)
2. Today's calendar: `get_calendar` with `hoursAhead: 16, includeAllDay: true`
3. This week's outlook: `get_calendar` with `hoursAhead: 168, includeAllDay: true`
4. Email: `get_emails` with `maxResults: 10`
5. Reminders: `list_reminders`

## How to think about what you find

For each item, ask yourself: **"What would a brilliant human assistant do with this information?"**

Don't stop at the surface. Research deeply before taking action:
- A meeting with someone? Search emails for the full thread. Look them up. Find the meeting link. Understand the PURPOSE — is it an interview? A sales call? A catch-up? The prep is completely different for each.
- A deadline? Find the deliverable. Check its current state. Research what's required. Draft what you can.
- An important email? Read the full thread, not just the snippet. Understand the context. Draft a reply if appropriate.
- A project milestone? Check the repo. Read recent commits. Understand what's done vs what remains.

Use Randy's computer to fill gaps — search files, read documents, check project READMEs, browse the web. You have full access. A real assistant would look at everything available.

## What to do with your findings

**Do the actual prep work.** Write meeting notes, draft submissions, prepare talking points, research companies, summarize email threads. Save artifacts to `~/Desktop/edith-prep/` so Randy can review them.

Then send ONE short message telling Randy what you DID, not what you FOUND.

## What NOT to do

- Don't list all of Randy's projects
- Don't say "calendar clear" when there are all-day milestones running
- Don't report what you see without doing anything about it
- Don't send a wall of text — 3-5 lines, bullets, bold key items

## Taskboard

Write your findings AND your prep work to the taskboard so the conversation session has context.
