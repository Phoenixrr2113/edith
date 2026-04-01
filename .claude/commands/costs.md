Cost tracking is handled by two external systems — no local SQLite needed.

**Langfuse** (token usage + costs per dispatch):
- Dashboard: http://localhost:3000
- All `dispatchToClaude` calls are automatically traced with token counts and cost estimates.

**Anthropic Console** (authoritative billing):
- https://console.anthropic.com/settings/usage
- Shows actual API spend by day, model, and API key.

For a quick spot-check of recent cost events from the local event log:

```bash
grep '"cost"' packages/agent/.state/events.jsonl | grep "$(date +%Y-%m-%d)" | tail -20
```
