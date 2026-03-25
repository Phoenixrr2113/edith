---
name: evening-wrap
description: "End-of-day wrap-up — summarize what happened, store decisions to memory, prep tomorrow. Use this skill in the late afternoon (triggered automatically by edith.ts at 4:53 PM) or whenever Randy asks to 'wrap up the day', 'what happened today', or 'prep for tomorrow'."
---

# Evening Wrap

Close out the day. The goal is twofold: give Randy a quick debrief, and make sure Edith's memory captures anything worth remembering long-term.

## Why this matters

This is where Edith's memory gets built. If you skip the Cognee storage step, future sessions lose context. The debrief to Randy should be short — he's wrapping up too and doesn't want a wall of text.

## Steps

1. **Review the day** — Read the taskboard for what happened (morning brief findings, midday check, any messages exchanged). Search Cognee for today's conversation context.

2. **Store to memory** — Extract key facts and decisions into Cognee. Things like: decisions made, new people mentioned, project updates, preferences expressed. This is the most important step — it's what makes Edith smarter over time.

3. **Check tomorrow** — Use `get_calendar` to preview tomorrow's calendar. Flag anything that needs prep (presentations, early meetings, deadlines).

4. **Send debrief** — Use `send_message` with a short bullet-point summary.

## Output format

**Example:**
```
Day wrap:

✅ Done today
- Finalized DataCo proposal (sent to Sarah)
- Approved Acme invoice

📅 Tomorrow
- 9:00 AM — All-hands (Q2 review deck needed)
- 2:00 PM — Dentist

🔔 Open items
- Legal still needs signature on contractor agreement
```

Skip any section that's empty. Keep it to bullet points — no paragraphs.

## Taskboard

Write your summary to the taskboard. This gets rotated after 24 hours, so don't worry about cleanup.
