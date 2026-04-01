/**
 * Tests for lib/google-auth.ts — token seeding, retrieval, refresh, and cache.
 *
 * Strategy: mock ../lib/db so we control the SQLite layer entirely in-memory,
 * and mock global fetch to intercept token refresh calls.
 */
import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";

// ── In-memory token store (replaces SQLite) ───────────────────────────────────

interface TokenRow {
	provider: string;
	access_token: string;
	refresh_token: string;
	expires_at: string;
}

let _store: Map<string, TokenRow>;

function resetStore() {
	_store = new Map();
}

mock.module("../lib/db", () => ({
	openDatabase: (_pathOverride?: string) => ({
		dialect: "sqlite",
		exec: () => {},
		get: (sql: string, params?: unknown[]) => {
			const provider = params?.[0] as string;
			return _store.get(provider) ?? null;
		},
		all: () => [],
		run: (sql: string, params?: unknown[]) => {
			if (params && params.length >= 4) {
				const [provider, access_token, refresh_token, expires_at] = params as [
					string,
					string,
					string,
					string,
				];
				_store.set(provider, { provider, access_token, refresh_token, expires_at });
			}
		},
		transaction: <T>(fn: () => T) => fn(),
		close: () => {},
	}),
	upsertSql: () =>
		"INSERT OR REPLACE INTO oauth_tokens (provider, access_token, refresh_token, expires_at) VALUES (?, ?, ?, ?)",
	closeDb: () => {},
}));

// ── Import module under test AFTER mocks are in place ────────────────────────

const { clearTokenCache, getAccessToken, loadTokens, seedTokensFromEnv, storeTokens } =
	await import("../lib/google-auth");

// ── Fetch mock helpers ────────────────────────────────────────────────────────

let _fetchImpl: ((url: string, opts?: RequestInit) => Promise<Response>) | null = null;

const originalFetch = globalThis.fetch;

function mockFetch(impl: (url: string, opts?: RequestInit) => Promise<Response>) {
	_fetchImpl = impl;
	globalThis.fetch = (url: string | URL | Request, opts?: RequestInit) =>
		_fetchImpl!(url.toString(), opts);
}

function restoreFetch() {
	globalThis.fetch = originalFetch;
	_fetchImpl = null;
}

function makeJsonResponse(body: unknown, status = 200): Response {
	return new Response(JSON.stringify(body), {
		status,
		headers: { "Content-Type": "application/json" },
	});
}

// ── Test setup ────────────────────────────────────────────────────────────────

beforeEach(() => {
	resetStore();
	clearTokenCache();
	// Clean up env vars that might leak between tests
	delete process.env.GOOGLE_REFRESH_TOKEN;
	delete process.env.GOOGLE_REFRESH_TOKEN_2;
	delete process.env.GOOGLE_CLIENT_ID;
	delete process.env.GOOGLE_CLIENT_SECRET;
	delete process.env.GOOGLE_ACCESS_TOKEN;
});

afterEach(() => {
	restoreFetch();
	delete process.env.GOOGLE_REFRESH_TOKEN;
	delete process.env.GOOGLE_REFRESH_TOKEN_2;
	delete process.env.GOOGLE_CLIENT_ID;
	delete process.env.GOOGLE_CLIENT_SECRET;
	delete process.env.GOOGLE_ACCESS_TOKEN;
});

// ── seedTokensFromEnv ─────────────────────────────────────────────────────────

describe("seedTokensFromEnv", () => {
	test("does nothing when no env vars are set", () => {
		seedTokensFromEnv();
		expect(_store.size).toBe(0);
	});

	test("seeds primary account when GOOGLE_REFRESH_TOKEN is set", () => {
		process.env.GOOGLE_REFRESH_TOKEN = "rt-primary-123";
		seedTokensFromEnv();

		const row = _store.get("google");
		expect(row).toBeDefined();
		expect(row!.refresh_token).toBe("rt-primary-123");
		expect(row!.access_token).toBe(""); // forced-expire placeholder
		expect(row!.expires_at).toBe(new Date(0).toISOString()); // force refresh on first use
	});

	test("seeds secondary account when GOOGLE_REFRESH_TOKEN_2 is set", () => {
		process.env.GOOGLE_REFRESH_TOKEN_2 = "rt-secondary-456";
		seedTokensFromEnv();

		expect(_store.has("google-2")).toBe(true);
		expect(_store.get("google-2")!.refresh_token).toBe("rt-secondary-456");
	});

	test("seeds both accounts when both env vars are set", () => {
		process.env.GOOGLE_REFRESH_TOKEN = "rt-primary";
		process.env.GOOGLE_REFRESH_TOKEN_2 = "rt-secondary";
		seedTokensFromEnv();

		expect(_store.size).toBe(2);
		expect(_store.has("google")).toBe(true);
		expect(_store.has("google-2")).toBe(true);
	});

	test("skips seeding when tokens already exist in DB", () => {
		// Pre-populate the store as if tokens were already seeded
		_store.set("google", {
			provider: "google",
			access_token: "existing-token",
			refresh_token: "existing-refresh",
			expires_at: new Date(Date.now() + 3600_000).toISOString(),
		});

		process.env.GOOGLE_REFRESH_TOKEN = "new-refresh-token";
		seedTokensFromEnv();

		// Should not overwrite
		expect(_store.get("google")!.refresh_token).toBe("existing-refresh");
	});

	test("is idempotent — calling twice does not duplicate or overwrite", () => {
		process.env.GOOGLE_REFRESH_TOKEN = "rt-primary";
		seedTokensFromEnv();
		seedTokensFromEnv(); // second call
		expect(_store.size).toBe(1);
		expect(_store.get("google")!.refresh_token).toBe("rt-primary");
	});
});

