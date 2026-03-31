# Encryption at Rest — Issue #94

## Context

Edith stores sensitive personal data locally (SQLite, file system) and in the cloud (Railway PostgreSQL). Screen captures, emails, calendar events, OAuth tokens, and Cognee memories all require protection at rest. This doc analyzes encryption options at each layer and recommends an implementation path.

## Threat Model

What we're protecting against:
1. **Device theft** — someone gets the Mac; local DB should be unreadable without auth
2. **Cloud database breach** — Railway/AWS data exposed; data should be unreadable without encryption keys
3. **Backup exposure** — backups should not contain plaintext sensitive data
4. **Rogue process access** — another app on the machine reading Edith's local files

What we're not protecting against (out of scope):
- Malware running as the same user (kernel-level threat, beyond app-layer encryption)
- Anthropic API interception (covered by TLS in transit, not at rest)

## Local Storage

### SQLite Options

**Option A: SQLCipher**
- Transparent AES-256 encryption of the entire SQLite database file
- Key derived from user's password or macOS Keychain secret
- Drop-in replacement for SQLite — no query changes needed
- Used by: Signal, WhatsApp, many financial apps
- Pros: battle-tested, transparent, encrypts all data including schema
- Cons: adds ~5-10% query overhead; requires native bindings (not pure JS); key management complexity

**Option B: Application-level field encryption**
- Sensitive fields encrypted before write, decrypted after read in application code
- Uses AES-256-GCM via Node.js `crypto` module
- Selective — only encrypt PII fields (email body, OAuth tokens, etc.)
- Pros: no native dependency, selective encryption, works with any DB driver
- Cons: schema and metadata remain plaintext; must be applied consistently across all write paths; easy to miss a field

**Option C: Rely on macOS FileVault**
- FileVault encrypts the entire disk; SQLite file is protected at rest when disk is locked
- Zero implementation work
- Cons: only protects against device theft; no protection if FileVault is off; no per-file or per-field granularity

**Recommendation: Option A (SQLCipher) for local storage.**

Rationale: Edith's local DB contains OAuth tokens and email content — high-value targets. SQLCipher provides comprehensive protection with minimal code change. The key lives in macOS Keychain (see Key Management below). FileVault alone is insufficient because it provides no protection when the device is unlocked.

If SQLCipher's native dependency is a blocker for the Tauri build pipeline, fall back to Option B with a clearly defined list of encrypted fields.

### Screen Capture Storage (Screenpipe)

Screenpipe manages its own local storage (`~/.screenpipe/`). Edith does not control this path.

Options:
1. Request Screenpipe team add encryption support (long-term)
2. Configure macOS Privacy settings to restrict access to `~/.screenpipe/` directory
3. Accept FileVault as the protection layer for screen captures

**Recommendation:** Accept FileVault for now. Note this in privacy policy ("screen captures are protected by macOS FileVault encryption"). Revisit if Screenpipe adds encryption support.

### OAuth Token Storage

OAuth tokens are the most critical local secret — they grant full access to Gmail and Google Calendar.

**Recommendation:** Store OAuth tokens exclusively in macOS Keychain via `keytar` or Tauri's `keyring` plugin. Never write tokens to SQLite or any flat file.

```
keyring service: "edith"
keyring account: "{userId}:{provider}"  // e.g., "abc123:google"
value: JSON.stringify({ access_token, refresh_token, expiry })
```

This means tokens are protected by the macOS Secure Enclave (if available) and require the user's macOS login to access.

## Cloud Database (Railway PostgreSQL)

### Options

**Option A: Railway's built-in encryption**
Railway encrypts data at rest at the disk level (AES-256 via AWS EBS encryption). No additional work required.
- Pros: zero implementation cost
- Cons: encryption key managed by Railway/AWS; protection is against physical disk theft, not a Railway employee or breach of the management plane

**Option B: PostgreSQL Transparent Data Encryption (TDE)**
Not natively supported by open-source PostgreSQL. Available in enterprise forks (EDB). Not applicable here.

