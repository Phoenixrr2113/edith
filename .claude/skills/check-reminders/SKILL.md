---
name: check-reminders
description: "Check for due time-based reminders and fire them. Runs automatically every 5 minutes via edith.ts scheduler. Also use this skill whenever Randy asks 'do I have any reminders?' or 'what's due?'."
---

# Check Reminders

Use `list_reminders` to get active reminders. For each time-based reminder where `fireAt` is in the past, send it to Randy via `send_message`: `⏰ *Reminder*\n\n{text}`. Then `mark_reminder_fired` with the fired IDs.

If nothing is due, silent exit. No message, no taskboard entry.

Send each reminder as a separate message — distinct notifications, not batched.

Location-based reminders are handled by edith.ts directly. This skill only handles time-based ones.