// ── getAccessToken ─────────────────────────────────────────────────────────────

describe("getAccessToken", () => {
	test("returns cached token when it is fresh", async () => {
		// Seed a valid non-expiring token into the DB so the first call caches it
		const futureExpiry = new Date(Date.now() + 60 * 60 * 1000).toISOString(); // 1 hour from now
		_store.set("google", {
			provider: "google",
			access_token: "fresh-token",
			refresh_token: "refresh-x",
			expires_at: futureExpiry,
		});

		const token1 = await getAccessToken("google");
		expect(token1).toBe("fresh-token");

		// Remove from store — next call must use cache, not DB
		_store.clear();
		const token2 = await getAccessToken("google");
		expect(token2).toBe("fresh-token");
	});

	test("throws when no tokens exist in DB and no env fallback", async () => {
		await expect(getAccessToken("google")).rejects.toThrow(/No Google OAuth tokens in DB/);
	});

	test("throws for secondary provider with no tokens", async () => {
		await expect(getAccessToken("google-2")).rejects.toThrow(/No Google OAuth tokens in DB/);
	});

	test("uses GOOGLE_ACCESS_TOKEN env var as static fallback (no client ID set)", async () => {
		process.env.GOOGLE_ACCESS_TOKEN = "static-fallback-token";
		// GOOGLE_CLIENT_ID not set — triggers static path
		const token = await getAccessToken("google");
		expect(token).toBe("static-fallback-token");
	});

	test("refreshes expired token and updates DB", async () => {
		const expiredAt = new Date(0).toISOString(); // epoch = definitely expired
		_store.set("google", {
			provider: "google",
			access_token: "old-access",
			refresh_token: "the-refresh-token",
			expires_at: expiredAt,
		});

		process.env.GOOGLE_CLIENT_ID = "client-id-test";
		process.env.GOOGLE_CLIENT_SECRET = "client-secret-test";

		mockFetch(async (_url, _opts) =>
			makeJsonResponse({
				access_token: "new-access-token",
				expires_in: 3600,
				refresh_token: "new-refresh-token",
			})
		);

		const token = await getAccessToken("google");
		expect(token).toBe("new-access-token");

		// DB should be updated with new tokens
		const stored = _store.get("google");
		expect(stored!.access_token).toBe("new-access-token");
		expect(stored!.refresh_token).toBe("new-refresh-token");
	});

	test("keeps old refresh_token when Google does not rotate it", async () => {
		const expiredAt = new Date(0).toISOString();
		_store.set("google", {
			provider: "google",
			access_token: "old-access",
			refresh_token: "original-refresh",
			expires_at: expiredAt,
		});

		process.env.GOOGLE_CLIENT_ID = "cid";
		process.env.GOOGLE_CLIENT_SECRET = "csec";

		mockFetch(async () =>
			// No refresh_token in response — Google did not rotate it
			makeJsonResponse({ access_token: "refreshed-access", expires_in: 3600 })
		);

		await getAccessToken("google");
		expect(_store.get("google")!.refresh_token).toBe("original-refresh");
	});

	test("throws when refresh fails with HTTP error", async () => {
		_store.set("google", {
			provider: "google",
			access_token: "",
			refresh_token: "bad-refresh",
			expires_at: new Date(0).toISOString(),
		});

		process.env.GOOGLE_CLIENT_ID = "cid";
		process.env.GOOGLE_CLIENT_SECRET = "csec";

		mockFetch(async () => new Response("invalid_grant", { status: 400 }));

		await expect(getAccessToken("google")).rejects.toThrow(/token refresh failed/i);
	});

	test("throws when client credentials missing for refresh", async () => {
		_store.set("google", {
			provider: "google",
			access_token: "",
			refresh_token: "refresh",
			expires_at: new Date(0).toISOString(),
		});
		// No GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET set

		await expect(getAccessToken("google")).rejects.toThrow(/GOOGLE_CLIENT_ID/);
	});

	test("sends correct POST body to token endpoint", async () => {
		_store.set("google", {
			provider: "google",
			access_token: "",
			refresh_token: "my-refresh",
			expires_at: new Date(0).toISOString(),
		});

		process.env.GOOGLE_CLIENT_ID = "my-client-id";
		process.env.GOOGLE_CLIENT_SECRET = "my-client-secret";

		let capturedBody = "";
		mockFetch(async (_url, opts) => {
			capturedBody = (opts?.body as string) ?? "";
			return makeJsonResponse({ access_token: "tok", expires_in: 3600 });
		});

		await getAccessToken("google");

		const params = new URLSearchParams(capturedBody);
		expect(params.get("grant_type")).toBe("refresh_token");
		expect(params.get("refresh_token")).toBe("my-refresh");
		expect(params.get("client_id")).toBe("my-client-id");
		expect(params.get("client_secret")).toBe("my-client-secret");
	});
});