**Option C: Application-level column encryption**
Encrypt sensitive columns before writing to PostgreSQL. Key stored outside the database (e.g., AWS KMS or a secrets manager).
- Encrypt: `email_body`, `cognee_memory_text`, `oauth_tokens`, `screen_capture_metadata`
- Do not encrypt: `user_id`, `created_at`, `event_type` (needed for indexing and queries)
- Implementation: use `pgcrypto` extension or application-layer AES-256-GCM before insert

**Recommendation: Option A (Railway disk encryption) for MVP, with Option C for high-sensitivity fields before GA.**

MVP rationale: Railway's disk encryption is sufficient for early development and beta. It protects against the most likely threat (infrastructure breach at the storage layer) and requires zero work.

Pre-GA: add application-level encryption for `oauth_tokens` and `cognee_memory_text` — the two highest-sensitivity fields. This provides defense in depth if Railway's management plane is compromised.

## Key Management

### Local (macOS)

1. At first run, generate a random 256-bit key for SQLCipher
2. Store the key in macOS Keychain: `keychain item: "edith-db-key"`
3. Retrieve from Keychain on each app start before opening the database
4. Never log or transmit the key

Recovery: if Keychain access is lost (e.g., user migrates machines), the local DB is unrecoverable. This is acceptable — user re-authenticates with cloud to restore from cloud state.

### Cloud (Railway)

For application-level column encryption:
1. Generate a per-environment AES-256 key
2. Store in Railway environment variables (encrypted secrets)
3. Rotate quarterly; implement key versioning so old records can be decrypted during rotation window

**Do not:** hardcode keys in source, store in `.env` files checked into git, or log key material.

## macOS Keychain Integration

Tauri provides `tauri-plugin-keyring` (v2) for cross-platform Keychain access. Usage:

```rust
// Store
keyring::Entry::new("edith", "db-key")?.set_password(&key_hex)?;

// Retrieve
let key = keyring::Entry::new("edith", "db-key")?.get_password()?;
```

For Node.js backend (edith.ts): use `keytar` package, which wraps macOS Security framework.

```typescript
import keytar from 'keytar';
const key = await keytar.getPassword('edith', 'db-key');
```

Both approaches require the app to be code-signed (see issue #77) — unsigned apps cannot reliably access Keychain items across reboots.

## Implementation Roadmap

### Phase 4 MVP (before beta)
- [ ] OAuth tokens: migrate to macOS Keychain via `keytar` — remove any file-based token storage
- [ ] Railway DB: confirm disk encryption is enabled (Railway default — verify in dashboard)
- [ ] Document encryption posture in privacy policy

### Phase 4 GA (before public launch)
- [ ] SQLite: integrate SQLCipher with Keychain-derived key
- [ ] Cloud DB: application-level encryption for `oauth_tokens` and `cognee_memory_text` columns
- [ ] Key rotation procedure documented and tested

### Post-launch
- [ ] Screenpipe: lobby for or contribute encryption support
- [ ] Hardware Security Key support for Enterprise tier
- [ ] Audit log for key access events

## Summary

| Layer | Recommendation | Priority |
|---|---|---|
| Local SQLite | SQLCipher + Keychain key | GA blocker |
| OAuth tokens (local) | macOS Keychain only | Beta blocker |
| Screen captures | FileVault (accept) | Low |
| Railway PostgreSQL | Disk encryption (built-in) | Done (verify) |
| Cloud sensitive columns | App-level AES-256-GCM | Pre-GA |
| Cloud key storage | Railway env secrets | Pre-GA |

## Open Questions

- Does the Tauri build pipeline support SQLCipher's native bindings on macOS arm64 + x86_64 universal binary?
- Should we support a "portable mode" (external drive) where the Keychain approach doesn't work? If so, we need a passphrase-based key derivation fallback.
- What happens to cloud-encrypted data if the encryption key is rotated and a user has unsynced local data?
