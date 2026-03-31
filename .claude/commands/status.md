System health check. Report:

1. Docker containers: `docker ps --filter "name=edith\|cognee" --format '{{.Names}}: {{.Status}}'`
2. Cognee health: `curl -s http://localhost:8001/health`
3. Active Claude processes: `cat ~/.edith/active-processes.json`
4. Session ID: `cat ~/.edith/session-id`
5. Last 5 events: `tail -5 ~/.edith/events.jsonl`
6. Taskboard size: `wc -l ~/.edith/taskboard.md`

Report concisely. Flag anything unhealthy.
