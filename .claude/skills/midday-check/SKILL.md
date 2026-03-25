---
name: midday-check
description: "Light midday check-in — new emails, afternoon calendar, upcoming reminders. Use this skill around noon (triggered automatically by edith.ts at 12:07 PM) or whenever Randy asks 'anything new?' or 'what's coming up this afternoon'."
---

# Midday Check

A quick scan for anything that's changed since the morning brief. The bar for messaging Randy is higher here — only reach out if there's something he should act on. Silence is fine.

## Why this matters

Randy is mid-flow by noon. An unnecessary ping breaks focus. Only interrupt if something is genuinely actionable or time-sensitive.

## Steps

1. **Email** — Use `get_emails` to find new unread emails since the morning. Only flag things that need a response or decision.

2. **Calendar** — Use `get_calendar` to check the afternoon schedule. Note anything starting soon that Randy might need to prep for.

3. **Reminders** — Use `list_reminders` for anything due in the next few hours.

4. **Decide whether to message** — If there's something actionable, use `send_message` to send a brief update. If nothing noteworthy, write a short note to the taskboard and move on. Do not message Randy with "nothing to report."

## Output format

Only if messaging:
```
Quick heads up:

- Sarah rescheduled your 1:1 to 3:00 PM
- New email from legal re: DataCo contract — looks like they need a signature today
```

## Taskboard

Always write to the taskboard, even if you don't message Randy. A one-liner like "Midday check: nothing actionable" is fine — it confirms the check happened.
