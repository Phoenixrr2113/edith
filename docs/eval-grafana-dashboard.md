# Eval: Grafana Unified Dashboard

**Issue:** OBS-GRAFANA-040
**Date:** 2026-03-30
**Status:** Complete — decision documented below

---

## 1. Current dashboard.ts Capabilities

Edith has a custom dashboard at `http://localhost:3456` (`dashboard.ts` + `dashboard.html`).

**What it does:**
- **Service health** — live status dots for edith, n8n, cognee, screenpipe
- **Event stats** — today's dispatch count, error rate, avg latency, cost (from `packages/agent/.state/events.jsonl`)
- **Live log stream** — SSE tail of `packages/agent/.state/edith.log`
- **Schedule viewer** — shows `schedule.json` and last-fire state
- **Taskboard** — renders `packages/agent/.state/taskboard.md`
- **Transcript viewer** — browse + read session transcripts
- **Task triggers** — fire any scheduled task on demand
- **Message bar** — send messages directly to Edith
- **Proactive toggle** — enable/disable interventions
- **Reminders + upcoming calendar** — next 12h events, unfired reminders

**What it does NOT do:**
- No historical charts or time-series graphs
- No cross-session trend analysis
- No cost-over-time or latency percentiles
- No alerting or threshold notifications
- No Langfuse trace data surfaced in the UI

---

## 2. What Grafana Would Replace/Improve

Grafana would add:
- **Time-series charts** — dispatch latency over days/weeks, error rate trends, cost/day
- **Langfuse trace data** — query Clickhouse directly for trace durations, model usage, token counts
- **BetterStack log data** — aggregate structured logs via Logtail HTTP API datasource
- **Unified view** — single pane for observability data currently split across localhost:3000 (Langfuse), BetterStack web UI, and localhost:3456 (dashboard)
- **Alerting** — built-in threshold alerts (e.g., error rate > 10%)

What Grafana would NOT replace:
- The operational controls (task triggers, proactive toggle, message bar) — those stay in dashboard.ts
- The transcript viewer — Grafana has no concept of that
- The taskboard/schedule view — Grafana is metrics/logs, not task state

Grafana would be an observability *supplement*, not a replacement.

---

## 3. Whether BetterStack Already Covers Monitoring Needs

**BetterStack MCP is already integrated** (`mcp/betterstack/`) with full tool coverage:
- `telemetry_query` — query logs directly
- `telemetry_chart` / `telemetry_create_dashboard_tool` — build dashboards in BetterStack UI
- `uptime_list_heartbeats_tool` — heartbeat status (edith already pings via `pingHeartbeat()`)
- `uptime_list_monitors_tool` / incidents — alerting and on-call
- `telemetry_build_metric_query_tool` — dispatch latency, error counts, cost aggregations

BetterStack already receives:
- All structured logs from `lib/logger.ts` (Logtail via `BETTERSTACK_SOURCE_TOKEN`)
- Heartbeat pings from the scheduler tick

**What BetterStack cannot do:**
- Query Langfuse trace data (lives in Clickhouse, not Logtail)
- Show Langfuse cost/token breakdowns alongside operational logs
- Provide the unified Langfuse + logs view the issue describes

---

## 4. Recommendation

**Keep dashboard.ts + BetterStack. Skip Grafana for now.**

Reasoning:

1. **BetterStack already covers operational monitoring.** Logs, heartbeats, alerting, dashboards — all available via MCP tools. The gap is Langfuse trace data, but that's viewable at `localhost:3000`.

2. **Grafana adds a new service with marginal gain at local scale.** The docker-compose stack already has 6 services (postgres, clickhouse, redis, minio, worker, web). Adding Grafana (+ provisioning config + datasource YAML) for a single-user local deployment is infrastructure overhead that doesn't pay off until cloud deployment (Phase 2).

3. **dashboard.ts covers operational controls Grafana never would.** Task triggers, message bar, proactive toggle, transcript viewer — these are Edith-specific and would require a second UI regardless.

4. **BetterStack MCP is the right interface for ad-hoc observability.** Querying `telemetry_query` via Claude is faster than opening a Grafana UI. The MCP integration means Edith can answer "how many errors in the last hour?" directly.

5. **The real gap is Langfuse + BetterStack correlation.** If that need grows in Phase 2 (cloud, multi-instance), Grafana Cloud with a Langfuse OTEL export is the right move — not a self-hosted Grafana container added to the local stack.

**What to revisit in Phase 2:**
- Grafana Cloud (free tier) with OTEL export from Langfuse → avoids self-hosting
- Or: BetterStack as the sole observability layer if Langfuse is replaced with BetterStack APM

---

## 5. BetterStack MCP Sufficiency Check

| Need | BetterStack MCP | dashboard.ts | Langfuse UI |
|------|----------------|--------------|-------------|
| Live log tail | Yes (telemetry_query) | Yes (SSE stream) | No |
| Dispatch latency trends | Yes (metric query) | Today only | Yes |
| Error rate alerts | Yes (uptime monitors) | No | No |
| Heartbeat status | Yes (list_heartbeats) | Indirect | No |
| LLM cost/token breakdown | No | Today only | Yes |
| Trace waterfall view | No | No | Yes |
| Task triggers / controls | No | Yes | No |
| Transcript browser | No | Yes | No |

**Verdict:** BetterStack is sufficient for operational monitoring. Langfuse UI handles LLM observability. dashboard.ts handles operational controls. No gap that requires Grafana at current scale.
