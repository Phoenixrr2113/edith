# Edith v3 — Debug Report
Generated: 2026-03-28 ~14:00 PM

---

## Bug 1: Kuzu DB Lock — CRITICAL (Blocks all Cognee/memory operations)

**Error:**
```
2026-03-28T13:52:44 [ERROR] Failed to initialize Kuzu database: IO exception: Could not set lock on file :
/Users/randywilson/Desktop/edith-v3/cognee-repo/cognee-mcp/.venv/lib/python3.12/site-packages/cognee/.cognee_system/databases/f0076d51-e0b7-4220-bac0-3b64ea764739/63626142-22d8-505e-94e0-8dd2e3b21643.pkl
See the docs: https://docs.kuzudb.com/concurrency for more information.
```

**Root cause:** Multiple Cognee MCP server instances (spawned by parallel agent dispatches) attempting to open the same Kuzu database file simultaneously. Kuzu uses file-level locking and only supports one writer at a time.

**Impact:** 100% of Cognee search/write operations fail. Edith has no persistent memory.

**Current `.env` config:**
```
GRAPH_DATABASE_PROVIDER=kuzu
VECTOR_DB_PROVIDER=lancedb
DB_PROVIDER=sqlite
LLM_PROVIDER=custom
LLM_MODEL=openrouter/qwen/qwen3-235b-a22b-2507
EMBEDDING_PROVIDER=fastembed
EMBEDDING_MODEL=BAAI/bge-base-en-v1.5
# ENABLE_BACKEND_ACCESS_CONTROL not set (defaults to True in v0.5.0+)
```

**Possible fixes:**
1. Add `ENABLE_BACKEND_ACCESS_CONTROL=false` to `.env` (per Cognee warning in logs)
2. Run Cognee as a single persistent server process instead of spawning per-request
3. Switch to `kuzu-remote` (HTTP-based, supports concurrency)
4. Switch graph backend to `neo4j` (supports concurrent access)

---

## Bug 2: Circuit Breaker Cascade — HIGH (Disrupts scheduling reliability)

**Error pattern from `~/.edith/events.jsonl`:**
```
08:08 — dispatch_skipped: proactive-check (circuit_breaker)
08:30 — dispatch_timeout: check-reminders (timeoutMs: 300000)
08:30 — circuit_breaker: failures=7, cooldownMs=600000
08:58 — dispatch_timeout: check-reminders (timeout at 5min)
08:58 — circuit_breaker: failures=8
09:30 — dispatch_timeout: check-reminders (timeout at 5min)
09:30 — circuit_breaker: failures=9
10:09 — dispatch_timeout: check-reminders (timeout at 5min)
10:09 — circuit_breaker: failures=10
10:37 — dispatch_timeout: check-reminders (timeout at 5min)
10:37 — circuit_breaker: failures=11, cooldownMs=600000
```

**Root cause:** `check-reminders` is repeatedly hitting the 300s (5min) timeout. Each timeout counts as a circuit breaker failure. With 11 failures, the circuit breaker is tripping repeatedly, blocking subsequent tasks.

**Impact:**
- `proactive-check` skipped entirely when circuit is open
- Each timeout = 5 minutes of a hung Claude Code session = wasted cost
- Today's projected cost ~$270/mo from these runaway dispatches alone

**Investigation needed:**
- Why is `check-reminders` hanging for 5+ minutes? Is it hitting a slow tool? Waiting on Cognee (which is broken)?
- What is the circuit breaker threshold and reset logic in `edith.ts`?
- Are timeouts cascading because they overlap with the next scheduled run?

---

## Bug 3: ENABLE_BACKEND_ACCESS_CONTROL Not Set — MEDIUM

**Warning (every Cognee startup):**
```
[WARNING] From version 0.5.0 onwards, Cognee will run with multi-user access control mode set to on by default.
Data created before multi-user access control mode was turned on won't be accessible by default.
To disable: set ENABLE_BACKEND_ACCESS_CONTROL to false
```

**Fix:** Add to `cognee-repo/cognee-mcp/.env`:
```
ENABLE_BACKEND_ACCESS_CONTROL=false
```

---

## Bug 4: Missing Optional Dependencies — LOW

```
[DEBUG] Failed to import protego, make sure to install using pip install protego>=0.1
[DEBUG] Failed to import playwright, make sure to install using pip install playwright>=1.9.0
```

These are optional web-scraping dependencies. Not blocking anything currently, but worth installing if web research via Cognee is needed.

---

## Priority Fix Order

1. **Fix Kuzu lock** — without memory, Edith can't learn or maintain context across sessions
2. **Diagnose check-reminders timeout** — find what's hanging and why, reduce or eliminate timeouts
3. **Set ENABLE_BACKEND_ACCESS_CONTROL=false** — easy one-liner fix
4. **Install protego + playwright** — low priority, only needed for web scraping

---

## Relevant Files

- Cognee MCP log: `/Users/randywilson/Desktop/edith-v3/cognee-repo/cognee-mcp/.venv/lib/python3.12/site-packages/logs/`
- Cognee env: `/Users/randywilson/Desktop/edith-v3/cognee-repo/cognee-mcp/.env`
- Edith events: `/Users/randywilson/.edith/events.jsonl`
- Edith dispatcher: `/Users/randywilson/Desktop/edith-v3/edith.ts`
- Kuzu DB path: `/Users/randywilson/Desktop/edith-v3/cognee-repo/cognee-mcp/.venv/lib/python3.12/site-packages/cognee/.cognee_system/databases/`
