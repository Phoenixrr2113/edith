System health check. Report:

1. Docker containers: `docker ps --filter "name=edith\|cognee" --format '{{.Names}}: {{.Status}}'`
2. n8n health: `curl -s http://localhost:5679/healthz`
3. Cognee health: `curl -s http://localhost:8001/health`
4. Active Claude processes: `cat ~/.edith/active-processes.json`
5. Session ID: `cat ~/.edith/session-id`
6. Last 5 events: `tail -5 ~/.edith/events.jsonl`
7. Taskboard size: `wc -l ~/.edith/taskboard.md`

Report concisely. Flag anything unhealthy.
