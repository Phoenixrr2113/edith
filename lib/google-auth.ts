/**
 * Google OAuth2 token management — lib/google-auth.ts (INFRA-OAUTH-054)
 *
 * Tokens are stored in SQLite (oauth_tokens table) rather than env vars.
 * On getAccessToken(), the DB is checked first; expired tokens are refreshed
 * automatically (within 5 minutes of expiry) and the DB is updated.
 *
 * Initial token acquisition:
 *   1. Set GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET in .env
 *   2. Run `bun run setup:oauth` (or call getAuthUrl / exchangeCode below)
 *      to complete the OAuth consent flow and persist tokens in SQLite.
 *
 * Env vars required only for first-time setup:
 *   GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET
 * Optional:
 *   GOOGLE_REDIRECT_URI (default: urn:ietf:wg:oauth:2.0:oob)
 *   GOOGLE_ACCESS_TOKEN (static token fallback, skips DB — useful in tests)
 */

import { openDatabase } from "./db";

// ── Constants ─────────────────────────────────────────────────────────────────

const TOKEN_URL = "https://oauth2.googleapis.com/token";
const AUTH_URL = "https://accounts.google.com/o/oauth2/v2/auth";
/** Refresh when fewer than 5 minutes remain on the access token. */
const EXPIRY_BUFFER_MS = 5 * 60 * 1000;
const PROVIDER = "google";

// ── Schema bootstrap ──────────────────────────────────────────────────────────

/**
 * Ensure the oauth_tokens table exists (idempotent).
 * Called lazily so no explicit migration step is needed.
 */
function ensureSchema(): void {
	const db = openDatabase();
	db.exec(`
    CREATE TABLE IF NOT EXISTS oauth_tokens (
      provider      TEXT PRIMARY KEY,
      access_token  TEXT NOT NULL,
      refresh_token TEXT NOT NULL,
      expires_at    TEXT NOT NULL
    );
  `);
}

// ── Types ─────────────────────────────────────────────────────────────────────

interface TokenRow {
	provider: string;
	access_token: string;
	refresh_token: string;
	expires_at: string; // ISO-8601
}

// ── DB helpers ────────────────────────────────────────────────────────────────

/** Load stored tokens for the given provider, or null if not found. */
export function loadTokens(provider = PROVIDER): TokenRow | null {
	ensureSchema();
	const db = openDatabase();
	const row = db
		.query<TokenRow, [string]>(
			"SELECT provider, access_token, refresh_token, expires_at FROM oauth_tokens WHERE provider = ?"
		)
		.get(provider);
	return row ?? null;
}

/** Persist (or update) tokens in SQLite. */
export function storeTokens(
	provider: string,
	tokens: { access_token: string; refresh_token: string; expires_at: string }
): void {
	ensureSchema();
	const db = openDatabase();
	db.run(
		`INSERT OR REPLACE INTO oauth_tokens (provider, access_token, refresh_token, expires_at)
     VALUES (?, ?, ?, ?)`,
		[provider, tokens.access_token, tokens.refresh_token, tokens.expires_at]
	);
}

// ── In-memory cache ───────────────────────────────────────────────────────────

interface TokenCache {
	accessToken: string;
	expiresAt: number; // unix ms
}

let _cache: TokenCache | null = null;

// ── Core API ──────────────────────────────────────────────────────────────────

/**
 * Returns a valid Google OAuth2 access token.
 *
 * Priority:
 *   1. In-memory cache (valid and not expiring soon)
 *   2. SQLite DB (loads tokens, refreshes if needed, updates DB)
 *   3. GOOGLE_ACCESS_TOKEN env var (static fallback — no DB write)
 *
 * Throws if no tokens are available. Run the OAuth consent flow first.
 */
