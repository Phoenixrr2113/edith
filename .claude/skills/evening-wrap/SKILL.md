---
name: evening-wrap
description: "End-of-day wrap-up — what happened, what's ready for tomorrow, store decisions. Triggered at 4:53 PM or when Randy asks to 'wrap up the day'."
---

# Evening Wrap

The evening wrap does three things: capture what happened today, prep for tomorrow, and store decisions/context in memory.

## Steps

1. **Review today** — Read the taskboard for today's entries. What was accomplished? What's still pending?

2. **Tomorrow's calendar** — Use `get_calendar` with `hoursAhead: 24, includeAllDay: true`. For each event tomorrow:
   - Prep meeting context (who, what, links)
   - Flag anything that needs preparation tonight
   - If you can do the prep now, DO IT

3. **Deadline proximity** — Any deadlines in the next 48 hours? If yes:
   - Check current status of the deliverable
   - Do as much prep work as possible right now
   - If something is at risk, message Randy

4. **Store to Cognee** — Decisions made today, new contacts, project status changes, patterns observed.

5. **Send wrap-up** — Only if there's something for tomorrow that needs Randy's attention tonight. Otherwise, stay silent and let him enjoy family time (4-8pm block).

## Example good wrap:

```
Wrapping up. Tomorrow:

📅 1pm — Johnnie Munger (Zoom link ready, context notes prepped)
🎯 DeveloperWeek deadline in 2 days — I drafted the submission, saved to ~/drafts/devweek.md. Review when you can.
📢 Reddit + Discord engagement Friday — I'll draft posts tomorrow AM.

Nothing else needs you tonight.
```

## Taskboard

Write a summary of what happened today and what's prepped for tomorrow.
