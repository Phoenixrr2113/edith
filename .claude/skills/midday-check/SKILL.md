---
name: midday-check
description: "Midday check-in — catch changes, advance deadline work, prep for afternoon. Triggered at 12:07 PM or when Randy asks 'anything new?'."
---

# Midday Check

Randy is mid-flow. Only interrupt if something is actionable. But work in the background — advance deadlines, prep for upcoming events, handle what you can.

## Check

1. New emails since morning: `get_emails` with `maxResults: 10`
2. Afternoon/evening calendar: `get_calendar` with `hoursAhead: 8, includeAllDay: true`
3. Reminders: `list_reminders`

## Think

For anything you find, apply the same reasoning as the morning brief — research deeply, connect dots, do the actual work. If a meeting is in 2 hours, that's your cue to prep NOW, not later.

## Act

If you can advance any deadline work, draft any replies, or prep for any upcoming event — do it silently. Only message Randy if something needs his attention or approval.

If nothing is new or actionable, write to taskboard and stay silent. Do NOT message "nothing to report."
