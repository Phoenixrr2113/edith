---
name: check-reminders
description: "Check for due time-based reminders and fire them. Runs automatically every 5 minutes via edith.ts scheduler. Also use this skill whenever Randy asks 'do I have any reminders?' or 'what's due?'."
agent: monitor
model: haiku
tools:
  - Bash
  - Read
  - Write
  - Glob
  - mcp__edith__list_reminders
  - mcp__edith__mark_reminder_fired
  - mcp__edith__send_message
---

# Check Reminders

Lightweight reminder checker. Runs every 5 minutes automatically. The `monitor` agent runs this skill using `haiku` for speed/cost efficiency.

## Steps

1. **List reminders** — `list_reminders` to get all pending reminders
2. **Check each** — compare due time against current time (today's date: use Bash `date -u +"%Y-%m-%dT%H:%M:%SZ"`)
3. **Fire due reminders** — for each reminder that is due (dueAt <= now):
   - Send via `send_message` to Randy's Telegram: `⏰ Reminder: [reminder text]`
   - Mark as fired: `mark_reminder_fired` with the reminder ID
4. **Taskboard** — only write to `~/.edith/taskboard.md` if at least one reminder was fired

## Rules

- Only message Randy for reminders that are actually due — never for future ones
- Do NOT message "no reminders due" — stay silent
- Keep Telegram messages short: `⏰ Reminder: [text]`
- This runs every 5 minutes — be fast, use haiku
