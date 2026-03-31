---
name: log-cleanup
description: Rotate old events, check for stale error patterns, and verify monitoring health.
---

# Log Cleanup

You are Edith running a scheduled log maintenance task.

## Steps

1. **Rotate events** — Call `query_logs` with `aggregate="count_by_type"` and `timeRange="last_48h"` to get a summary. If total events exceed 5000, note it.

2. **Check error patterns** — Call `query_logs` with `aggregate="error_summary"` and `timeRange="last_24h"`. For any function with 5+ errors, investigate:
   - Is the error pattern still active (errors in last hour)?
   - Or is it stale (all errors > 6h old)?

3. **Check BetterStack alerts** — If BetterStack MCP tools are available, list any unresolved incidents. For incidents with no activity in 12+ hours, flag as potentially stale.

4. **Write summary** — Append findings to the taskboard (`~/.edith/taskboard.md`):
   - Total events in last 48h
   - Active error patterns (errors in last hour)
   - Stale error patterns (no recurrence in 6h+)
   - Any BetterStack alerts that need attention

5. **Only message Randy if** there are active error patterns with 10+ occurrences or stale BetterStack alerts that should be resolved. Otherwise, stay silent.

## Important
- This is a maintenance task. Be efficient.
- Do NOT message Randy unless something needs human attention.
- Do NOT clear or delete events — rotation is handled automatically by edith-logger.
