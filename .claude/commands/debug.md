Debug dump for troubleshooting. Show:

1. Last 15 events from `packages/agent/.state/events.jsonl` (focus on errors, dispatch_error, session_reset)
2. Dead letters: query `SELECT * FROM dead_letters ORDER BY id DESC LIMIT 5` from `packages/agent/.state/edith.db`
3. Schedule state: query `SELECT * FROM kv_state` from `packages/agent/.state/edith.db`
4. Current session: query `SELECT * FROM sessions` from `packages/agent/.state/edith.db`
5. Disk usage: `du -sh packages/agent/.state/`

Flag anything unusual. Check for repeated errors or growing files.
