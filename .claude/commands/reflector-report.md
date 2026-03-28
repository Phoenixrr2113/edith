Analyze reflector performance from `~/.edith/events.jsonl`. Parse all `reflector_*` events and report:

## What to extract

Use bash to grep and parse:
```
grep '"reflector_' ~/.edith/events.jsonl
```

Event types:
- `reflector_evaluation` — has `score`, `label`, `mode` (active|eval-only), `assessment`
- `reflector_injection` — has `trigger`, `label`, `mode`
- `reflector_silent` — reflector decided no injection needed
- `reflector_assigned` — session A/B assignment
- `reflector_error` — failures

## Report format

**Overall:**
- Total sessions evaluated, avg score
- Score distribution (histogram)

**A/B Comparison (the key metric):**
- `active` sessions: count, avg score
- `eval-only` sessions: count, avg score
- Delta and whether reflector is helping or hurting

**By task label:**
- Avg score per label (check-reminders, proactive-check, message, etc.)
- Split by mode if enough data

**Injections:**
- Total injections, by trigger type (periodic, compaction, guard)
- How often reflector stays silent vs injects

**Worst sessions:**
- Bottom 5 by score with label, mode, and assessment snippet

**Trend:**
- Last 24h avg vs last 7d avg (is it improving over time?)

Keep it concise — this is a quick health check, not a deep analysis.
