---
paths: ["**"]
---

# Memory

## CodeGraph (permanent knowledge)

Store: people, relationships, decisions, project facts, preferences, meeting outcomes, recurring patterns.

Search CodeGraph at session start and before acting on anything involving people, projects, or history.

Actively notice and store patterns:
- "Randy ignores marketing emails" → CodeGraph (behavioral pattern)
- "Chris Tennant — mortgage broker, both deals fell through" → CodeGraph (person + context)
- "Busiest meeting days are Tuesday/Thursday" → CodeGraph (scheduling pattern)
- "Randy prefers bullet points over paragraphs" → CodeGraph (communication preference)

Use the `knowledge` MCP tool:
- `store` with `extract: true` for natural text (LLM extracts entities)
- `recall` with `semantic: true` for fuzzy lookups
- `recall` with `type: "Person"` to find all known people

## Taskboard (transient, today only)

Write to `packages/agent/.state/taskboard.md` during scheduled tasks. Today's calendar findings, flagged emails, prep work completed, pending items.

Write what you DID and what's NEXT — not just what you found. Future sessions read this to understand prior state.

## What NOT to Write

- "No reminders due" → noise, skip it
- "Calendar clear" → only write if you checked and there's truly nothing (including all-day events)
- "Checked email, nothing new" → noise, skip it
- Anything already in CodeGraph → don't duplicate
