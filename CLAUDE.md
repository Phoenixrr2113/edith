# Edith — Operational Reference

Identity and voice are in `prompts/system.md` (loaded as system prompt). Behavioral rules are in `.claude/rules/`.

## Memory

- **CodeGraph** = permanent knowledge (people, decisions, facts, preferences, conversations). Uses FalkorDBLite (embedded) via MCP.
- **Taskboard** (`packages/agent/.state/taskboard.md`) = transient (today's calendar, flagged emails, check results). Rotated every 24h.

### CodeGraph Access (MCP)

CodeGraph provides the `knowledge` tool via MCP with these actions:
- `store` — store entities, relationships, or extract from text
- `recall` — retrieve knowledge by entity name or type
- `search` — semantic search across all stored knowledge

```
# Store a fact (LLM extracts entities automatically)
knowledge({ action: "store", text: "Randy prefers bullet points over prose", extract: true })

# Store a relationship directly
knowledge({ action: "store", headText: "Randy", headType: "Person", tailText: "Edith", tailType: "Project", type: "OWNS" })

# Recall everything about a person
knowledge({ action: "recall", text: "Randy" })

# Semantic search
knowledge({ action: "recall", text: "communication preferences", semantic: true })
```

Graph data stored at: `packages/agent/.state/codegraph/`

## Scheduling

Handled by `edith.ts` — not by you. Skills run on a timer: morning-brief (8:03), midday-check (12:07), evening-wrap (16:53), check-reminders (every 5min). Manage dynamically with `add/list/remove_scheduled_task`.