export async function getAccessToken(): Promise<string> {
	const now = Date.now();

	// 1. Memory cache
	if (_cache && _cache.expiresAt - EXPIRY_BUFFER_MS > now) {
		return _cache.accessToken;
	}

	// 2. Static env-var fallback (tests / pre-setup)
	const staticToken = process.env.GOOGLE_ACCESS_TOKEN ?? "";
	if (staticToken && !process.env.GOOGLE_CLIENT_ID) {
		_cache = { accessToken: staticToken, expiresAt: now + 55 * 60 * 1000 };
		return staticToken;
	}

	// 3. Load from SQLite
	const row = loadTokens(PROVIDER);
	if (!row) {
		throw new Error(
			"No Google OAuth tokens in DB. Run the OAuth consent flow first:\n" +
				"  bun run setup:oauth  (or see setup.sh)"
		);
	}

	const expiresAtMs = new Date(row.expires_at).getTime();
	const needsRefresh = now + EXPIRY_BUFFER_MS >= expiresAtMs;

	if (!needsRefresh) {
		_cache = { accessToken: row.access_token, expiresAt: expiresAtMs };
		return row.access_token;
	}

	// 4. Refresh via refresh_token
	const clientId = process.env.GOOGLE_CLIENT_ID ?? "";
	const clientSecret = process.env.GOOGLE_CLIENT_SECRET ?? "";

	if (!clientId || !clientSecret) {
		throw new Error(
			"GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET must be set in .env to refresh the token."
		);
	}

	const params = new URLSearchParams({
		client_id: clientId,
		client_secret: clientSecret,
		refresh_token: row.refresh_token,
		grant_type: "refresh_token",
	});

	const res = await fetch(TOKEN_URL, {
		method: "POST",
		headers: { "Content-Type": "application/x-www-form-urlencoded" },
		body: params.toString(),
	});

	if (!res.ok) {
		const body = await res.text();
		throw new Error(`Google token refresh failed (${res.status}): ${body}`);
	}

	const json = (await res.json()) as {
		access_token: string;
		expires_in: number;
		refresh_token?: string;
		error?: string;
	};

	if (json.error || !json.access_token) {
		throw new Error(`Google token refresh error: ${json.error ?? "no access_token in response"}`);
	}

	const newExpiresAt = new Date(now + json.expires_in * 1000).toISOString();

	// Persist refreshed tokens — use new refresh_token if Google rotated it
	storeTokens(PROVIDER, {
		access_token: json.access_token,
		refresh_token: json.refresh_token ?? row.refresh_token,
		expires_at: newExpiresAt,
	});

	_cache = { accessToken: json.access_token, expiresAt: now + json.expires_in * 1000 };
	return json.access_token;
}

/** Clear the in-memory token cache (useful in tests or after auth errors). */
export function clearTokenCache(): void {
	_cache = null;
}

// ── Initial setup helpers ─────────────────────────────────────────────────────

/** Default OAuth scopes for Edith (Docs + Drive + Gmail + Calendar). */
export const DEFAULT_SCOPES = [
	"https://www.googleapis.com/auth/documents",
	"https://www.googleapis.com/auth/drive",
	"https://www.googleapis.com/auth/gmail.modify",
	"https://www.googleapis.com/auth/calendar",
];

/**
 * Generate an OAuth2 authorization URL for the consent flow.
 * Open this URL in a browser, approve access, then call exchangeCode().
 */
export function getAuthUrl(scopes: string[] = DEFAULT_SCOPES): string {
	const clientId = process.env.GOOGLE_CLIENT_ID ?? "";
	const redirectUri = process.env.GOOGLE_REDIRECT_URI ?? "urn:ietf:wg:oauth:2.0:oob";
	if (!clientId) throw new Error("GOOGLE_CLIENT_ID must be set in .env");
	const params = new URLSearchParams({
		client_id: clientId,
		redirect_uri: redirectUri,
		response_type: "code",
		scope: scopes.join(" "),
		access_type: "offline",
		prompt: "consent",
	});
	return `${AUTH_URL}?${params.toString()}`;
}

/**
 * Exchange an authorization code (from the consent flow) for tokens
 * and persist them in SQLite. Run once during initial setup.
 */
export async function exchangeCode(code: string, provider = PROVIDER): Promise<void> {
	const clientId = process.env.GOOGLE_CLIENT_ID ?? "";
	const clientSecret = process.env.GOOGLE_CLIENT_SECRET ?? "";
	const redirectUri = process.env.GOOGLE_REDIRECT_URI ?? "urn:ietf:wg:oauth:2.0:oob";

	if (!clientId || !clientSecret) {
		throw new Error("GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET must be set in .env");
	}

	const params = new URLSearchParams({
		client_id: clientId,
		client_secret: clientSecret,
		redirect_uri: redirectUri,
		code,
		grant_type: "authorization_code",
	});

	const res = await fetch(TOKEN_URL, {
		method: "POST",
		headers: { "Content-Type": "application/x-www-form-urlencoded" },
		body: params.toString(),
	});

	if (!res.ok) {
		const body = await res.text();
		throw new Error(`Code exchange failed (${res.status}): ${body}`);
	}

	const json = (await res.json()) as {
		access_token: string;
		refresh_token?: string;
		expires_in: number;
		error?: string;
	};

	if (json.error || !json.access_token || !json.refresh_token) {
		throw new Error(
			`Code exchange error: ${json.error ?? "missing access_token or refresh_token"}`
		);
	}

	const expiresAt = new Date(Date.now() + json.expires_in * 1000).toISOString();
	storeTokens(provider, {
		access_token: json.access_token,
		refresh_token: json.refresh_token,
		expires_at: expiresAt,
	});
}
