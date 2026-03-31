# GDPR Compliance Analysis — Issue #95

## Context

Edith processes highly sensitive personal data: screen captures, audio, emails, and calendar events. If any user is in the EU/EEA, GDPR applies regardless of where Edith is incorporated. This doc maps Edith's data to GDPR requirements and identifies required controls.

## Data Inventory

| Data Type | Sensitivity | Storage Location | Retention | Legal Basis |
|---|---|---|---|---|
| Screen captures (images) | Very High | Local (Screenpipe) + optionally cloud | Until deleted by user | Consent |
| Audio transcripts | Very High | Local (Screenpipe) + optionally cloud | Until deleted by user | Consent |
| Email content | High | Local cache + cloud (Railway DB) | Configurable, default 90 days | Consent |
| Calendar events | Medium | Local cache + cloud (Railway DB) | Configurable, default 90 days | Consent |
| Cognee memory (facts, preferences) | High | Local + cloud (PostgreSQL) | Indefinite until deleted | Consent |
| Telegram message history | High | Not stored (stateless) | None | N/A |
| OAuth tokens (Google, etc.) | Critical | Local keychain + cloud DB (encrypted) | Until revocation | Contract |
| Usage/telemetry (action logs) | Low | Cloud (Railway DB) | 90 days rolling | Legitimate interest |

## GDPR Requirements Mapped to Edith

### Article 5 — Data minimization
- Screen captures should only be retained if Screenpipe's awareness feature is active
- Email bodies should not be stored in full — store summaries and metadata by default; full content only if user opts in
- Action: implement configurable retention at storage layer, not just display layer

### Article 6 — Lawful basis
- All processing of personal data (email, screen, audio) must be based on **explicit consent**, not legitimate interest
- OAuth token use is covered under **contract** (user requested the integration)
- Telemetry/usage logs can use **legitimate interest** (service operation) with opt-out

### Article 13/14 — Transparency
- Privacy policy must disclose: what is collected, why, who can access it, how long it's kept, user rights
- Must be presented at onboarding before any data collection begins
- Action: privacy policy required before GA; consent screen at first run

### Article 17 — Right to erasure ("right to be deleted")
Required: user must be able to delete all their data. This means:
1. Cloud database: delete all rows for `user_id` across all tables
2. Cognee memory: purge all entries for user
3. OAuth tokens: revoke and delete
4. Screenpipe local data: provide instructions (cannot delete remotely; user must purge locally)
5. Backups: data must be excluded from or purged from backups within 30 days

Action: build a `DELETE /account` endpoint that cascades across all cloud data. Document the local data deletion process in the app.

### Article 20 — Right to data portability
Users must be able to export their data in a machine-readable format (JSON/CSV). This includes:
- Cognee memories
- Email summaries
- Calendar event history
- Action logs

Action: build a `GET /account/export` endpoint that returns a ZIP with structured JSON.

### Article 25 — Privacy by design
- Default: minimum data collection. Screen awareness OFF by default.
- Encryption at rest for all cloud-stored personal data (see `eval-encryption-at-rest.md`)
- Access control: each user can only access their own data; no admin backdoors to plaintext personal data
- Data pseudonymization where feasible (e.g., use `user_id` UUIDs, never email addresses as keys)

### Article 28 — Data processing agreements (DPAs)
Edith uses third-party processors. DPAs required with:

| Processor | Data Shared | DPA Available? |
|---|---|---|
| Anthropic (Claude API) | Prompts containing email/calendar content | Yes — Anthropic offers DPA |
| Railway | All cloud DB data | Yes — Railway offers DPA |
| Google (OAuth) | OAuth tokens, API access to Gmail/Calendar | Yes — Google Cloud DPA |
| Screenpipe | Screen/audio (local only) | N/A (local processing) |

Action: execute DPAs with Anthropic and Railway before GA. Google DPA is covered by Google Cloud ToS.

### Article 30 — Records of processing activities
Maintain an internal record of:
- What data is processed
- Purpose of processing
- Who has access
- Technical/organizational security measures

Action: this document serves as the initial record; update it when data flows change.

## Consent Flow Design

### First-run consent screen
1. Plain-language explanation of what data Edith accesses and why
2. Granular toggles: Email access / Calendar access / Screen awareness / Audio transcription
3. Link to full privacy policy
4. "I agree" button — no dark patterns, no pre-checked boxes for optional features
5. Consent timestamp stored with user record

### Re-consent triggers
- When adding a new integration (e.g., enabling Screenpipe for the first time)
- When privacy policy materially changes
- When a new data type is collected

### Consent withdrawal
- Settings page: toggle any integration off → stop collection immediately, optionally purge historical data
- Account deletion: one-click full erasure

## Data Residency

GDPR doesn't strictly require EU data residency, but it prohibits transfer to countries without "adequate protection" without safeguards.

- Railway: deploys to AWS us-east-1 by default. EU users need EU region (Railway supports `europe-west4`).
- Anthropic API: data processed in the US. Covered by Anthropic's DPA (standard contractual clauses).

**Recommendation:** default to US region for performance; offer EU region as a setting for EU-based users. Add region selection to onboarding.

## Retention Defaults

| Data Type | Default Retention | User Control |
|---|---|---|
| Email summaries | 90 days | Configurable 30/60/90/365/unlimited |
| Calendar events | 90 days | Configurable |
| Cognee memories | Indefinite | Delete individual or all |
| Screen captures | Not stored in cloud | N/A |
| Action logs | 90 days rolling | No (ops requirement) |
| OAuth tokens | Until revoked | Revoke anytime |

## Implementation Priorities

1. **Consent screen at first run** — blocker for EU distribution
2. **Account deletion endpoint** — blocker for GDPR compliance
3. **Data export endpoint** — required for portability (Article 20)
4. **DPAs with Anthropic + Railway** — required before processing EU user data
5. **EU region option** — needed for strict compliance; lower priority for MVP
6. **Privacy policy** — required before GA (can be simple at MVP stage)

## Open Questions

- Are any beta users currently in the EU? If yes, consent screen and deletion endpoint are immediately required.
- Should Cognee memories be encrypted at the application layer or rely on database-level encryption? (See `eval-encryption-at-rest.md`)
- Does Screenpipe's local storage constitute "processing" under GDPR? Likely yes if Edith initiates the capture — needs legal review.
