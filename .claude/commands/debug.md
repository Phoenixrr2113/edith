Debug dump for troubleshooting. Show:

1. Last 15 events from `~/.edith/events.jsonl` (focus on errors, dispatch_error, session_reset)
2. Active processes: `cat ~/.edith/active-processes.json`
3. Dead letters: `cat ~/.edith/dead-letters.json 2>/dev/null || echo "none"`
4. Schedule state: `cat ~/.edith/schedule-state.json`
5. Current session: `cat ~/.edith/session-id`
6. Telegram offset: `cat ~/.edith/tg-offset`
7. Disk usage: `du -sh ~/.edith/`

Flag anything unusual. Check for stuck processes, repeated errors, or growing files.
