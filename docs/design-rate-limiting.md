# Per-User Rate Limiting and Cost Governance

**Issue:** #89
**Status:** Design

---

## Goals

1. Prevent a single user from exhausting shared LLM/API budgets.
2. Give each plan tier defined request and cost limits.
3. Degrade gracefully (queue or reject with a clear message) when limits are hit.
4. Provide operators visibility into per-user spend in real time.

---

## Plan Tiers

| Tier | LLM requests/day | Token budget/day | API calls/min | Cost cap/month |
|------|-----------------|-----------------|---------------|----------------|
| `free` | 50 | 100k tokens | 10 req/min | $2 |
| `pro` | 500 | 1M tokens | 60 req/min | $20 |
| `team` | 2,000 | 5M tokens | 120 req/min | $80 |
| `unlimited` | ∞ | ∞ | 300 req/min | operator-set |

Limits are soft-enforced: the system returns a rate-limit error rather than silently dropping requests.

---

## Rate Limiting Strategy

### Short-burst limiting (per-minute)

Implemented with a **sliding window counter** in Redis (or SQLite for single-server deployments):

```
Key: rate:<user_id>:min
TTL: 60 seconds
Value: request count
```

On each request:
1. `INCR rate:<user_id>:min`
2. If key is new, `EXPIRE rate:<user_id>:min 60`
3. If count > plan limit → reject with 429

### Daily budget limiting (tokens + cost)

```
Key: budget:<user_id>:date (e.g. budget:abc123:2026-03-31)
TTL: 86400 seconds (auto-expires at midnight UTC)
Fields: { tokens_used, cost_usd_cents, request_count }
```

After each LLM response, increment the counters with actual usage from the API response (`usage.input_tokens + usage.output_tokens`).

### Cost calculation

```
cost_usd = (input_tokens / 1_000_000) * input_price_per_mtok
         + (output_tokens / 1_000_000) * output_price_per_mtok
```

Model prices are loaded from a config file (updated when Anthropic changes pricing). Use conservative estimates for pre-call budget checks.

---

## Database Schema

```sql
-- Daily usage rollup (persisted for billing/analytics)
CREATE TABLE usage_daily (
  user_id       TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  date          TEXT NOT NULL,           -- 'YYYY-MM-DD' UTC
  llm_requests  INTEGER NOT NULL DEFAULT 0,
  input_tokens  INTEGER NOT NULL DEFAULT 0,
  output_tokens INTEGER NOT NULL DEFAULT 0,
  cost_usd_cents INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (user_id, date)
);
CREATE INDEX idx_usage_user ON usage_daily(user_id);

-- Monthly cost caps (override per user if needed)
CREATE TABLE user_limits (
  user_id           TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  monthly_cap_cents INTEGER,             -- NULL = use plan default
  daily_token_limit INTEGER,             -- NULL = use plan default
  req_per_min_limit INTEGER,             -- NULL = use plan default
  updated_at        INTEGER NOT NULL
);
```

---

## Middleware Implementation

```typescript
interface RateLimitResult {
  allowed: boolean;
  reason?: 'per_minute' | 'daily_tokens' | 'daily_requests' | 'monthly_cost';
  retryAfterMs?: number;
  remaining?: { requests: number; tokens: number };
}

async function checkRateLimit(userId: string): Promise<RateLimitResult> {
  const plan = await getPlan(userId);
  const limits = PLAN_LIMITS[plan];

  // 1. Per-minute check
  const minCount = await redis.incr(`rate:${userId}:min`);
  if (minCount === 1) await redis.expire(`rate:${userId}:min`, 60);
  if (minCount > limits.reqPerMin) {
    return { allowed: false, reason: 'per_minute', retryAfterMs: 60_000 };
  }

  // 2. Daily request count
  const today = utcDateString();
  const daily = await getOrCreateDailyUsage(userId, today);
  if (daily.llm_requests >= limits.requestsPerDay) {
    return { allowed: false, reason: 'daily_requests', retryAfterMs: msUntilMidnightUTC() };
  }

  // 3. Daily token budget (pre-check with estimate)
  if (daily.input_tokens + daily.output_tokens >= limits.tokensPerDay) {
    return { allowed: false, reason: 'daily_tokens', retryAfterMs: msUntilMidnightUTC() };
  }

  return { allowed: true };
}
```

The middleware runs before every LLM invocation in the agent loop. If not allowed, the WS message handler returns a `{ type: 'error', code: 'RATE_LIMITED', message: '...' }` response to the device.

---

## Post-Call Accounting

After every LLM API response, record actual usage:

```typescript
async function recordUsage(userId: string, usage: {
  inputTokens: number;
  outputTokens: number;
  modelId: string;
}): Promise<void> {
  const costCents = calcCostCents(usage.inputTokens, usage.outputTokens, usage.modelId);
  const today = utcDateString();

  // Upsert daily rollup
  await db.run(`
    INSERT INTO usage_daily (user_id, date, llm_requests, input_tokens, output_tokens, cost_usd_cents)
    VALUES (?, ?, 1, ?, ?, ?)
    ON CONFLICT (user_id, date) DO UPDATE SET
      llm_requests  = llm_requests + 1,
      input_tokens  = input_tokens + excluded.input_tokens,
      output_tokens = output_tokens + excluded.output_tokens,
      cost_usd_cents = cost_usd_cents + excluded.cost_usd_cents
  `, [userId, today, usage.inputTokens, usage.outputTokens, costCents]);
}
```

---

## Monthly Cost Cap

A background job (or triggered check) computes the month-to-date spend per user:

```sql
SELECT SUM(cost_usd_cents) FROM usage_daily
WHERE user_id = ? AND date >= strftime('%Y-%m-01', 'now');
```

If this exceeds the plan's `monthly_cap_cents`, the user is soft-suspended for the rest of the month. They receive a Telegram/desktop notification explaining the cap and how to upgrade.

---

## Operator Dashboard

Expose a `/admin/usage` endpoint (protected by admin token) that returns:

```json
{
  "topUsersBySpend": [
    { "userId": "...", "email": "...", "monthCents": 412, "plan": "pro" }
  ],
  "totalMonthlyCents": 1840,
  "dailyBreakdown": { "2026-03-31": 142, "2026-03-30": 188 }
}
```

This feeds into any Grafana dashboard (see `eval-grafana-dashboard.md`).

---

## Redis vs SQLite Fallback

- **Redis preferred** for per-minute counters: atomic `INCR` + `EXPIRE` with sub-millisecond latency.
- **SQLite fallback** for single-server deployments: use `BEGIN IMMEDIATE` transactions to safely increment counters; accept slightly higher latency (~2ms vs ~0.1ms).
- Daily rollups always write to SQLite/Postgres (durable, queryable).
