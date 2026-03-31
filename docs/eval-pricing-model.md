# Pricing Model Analysis — Issue #96

## Context

Edith is a desktop AI assistant that integrates screen awareness, email, calendar, memory, and proactive notifications. Pricing must account for real LLM API costs while remaining competitive with productivity tools users already pay for.

## Competitive Landscape

| Product | Price | Model | Notes |
|---|---|---|---|
| Rewind AI | $19/mo | Subscription | Local-first, no cloud LLM cost, screen recording only |
| Granola | $10/mo | Subscription | Meeting notes, narrow scope |
| Notion AI | $10/mo add-on | Add-on | Embedded in existing tool |
| Copilot (Microsoft) | $30/mo | Subscription | Enterprise, deep OS integration |
| Superhuman | $30/mo | Subscription | Email only, premium positioning |
| Reclaim AI | $8–$20/mo | Tiered | Calendar automation |

### Key observations

- Productivity tools cluster at $10–$30/mo
- Rewind can charge $19 because it has near-zero inference cost (local processing)
- Edith's scope (screen + email + calendar + memory + LLM) is broader than any single competitor
- Users already pay $10–$30/mo for tools Edith could replace or consolidate

## Freemium vs Subscription

**Freemium** — free tier with limits, paid tier for full access.

- Pros: lowers signup friction, viral via free users
- Cons: LLM costs make free tier expensive to operate; free users rarely convert without a clear paywall hit

**Subscription-only** — no free tier, trial period only.

- Pros: predictable revenue, no subsidizing non-payers
- Cons: higher signup friction, harder to grow via word-of-mouth

**Recommendation: freemium with hard usage caps**, not feature locks. Free tier should feel genuinely useful (daily brief, email triage) but hit a wall on volume (e.g., 50 AI actions/month). Paid tier removes the cap.

## API Cost Pass-Through

Edith's LLM costs are variable per user (see `eval-llm-cost-strategy.md` for full breakdown). Two models:

1. **Absorb costs into subscription** — simpler UX, but margin risk if heavy users dominate
2. **Usage-based add-on above baseline** — honest but adds billing complexity

Recommendation: absorb costs at the Standard tier (designed around ~$2–3/user/mo LLM budget). Add a "Power" tier for users who want screen awareness running continuously or high email volume.

## Recommended Pricing Tiers

### Free — $0/mo
- 50 AI actions/month (morning brief, ad-hoc questions)
- Email triage: 10 emails/day
- No screen awareness
- No Cognee memory persistence beyond 30 days
- No calendar integrations (read-only)
- Purpose: acquisition and word-of-mouth

### Standard — $12/mo
- Unlimited morning/midday/evening briefs
- Email triage: unlimited
- Cognee memory: full persistence
- Calendar integration: full read/write
- Screen awareness: off by default, manual trigger only
- LLM budget: ~$3/mo absorbed
- Target: individual knowledge workers

### Pro — $24/mo
- Everything in Standard
- Screen awareness: always-on (configurable)
- Audio transcription + meeting notes
- Multi-account email/calendar
- Priority processing
- LLM budget: ~$8/mo absorbed
- Target: power users, founders, PMs

### Team — $18/user/mo (min 3 seats)
- Everything in Pro
- Shared Cognee knowledge base (team memory)
- Admin dashboard, usage reporting
- SSO (SAML/Google Workspace)
- Target: small teams

## Annual Discount

Offer 2 months free on annual plans (16% discount). Improves cash flow and reduces churn.

## Trial Strategy

14-day full Pro trial, no credit card required. Convert to Free or prompt upgrade at day 12 with usage summary ("You used Edith X times this week — here's what you'd lose on Free").

## Revenue Model Assumptions

At 1,000 paid users (conservative early milestone):
- 60% Standard ($12) = 600 × $12 = $7,200/mo
- 30% Pro ($24) = 300 × $24 = $7,200/mo
- 10% Team ($18 avg/user) = 100 × $18 = $1,800/mo
- **Total MRR: ~$16,200**

LLM cost at those volumes (see eval-llm-cost-strategy.md): ~$3,500/mo
Gross margin: ~78%

## Open Questions

- Will users pay $24 without Windows/Linux support? Likely yes for early adopters, but limits TAM.
- Should screen awareness be gated by tier or by user preference? Gating by tier creates upgrade pressure but may feel punitive on privacy-sensitive feature.
- B2B vs B2C first? B2C is faster to validate; B2B (Team tier) has better LTV.
