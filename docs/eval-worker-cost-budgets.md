# Eval: Per-Worker Cost Budgets

**Task:** COST-BUDGET-067
**Date:** 2026-03-30
**Status:** Implemented (P3 — ship with tracking data available)

---

## Summary

Should individual dispatches carry their own cost ceiling beyond the daily total budget?

**Verdict: Yes — implement now.** The per-dispatch `maxCostUsd` field is low-cost to add (one interface field + one abort check) and catches runaway tasks before they eat the whole day's budget. The daily limit is a blunt instrument; per-worker limits are surgical.

---

## Problem Statement

The daily budget (`DAILY_COST_LIMIT_USD`) stops runaway spend at the aggregate level, but it fires too late:

- A single `morning-brief` gone wrong could spend $3 of a $5 daily budget before the next tick.
- `check-reminders` runs every 5 minutes. It should cost ~$0.003. If it ever costs $0.50, something is broken — not expensive.
- Without per-dispatch limits, the first runaway task silently consumes the budget and blocks everything else for the rest of the day.

---

## Recommended Per-Task Budgets

| Task label         | Expected cost   | `maxCostUsd` | Rationale |
|--------------------|-----------------|--------------|-----------|
| `check-reminders`  | $0.002 – $0.005 | `$0.05`      | Pure lookup; >$0.05 = loop or injection issue |
| `proactive-check`  | $0.005 – $0.02  | `$0.10`      | Lightweight heuristic scan |
| `message`          | $0.05 – $0.15   | `$0.25`      | User-facing; some wiggle room for complex tasks |
| `morning-brief`    | $0.10 – $0.30   | `$0.50`      | Calendar + email + prep; expensive but bounded |
| `midday-check`     | $0.05 – $0.15   | `$0.30`      | Lighter than morning brief |
| `evening-wrap`     | $0.05 – $0.20   | `$0.35`      | Similar to midday |
| `reflector`        | $0.001 – $0.01  | `$0.05`      | Eval prompt; should be tiny |

These are soft starting points. Tune after 2–4 weeks of real tracking data.

---

## Implementation

`DispatchOptions.maxCostUsd?: number` was added in `lib/dispatch.ts`. When set, `processMessageStream` calls `abortController.abort()` if `totalCost > maxCostUsd` after processing a result message. The event `cost_budget_exceeded` is logged to the events stream.

To activate per-task limits, add `maxCostUsd` to each scheduler call site in `lib/scheduler.ts` or the relevant brief builders. Example:

```ts
await dispatchToClaude(brief, {
  label: "check-reminders",
  resume: false,
  skipIfBusy: true,
  maxCostUsd: 0.05,
});
```

---

## Trade-offs

| Concern | Assessment |
|---------|-----------|
| False aborts on legitimate complex tasks | Low risk if budgets are set generously (2–5x expected cost) |
| Abort mid-stream leaves no result | Handled — `processMessageStream` returns whatever partial result accumulated before abort |
| Overhead of the check | Negligible — one number comparison per result message |
| Calibration effort | Required; use 2 weeks of `dispatch_costs` data to validate the table above |

---

## Decision

Implement and enable per-task budgets when:

1. Two weeks of cost data are available in `dispatch_costs`.
2. The 95th-percentile cost per label is measured.
3. `maxCostUsd` is set to 3–5x the p95 value.

Until then, the `maxCostUsd` field is live and available for callers that want early opt-in.
