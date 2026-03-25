---
name: check-reminders
description: "Check for due time-based reminders and fire them. Runs automatically every 5 minutes via edith.ts scheduler. Also use this skill whenever Randy asks 'do I have any reminders?' or 'what's due?'."
---

# Check Reminders

Scan for time-based reminders that are past due and deliver them to Randy. This runs frequently (every 5 minutes), so it needs to be fast and quiet — don't message Randy unless there's actually a reminder to deliver.

## Why this matters

Reminders only work if they fire reliably and on time. A missed reminder erodes trust in the whole system. Conversely, a false "no reminders" message is annoying noise.

## Steps

1. Use `list_reminders` to get all active (unfired) reminders.

2. For each reminder where `type` is `"time"` and `fireAt` is in the past:
   - Send it to Randy via `send_message`: `⏰ *Reminder*\n\n{text}`
   - Collect the reminder ID

3. Use `mark_reminder_fired` with all the fired IDs to mark them as complete.

4. If no reminders are due, do nothing. No message, no taskboard entry. Silent exit.

## Important

- Location-based reminders are handled by the edith.ts wrapper directly when it receives GPS coordinates. This skill only handles time-based reminders.
- Don't batch multiple reminders into one message — send each one separately so they're distinct notifications.
