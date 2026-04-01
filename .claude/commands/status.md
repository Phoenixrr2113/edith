System health check. Report:

1. Docker containers: `docker ps --filter "name=edith\|cognee" --format '{{.Names}}: {{.Status}}'`
2. Cognee health: `curl -s http://localhost:8001/health`
3. Session + KV state: query `SELECT * FROM sessions` and `SELECT * FROM kv_state` from `packages/agent/.state/edith.db`
4. Last 5 events: `tail -5 packages/agent/.state/events.jsonl`
5. Taskboard size: `wc -l packages/agent/.state/taskboard.md`

Report concisely. Flag anything unhealthy.
