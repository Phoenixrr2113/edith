# LLM Cost Strategy — Issue #98

## Context

At scale, LLM inference is Edith's largest variable cost. Without a routing strategy, every call defaults to a capable-but-expensive model. This doc analyzes model routing, caching, prompt compression, and batch processing to target a sustainable cost per user per month.

## Model Tiers (Anthropic, as of early 2026)

| Model | Input (per 1M tokens) | Output (per 1M tokens) | Best for |
|---|---|---|---|
| Claude Haiku 3.5 | $0.80 | $4.00 | Classification, routing, short summaries |
| Claude Sonnet 4 | $3.00 | $15.00 | Most tasks, good reasoning |
| Claude Opus 4 | $15.00 | $75.00 | Complex reasoning, long-context synthesis |

Note: Prompt caching reduces input costs by ~90% for cached prefixes (min 1,024 tokens).

## Task Classification and Model Routing

Every Edith action should be routed to the cheapest model that can reliably complete it.

### Haiku tasks (cheap, fast)
- Reminder classification ("is this time-sensitive?")
- Email subject-line triage (spam vs actionable)
- Intent detection from short Telegram messages
- Meeting title → context lookup
- Short factual lookups from Cognee
- Scheduled task status checks

**Estimated tokens:** 200–600 input, 100–300 output per call
**Estimated cost:** $0.0002–$0.001 per call

### Sonnet tasks (balanced)
- Morning/midday/evening briefs
- Email drafting and triage
- Meeting prep summaries
- Cognee search + synthesis
- Most ad-hoc user questions
- Skill execution (email-triage, etc.)

**Estimated tokens:** 2,000–8,000 input, 500–2,000 output per call
**Estimated cost:** $0.01–$0.05 per call

### Opus tasks (reserved for complexity)
- Multi-document synthesis (legal, financial)
- Long-running research tasks (>10k token context)
- Ambiguous or high-stakes decisions needing best judgment
- Explicit user request for "best answer"

**Estimated tokens:** 10,000–50,000 input, 2,000–5,000 output per call
**Estimated cost:** $0.30–$1.50 per call

**Routing rule:** Default to Haiku for classification, Sonnet for execution, Opus only when explicitly needed or when Sonnet fails a confidence threshold.

## Prompt Caching Strategy

Anthropic's prompt caching saves ~90% on repeated input tokens.

### What to cache
- System prompt (loaded every session) — ~3,000 tokens, cache immediately
- User context block (Cognee summary, preferences) — ~2,000 tokens, cache at session start
- Skill definitions loaded per-session — ~5,000 tokens, cache on first load
- Long email threads being triaged — cache the thread, vary only the instruction

### Expected savings
Without caching: system prompt + context = ~5,000 tokens × $3.00/1M = $0.015 per call
With caching: same tokens at ~$0.30/1M = $0.0015 per call
**~10x reduction on repeated-context portion of every call**

### Implementation
Mark cache-eligible content with `cache_control: {"type": "ephemeral"}` in the messages array. Cache TTL is 5 minutes on Anthropic's side — long enough for a skill session, short enough to refresh stale context.

## Prompt Compression

Long prompts cost money. Strategies to reduce token count:

1. **Summarize email threads before passing to LLM** — strip quoted replies, signatures, legal footers. Average thread: 2,000 tokens → 400 tokens after compression.
2. **Truncate Cognee results** — return top 5 most relevant memories, not all matches.
3. **Calendar events** — pass only title, time, attendees. Strip description unless explicitly requested.
4. **Screen captures** — pass compressed image at 50% resolution for awareness tasks; full resolution only for OCR/extraction tasks.
5. **Skill routing prompt** — keep the routing classifier prompt under 500 tokens (currently uncapped).

Estimated savings from compression: 30–50% reduction in Sonnet input tokens.

## Batch Processing

Non-urgent tasks can be queued and processed in bulk:

- **Email triage** — batch 20 emails in a single Haiku call with structured output instead of one call per email. Cost: ~$0.005 vs $0.10.
- **Cognee memory updates** — queue during session, write in one batch at end.
- **Morning brief** — one Sonnet call assembling all context vs multiple calls. Already done this way; ensure it stays consolidated.

Batch processing is not appropriate for: real-time Telegram replies, reminders firing, urgent email detection.

## Estimated Cost Per User Per Month

### Free tier user (light usage)
- 20 AI actions/month (mostly Haiku)
- 2 briefs/week (Sonnet, cached)
- Total: ~$0.15–$0.30/mo LLM cost

### Standard tier user (moderate usage)
- 3 briefs/day (Sonnet, cached) = ~$0.09/day
- Email triage 2x/day (Haiku batch) = ~$0.01/day
- 5 ad-hoc queries/day (Sonnet) = ~$0.15/day
- Cognee lookups (Haiku) = ~$0.01/day
- **Total: ~$0.26/day × 22 workdays = ~$5.70/mo**
- With caching + compression applied: **~$2.50–$3.00/mo**

### Pro tier user (heavy usage)
- Screen awareness: 50 captures/day classified (Haiku) = ~$0.02/day
- Screen awareness: 5 notable events → Sonnet action = ~$0.10/day
- Everything from Standard (3×) = ~$0.78/day
- **Total: ~$0.90/day × 22 workdays = ~$19.80/mo**
- With caching + compression: **~$7.00–$9.00/mo**

### Targets vs pricing
| Tier | Price | LLM Cost | Gross Margin |
|---|---|---|---|
| Free | $0 | ~$0.25 | -$0.25 (acquisition cost) |
| Standard | $12 | ~$2.75 | ~77% |
| Pro | $24 | ~$8.00 | ~67% |

## Cost Governance

- Per-user daily LLM spend cap: $0.50 Standard, $1.50 Pro (hard cutoff, graceful degradation to Haiku-only)
- Alert at 80% of monthly budget per user
- Log model used + token counts per action for cost attribution
- Weekly cost report: p50/p95/p99 cost per user by tier

## Open Questions

- Should Opus ever be available to Standard users, or only Pro+?
- Is $0.25/mo free tier LLM cost acceptable as an acquisition cost, or should the free tier be more restricted?
- Vision model costs (screen awareness) need separate benchmarking once Screenpipe integration is stable.
