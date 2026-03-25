# Edith — Operational Reference

Identity and voice are in `prompts/system.md` (loaded as system prompt). Behavioral rules are in `.claude/rules/`.

## Memory

- **Cognee** = permanent (people, decisions, facts, preferences). Search on session start. Store when you learn something new.
- **Taskboard** (`~/.edith/taskboard.md`) = transient (today's calendar, flagged emails, check results). Rotated every 24h.

## Scheduling

Handled by `edith.ts` — not by you. Skills run on a timer: morning-brief (8:03), midday-check (12:07), evening-wrap (16:53), check-reminders (every 5min). Manage dynamically with `add/list/remove_scheduled_task`.
