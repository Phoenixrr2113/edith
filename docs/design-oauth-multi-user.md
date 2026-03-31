# Per-User OAuth Token Management

**Issue:** #88
**Status:** Design

---

## Problem

Google OAuth tokens (access + refresh) are currently stored as environment variables, shared across all agent invocations. In a multi-user system each user authenticates independently with Google. Tokens must be stored per-user, refreshed transparently, and scoped to the user's session.

---

## OAuth Flow

### Initial authorization (web)

```
User → Browser → /auth/google/start?user_id=<uid>
  → Google consent screen
  → Google → /auth/google/callback?code=<code>&state=<uid>
  → Exchange code for access_token + refresh_token
  → Store tokens encrypted in DB
  → Redirect to success page
```

The `state` parameter carries the `user_id` so the callback knows which user to associate the tokens with.

### Token refresh (background)

Access tokens expire in ~1 hour. The token manager refreshes automatically before expiry:

```
On API call:
  load tokens for user_id
  if access_token expires within 5 min:
    POST https://oauth2.googleapis.com/token
      grant_type=refresh_token
      refresh_token=<stored>
      client_id / client_secret
    store new access_token + expiry
  use access_token
```

---

## Database Schema

```sql
-- Per-user OAuth tokens (one row per user per provider)
CREATE TABLE oauth_tokens (
  id            TEXT PRIMARY KEY,        -- UUID
  user_id       TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  provider      TEXT NOT NULL,           -- 'google'
  access_token  TEXT NOT NULL,           -- AES-256-GCM encrypted
  refresh_token TEXT,                    -- AES-256-GCM encrypted (nullable: some providers omit)
  expires_at    INTEGER NOT NULL,        -- unix ms
  scopes        TEXT NOT NULL,           -- space-separated OAuth scopes
  email         TEXT,                    -- Google account email for display
  updated_at    INTEGER NOT NULL
);
CREATE UNIQUE INDEX idx_oauth_user_provider ON oauth_tokens(user_id, provider);
```

### Encryption

Tokens are encrypted at rest using AES-256-GCM with a server-side key (`OAUTH_ENCRYPTION_KEY` env var, 32 bytes, base64-encoded). The nonce is stored as a prefix in the encrypted column value: `<nonce_b64>:<ciphertext_b64>`.

Never store plaintext tokens in the database.

---

## Token Manager API

```typescript
interface OAuthTokenManager {
  // Get a valid access token for a user (refreshes if needed)
  getAccessToken(userId: string, provider: 'google'): Promise<string>;

  // Store tokens after initial OAuth callback
  storeTokens(userId: string, provider: 'google', tokens: {
    accessToken: string;
    refreshToken?: string;
    expiresAt: number;
    scopes: string[];
    email?: string;
  }): Promise<void>;

  // Check if a user has connected a provider
  isConnected(userId: string, provider: 'google'): Promise<boolean>;

  // Revoke and delete tokens (user disconnect)
  revokeTokens(userId: string, provider: 'google'): Promise<void>;
}
```

### Usage in tools

```typescript
// In gmail tool handler:
const accessToken = await tokenManager.getAccessToken(userId, 'google');
const gmail = google.gmail({ version: 'v1', auth: accessToken });
```

The `userId` comes from the authenticated WebSocket session (device → user lookup).

---

## Google OAuth Scopes

| Feature | Scope |
|---------|-------|
| Gmail read | `https://www.googleapis.com/auth/gmail.readonly` |
| Gmail send | `https://www.googleapis.com/auth/gmail.send` |
| Gmail modify | `https://www.googleapis.com/auth/gmail.modify` |
| Calendar read | `https://www.googleapis.com/auth/calendar.readonly` |
| Calendar write | `https://www.googleapis.com/auth/calendar` |
| Contacts read | `https://www.googleapis.com/auth/contacts.readonly` |

Request only the scopes the user's plan includes. Store granted scopes in `oauth_tokens.scopes` and check before tool invocations.

---

## Security Considerations

- **Encryption key rotation:** Implement envelope encryption — wrap the data key with a master key. Rotation replaces only the data key without re-encrypting all rows.
- **Refresh token loss:** If a user revokes access via Google's security page, the next refresh will fail with `invalid_grant`. Handle gracefully: mark token as disconnected, notify user to re-authorize.
- **Token leakage:** Never log, transmit, or include tokens in error messages. Scrub from any telemetry.
- **PKCE:** Use PKCE (code_challenge / code_verifier) on the authorization request to prevent authorization code interception.
- **State parameter:** Sign the `state` parameter with an HMAC to prevent CSRF on the callback.

---

## Multi-Account Support

Some users may want multiple Google accounts (personal + work). Support this by making the unique index `(user_id, provider, email)` instead of `(user_id, provider)`. The tool caller specifies which account to use, or the user sets a default.
