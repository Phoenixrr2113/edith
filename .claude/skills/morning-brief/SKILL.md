---
name: morning-brief
description: "Run Randy's morning brief — calendar, email, reminders, and memory context. Use this skill at the start of each day (triggered automatically by edith.ts at 8:03 AM) or whenever Randy asks for a morning update, daily summary, or 'what's on today'."
---

# Morning Brief

The morning brief sets Randy up for his day. The goal is to surface everything he needs to know in one concise message so he can scan it in 30 seconds and know what's coming.

## Why this matters

Randy checks Telegram first thing. If the brief is useful, he trusts Edith. If it's noise, he ignores it. Lead with what's actionable — don't pad with filler.

## Steps

1. **Memory context** — Search Cognee for recent context: what happened yesterday, pending decisions, anything Randy mentioned he'd follow up on. This gives the brief continuity across days.

2. **Calendar** — Use `get_calendar` to get today's events. Note start times, who's involved, and any prep needed.

3. **Email** — Use `get_emails` to find unread or flagged emails. Focus on what needs a response today, not the full inbox.

4. **Reminders** — Use `list_reminders` to check for time-based reminders due today.

5. **Send the brief** — Use `send_message` to deliver a single, scannable message. Keep it tight.

6. **Store observations** — If you notice patterns (e.g. recurring meeting prep, a project ramping up), store them in Cognee for future reference.

## Output format

**Example:**
```
Good morning. Here's your day:

📅 Calendar
- 10:00 AM — Standup (eng team)
- 2:00 PM — 1:1 with Sarah

📧 Email
- Invoice from Acme Corp needs approval
- Sarah shared the Q2 deck

⏰ Reminders
- Call dentist to reschedule (due today)

📝 Context
- You mentioned finishing the proposal for DataCo yesterday — still in drafts.
```

Adapt the sections based on what's actually there. Skip empty sections entirely — don't write "No emails" or "No reminders."

## Taskboard

Write your findings to the taskboard file (path provided in your prompt). This lets the main conversation session know what you found, even if Randy doesn't read the Telegram message right away.