// ── clearTokenCache ───────────────────────────────────────────────────────────

describe("clearTokenCache", () => {
	test("forces re-read from DB after cache cleared", async () => {
		const futureExpiry = new Date(Date.now() + 60 * 60 * 1000).toISOString();
		_store.set("google", {
			provider: "google",
			access_token: "token-v1",
			refresh_token: "refresh",
			expires_at: futureExpiry,
		});

		const t1 = await getAccessToken("google");
		expect(t1).toBe("token-v1");

		// Update the store with a new token
		_store.set("google", {
			provider: "google",
			access_token: "token-v2",
			refresh_token: "refresh",
			expires_at: futureExpiry,
		});

		// Without clearing cache, still returns v1
		const t2 = await getAccessToken("google");
		expect(t2).toBe("token-v1");

		// After clearing cache, picks up v2 from DB
		clearTokenCache();
		const t3 = await getAccessToken("google");
		expect(t3).toBe("token-v2");
	});

	test("clearTokenCache does not throw when cache is already empty", () => {
		expect(() => clearTokenCache()).not.toThrow();
		expect(() => clearTokenCache()).not.toThrow();
	});

	test("clears cache for all providers", async () => {
		const futureExpiry = new Date(Date.now() + 60 * 60 * 1000).toISOString();

		_store.set("google", {
			provider: "google",
			access_token: "primary-v1",
			refresh_token: "r1",
			expires_at: futureExpiry,
		});
		_store.set("google-2", {
			provider: "google-2",
			access_token: "secondary-v1",
			refresh_token: "r2",
			expires_at: futureExpiry,
		});

		await getAccessToken("google");
		await getAccessToken("google-2");

		clearTokenCache();

		// Update both in store
		_store.set("google", {
			provider: "google",
			access_token: "primary-v2",
			refresh_token: "r1",
			expires_at: futureExpiry,
		});
		_store.set("google-2", {
			provider: "google-2",
			access_token: "secondary-v2",
			refresh_token: "r2",
			expires_at: futureExpiry,
		});

		expect(await getAccessToken("google")).toBe("primary-v2");
		expect(await getAccessToken("google-2")).toBe("secondary-v2");
	});
});

// ── storeTokens / loadTokens (direct helpers) ─────────────────────────────────

describe("storeTokens / loadTokens", () => {
	test("round-trips token data through the DB mock", () => {
		const exp = new Date(Date.now() + 3600_000).toISOString();
		storeTokens("google", { access_token: "at", refresh_token: "rt", expires_at: exp });

		const row = loadTokens("google");
		expect(row).not.toBeNull();
		expect(row!.access_token).toBe("at");
		expect(row!.refresh_token).toBe("rt");
		expect(row!.expires_at).toBe(exp);
	});

	test("loadTokens returns null when provider not found", () => {
		const row = loadTokens("google-99");
		expect(row).toBeNull();
	});

	test("storeTokens overwrites existing entry for same provider", () => {
		const exp = new Date(Date.now() + 3600_000).toISOString();
		storeTokens("google", { access_token: "v1", refresh_token: "r1", expires_at: exp });
		storeTokens("google", { access_token: "v2", refresh_token: "r2", expires_at: exp });

		const row = loadTokens("google");
		expect(row!.access_token).toBe("v2");
	});
});
