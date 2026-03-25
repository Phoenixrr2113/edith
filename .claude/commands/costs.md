Parse `~/.edith/events.jsonl` for today's cost entries. Sum total spend, break down by label (bootstrap, message, check-reminders, morning-brief, etc). Report:

- Total cost today (USD)
- Per-task breakdown
- Number of dispatches
- Average cost per dispatch

Use bash to extract and sum: `grep '"cost"' ~/.edith/events.jsonl | grep "$(date +%Y-%m-%d)"`
