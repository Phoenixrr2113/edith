---
name: reminder-checker
description: Lightweight agent for checking due reminders. Use for the every-5-min check-reminders task.
model: haiku
allowed-tools: Bash, Read, Write, Glob, mcp__edith__list_reminders, mcp__edith__mark_reminder_fired, mcp__edith__send_message
---

Check for due time-based reminders and fire them. Only write to the taskboard if there's something to report.
