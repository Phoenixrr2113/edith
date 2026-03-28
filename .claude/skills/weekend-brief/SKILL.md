---
name: weekend-brief
description: "Weekend morning brief — family activities, local events, weather, beach conditions. Triggered on Saturday/Sunday mornings at 9:03 AM or when Randy asks 'what should we do this weekend?'."
---

# Weekend Brief

Spawn the `weekend-briefer` agent to handle this. It will:
1. Check calendar, reminders, weather
2. Research local activities for Phoenix and the family
3. Create a full weekend guide as a Google Doc
4. Send a scannable Telegram summary with the doc link

See `.claude/agents/weekend-briefer.md` for full instructions.
