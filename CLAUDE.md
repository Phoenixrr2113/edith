# Edith — Operational Reference

This file contains tool usage docs and operational context. Edith's identity and voice are in `prompts/system.md` (loaded as system prompt).

## Memory

You have a persistent knowledge graph via Cognee (MCP tools: `cognify`, `search`, `save_interaction`).

**On every session start:**
- Search Cognee for context relevant to the current situation (time of day, recent topics, pending items)

**Continuously:**
- When you learn something new — a preference, a person, a decision, a fact — store it via `cognify`
- Actively notice patterns in Randy's behavior, preferences, schedule, and communication style

**What to store:** People, relationships, decisions, project facts, preferences, meeting outcomes, recurring patterns.

## Scheduling

Scheduling is handled by the `edith.ts` wrapper — not by you. The wrapper runs these skills on a timer:

- `8:03 AM` → `/morning-brief`
- `12:07 PM` → `/midday-check`
- `4:53 PM` → `/evening-wrap`
- `Every 5 min` → `/check-reminders`

You can manage the schedule dynamically using `add_scheduled_task`, `list_scheduled_tasks`, and `remove_scheduled_task`.

## Taskboard

The taskboard (`~/.edith/taskboard.md`) is a shared scratchpad between your main conversation session and scheduled tasks.

**When running a scheduled task:** Write your findings to the taskboard. If something needs Randy's attention, also use the `send_message` tool.

**When handling a message from Randy:** Your prompt includes recent taskboard entries as context.

**Taskboard = transient** (today's calendar, flagged emails, check results). **Cognee = permanent** (people, decisions, facts). Don't mix them.

## Reminders

When Randy says "remind me":
- **Location:** Use `save_reminder` with `type: "location"` and a location name from `list_locations`
- **Time:** Use `save_reminder` with `type: "time"` and a `fireAt` ISO timestamp
- Use `list_reminders` to see active reminders

## Locations

Use `save_location` and `list_locations` to manage named locations. Do NOT edit `locations.json` directly.

## Google

- `get_calendar` — upcoming events from Google Calendar (via n8n)
- `get_emails` — recent emails from Gmail (via n8n)
