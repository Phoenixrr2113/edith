/**
 * Tests for lib/gmail.ts — searchEmails, searchAllAccounts, manageEmail, and action routing.
 *
 * Strategy:
 *   - mock ../lib/db with an in-memory token store so the real getAccessToken
 *     works without SQLite (avoids cross-file mock contamination with google-auth.test.ts)
 *   - mock global fetch to capture and control Gmail API responses
 *   - mock ../lib/config to expose a known GOOGLE_ACCOUNTS array
 */
import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";

// ── In-memory token store (replaces SQLite for both google-auth AND gmail) ────
//
// We mock ../lib/db here just like google-auth.test.ts does.  The real
// getAccessToken will call openDatabase() → our mock → find tokens → return them.
// This avoids mocking ../lib/google-auth directly, which would contaminate
// google-auth.test.ts when both files run in the same bun worker.

interface TokenRow {
	provider: string;
	access_token: string;
	refresh_token: string;
	expires_at: string;
}

const _store = new Map<string, TokenRow>();

// Well-known token values so tests can assert on Authorization headers
const FAKE_TOKEN_PRIMARY = "fake-token-primary";
const FAKE_TOKEN_SECONDARY = "fake-token-secondary";

function seedDefaultTokens() {
	const futureExpiry = new Date(Date.now() + 60 * 60 * 1000).toISOString();
	_store.set("google", {
		provider: "google",
		access_token: FAKE_TOKEN_PRIMARY,
		refresh_token: "rt-primary",
		expires_at: futureExpiry,
	});
	_store.set("google-2", {
		provider: "google-2",
		access_token: FAKE_TOKEN_SECONDARY,
		refresh_token: "rt-secondary",
		expires_at: futureExpiry,
	});
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

// ── Mock config ───────────────────────────────────────────────────────────────

mock.module("../lib/config", () => ({
	GOOGLE_ACCOUNTS: [
		{ provider: "google", label: "primary@gmail.com", refreshTokenEnv: "GOOGLE_REFRESH_TOKEN" },
		{
			provider: "google-2",
			label: "secondary@gmail.com",
			refreshTokenEnv: "GOOGLE_REFRESH_TOKEN_2",
		},
	],
}));

// ── Import module under test AFTER mocks ──────────────────────────────────────

const {
	archiveEmail,
	batchManage,
	manageEmail,
	markAsRead,
	removeLabel,
	addLabel,
	searchAllAccounts,
	searchEmails,
	trashEmail,
} = await import("../lib/gmail");

// Import clearTokenCache from the real google-auth so we can reset per-test
const { clearTokenCache } = await import("../lib/google-auth");

// ── Fetch mock helpers ────────────────────────────────────────────────────────

type FetchHandler = (url: string, opts?: RequestInit) => Promise<Response>;

const _fetchHandlers: FetchHandler[] = [];

/**
 * Header-routing table for concurrent requests (e.g. searchAllAccounts).
 * Entries are [tokenPart, handler] pairs — matched against Authorization header.
 * First match wins and is consumed.
 */
const _routeHandlers: Array<[string, FetchHandler]> = [];

function pushFetchHandler(fn: FetchHandler) {
	_fetchHandlers.push(fn);
}

/**
 * Register a handler that fires when the Authorization header contains `tokenPart`.
 * Used for concurrent multi-account requests where arrival order is non-deterministic.
 */
function pushRouteHandler(tokenPart: string, fn: FetchHandler) {
	_routeHandlers.push([tokenPart, fn]);
}

function makeJsonResponse(body: unknown, status = 200): Response {
	return new Response(JSON.stringify(body), {
		status,
		headers: { "Content-Type": "application/json" },
	});
}

function makeErrorResponse(status: number, text = "error"): Response {
	return new Response(text, { status });
}

// Install a single fetch spy that delegates to route handlers (by auth token) then FIFO
globalThis.fetch = async (url: string | URL | Request, opts?: RequestInit): Promise<Response> => {
	const urlStr = url.toString();
	const authHeader = ((opts?.headers ?? {}) as Record<string, string>)["Authorization"] ?? "";

	// Try auth-token-based route handlers first (for concurrent multi-account requests)
	for (let i = 0; i < _routeHandlers.length; i++) {
		const [tokenPart, fn] = _routeHandlers[i];
		if (authHeader.includes(tokenPart)) {
			_routeHandlers.splice(i, 1);
			return fn(urlStr, opts);
		}
	}

	// Fall through to sequential FIFO handlers
	const handler = _fetchHandlers.shift();
	if (!handler) throw new Error(`Unexpected fetch call to: ${urlStr}`);
	return handler(urlStr, opts);
};

function makeMessageListResponse(ids: string[]): unknown {
	return {
		messages: ids.map((id) => ({ id })),
		resultSizeEstimate: ids.length,
	};
}

function makeMessageDetailResponse(
	id: string,
	subject = "Test Subject",
	from = "sender@example.com",
	date = "Mon, 30 Mar 2026 10:00:00 +0000",
	snippet = "snippet text",
	unread = true
): unknown {
	return {
		id,
		snippet,
		labelIds: unread ? ["INBOX", "UNREAD"] : ["INBOX"],
		payload: {
			headers: [
				{ name: "Subject", value: subject },
				{ name: "From", value: from },
				{ name: "Date", value: date },
			],
		},
	};
}

// ── Test setup ────────────────────────────────────────────────────────────────

beforeEach(() => {
	_fetchHandlers.length = 0;
	_routeHandlers.length = 0;
	_store.clear();
	clearTokenCache();
	seedDefaultTokens();
	// searchAllAccounts checks env vars to determine active accounts
	delete process.env.GOOGLE_REFRESH_TOKEN;
	delete process.env.GOOGLE_REFRESH_TOKEN_2;
	// Ensure client ID/secret not set (avoids unintentional refresh paths)
	delete process.env.GOOGLE_CLIENT_ID;
	delete process.env.GOOGLE_CLIENT_SECRET;
	delete process.env.GOOGLE_ACCESS_TOKEN;
});

afterEach(() => {
	_fetchHandlers.length = 0;
	_routeHandlers.length = 0;
	delete process.env.GOOGLE_REFRESH_TOKEN;
	delete process.env.GOOGLE_REFRESH_TOKEN_2;
	delete process.env.GOOGLE_CLIENT_ID;
	delete process.env.GOOGLE_CLIENT_SECRET;
	delete process.env.GOOGLE_ACCESS_TOKEN;
});

// ── searchEmails ──────────────────────────────────────────────────────────────

describe("searchEmails", () => {
	test("returns emails with correct fields from API", async () => {
		pushFetchHandler(async () => makeJsonResponse(makeMessageListResponse(["msg1"])));
		pushFetchHandler(async () =>
			makeJsonResponse(
				makeMessageDetailResponse(
					"msg1",
					"Hello World",
					"bob@example.com",
					"Mon, 30 Mar 2026 10:00:00 +0000",
					"hey there",
					true
				)
			)
		);

		const result = await searchEmails({ provider: "google" });

		expect(result.count).toBe(1);
		expect(result.emails[0].id).toBe("msg1");
		expect(result.emails[0].subject).toBe("Hello World");
		expect(result.emails[0].from).toBe("bob@example.com");
		expect(result.emails[0].unread).toBe(true);
		expect(result.emails[0].snippet).toBe("hey there");
	});

	test("returns empty list when no messages match", async () => {
		pushFetchHandler(async () => makeJsonResponse({ messages: [], resultSizeEstimate: 0 }));

		const result = await searchEmails({ provider: "google" });
		expect(result.count).toBe(0);
		expect(result.emails).toHaveLength(0);
	});

	test("handles missing messages field gracefully", async () => {
		pushFetchHandler(async () => makeJsonResponse({ resultSizeEstimate: 0 }));

		const result = await searchEmails({ provider: "google" });
		expect(result.count).toBe(0);
	});

	test("respects maxResults cap at 50", async () => {
		const ids = Array.from({ length: 60 }, (_, i) => `msg${i}`);
		pushFetchHandler(async () => makeJsonResponse(makeMessageListResponse(ids)));
		for (let i = 0; i < 50; i++) {
			pushFetchHandler(async (url) => {
				const id = url.split("/messages/")[1].split("?")[0];
				return makeJsonResponse(makeMessageDetailResponse(id));
			});
		}

		const result = await searchEmails({ maxResults: 50, provider: "google" });
		expect(result.count).toBe(50);
	});

	test("builds query with hoursBack and unreadOnly by default", async () => {
		let capturedUrl = "";
		pushFetchHandler(async (url) => {
			capturedUrl = url;
			return makeJsonResponse({ resultSizeEstimate: 0 });
		});

		await searchEmails({ hoursBack: 4, unreadOnly: true, provider: "google" });

		const parsedUrl = new URL(capturedUrl);
		const q = parsedUrl.searchParams.get("q") ?? "";
		expect(q).toContain("after:");
		expect(q).toContain("is:unread");
	});

	test("uses custom query string when provided, overriding hoursBack/unreadOnly", async () => {
		let capturedUrl = "";
		pushFetchHandler(async (url) => {
			capturedUrl = url;
			return makeJsonResponse({ resultSizeEstimate: 0 });
		});

		await searchEmails({ query: "from:boss@example.com", provider: "google" });

		const parsedUrl = new URL(capturedUrl);
		expect(parsedUrl.searchParams.get("q")).toBe("from:boss@example.com");
	});

	test("does NOT include is:unread when unreadOnly=false", async () => {
		let capturedUrl = "";
		pushFetchHandler(async (url) => {
			capturedUrl = url;
			return makeJsonResponse({ resultSizeEstimate: 0 });
		});

		await searchEmails({ unreadOnly: false, provider: "google" });

		const parsedUrl = new URL(capturedUrl);
		expect(parsedUrl.searchParams.get("q")).not.toContain("is:unread");
	});

	test("sets Authorization header with Bearer token", async () => {
		let capturedHeaders: Record<string, string> = {};
		pushFetchHandler(async (_url, opts) => {
			capturedHeaders = (opts?.headers ?? {}) as Record<string, string>;
			return makeJsonResponse({ resultSizeEstimate: 0 });
		});

		await searchEmails({ provider: "google" });
		expect(capturedHeaders["Authorization"]).toBe(`Bearer ${FAKE_TOKEN_PRIMARY}`);
	});

	test("throws on non-ok list response", async () => {
		pushFetchHandler(async () => makeErrorResponse(401, "Unauthorized"));
		await expect(searchEmails({ provider: "google" })).rejects.toThrow(/messages.list failed/);
	});

	test("marks email as read=false when UNREAD not in labelIds", async () => {
		pushFetchHandler(async () => makeJsonResponse(makeMessageListResponse(["msg-read"])));
		pushFetchHandler(async () =>
			makeJsonResponse(
				makeMessageDetailResponse(
					"msg-read",
					"Read Email",
					"x@y.com",
					"Mon, 30 Mar 2026 10:00:00 +0000",
					"snip",
					false
				)
			)
		);

		const result = await searchEmails({ provider: "google" });
		expect(result.emails[0].unread).toBe(false);
	});

	test("defaults subject to (no subject) when header is missing", async () => {
		pushFetchHandler(async () => makeJsonResponse(makeMessageListResponse(["msg-nosubj"])));
		pushFetchHandler(async () =>
			makeJsonResponse({
				id: "msg-nosubj",
				snippet: "snip",
				labelIds: [],
				payload: {
					headers: [
						{ name: "From", value: "x@y.com" },
						{ name: "Date", value: "Mon, 30 Mar 2026 10:00:00 +0000" },
					],
				},
			})
		);

		const result = await searchEmails({ provider: "google" });
		expect(result.emails[0].subject).toBe("(no subject)");
	});
});

// ── searchAllAccounts ─────────────────────────────────────────────────────────
//
// searchAllAccounts uses Promise.allSettled so both accounts fire concurrently.
// We use pushRouteHandler (auth-token based) to route responses deterministically
// regardless of arrival order.

describe("searchAllAccounts", () => {
	test("merges results from both active accounts", async () => {
		process.env.GOOGLE_REFRESH_TOKEN = "rt1";
		process.env.GOOGLE_REFRESH_TOKEN_2 = "rt2";

		pushRouteHandler(FAKE_TOKEN_PRIMARY, async (url) => {
			if (url.includes("/messages?")) return makeJsonResponse(makeMessageListResponse(["p1"]));
			return makeJsonResponse(
				makeMessageDetailResponse(
					"p1",
					"Primary Email",
					"a@b.com",
					"Tue, 31 Mar 2026 08:00:00 +0000"
				)
			);
		});
		pushRouteHandler(FAKE_TOKEN_PRIMARY, async () =>
			makeJsonResponse(
				makeMessageDetailResponse(
					"p1",
					"Primary Email",
					"a@b.com",
					"Tue, 31 Mar 2026 08:00:00 +0000"
				)
			)
		);
		pushRouteHandler(FAKE_TOKEN_SECONDARY, async (url) => {
			if (url.includes("/messages?")) return makeJsonResponse(makeMessageListResponse(["s1"]));
			return makeJsonResponse(
				makeMessageDetailResponse(
					"s1",
					"Secondary Email",
					"c@d.com",
					"Mon, 30 Mar 2026 09:00:00 +0000"
				)
			);
		});
		pushRouteHandler(FAKE_TOKEN_SECONDARY, async () =>
			makeJsonResponse(
				makeMessageDetailResponse(
					"s1",
					"Secondary Email",
					"c@d.com",
					"Mon, 30 Mar 2026 09:00:00 +0000"
				)
			)
		);

		const result = await searchAllAccounts();
		expect(result.count).toBe(2);
		const ids = result.emails.map((e) => e.id);
		expect(ids).toContain("p1");
		expect(ids).toContain("s1");
	});

	test("sorts merged results newest first", async () => {
		process.env.GOOGLE_REFRESH_TOKEN = "rt1";
		process.env.GOOGLE_REFRESH_TOKEN_2 = "rt2";

		pushRouteHandler(FAKE_TOKEN_PRIMARY, async (url) => {
			if (url.includes("/messages?")) return makeJsonResponse(makeMessageListResponse(["old"]));
			return makeJsonResponse(
				makeMessageDetailResponse("old", "Old", "x@y.com", "Mon, 28 Mar 2026 10:00:00 +0000")
			);
		});
		pushRouteHandler(FAKE_TOKEN_PRIMARY, async () =>
			makeJsonResponse(
				makeMessageDetailResponse("old", "Old", "x@y.com", "Mon, 28 Mar 2026 10:00:00 +0000")
			)
		);
		pushRouteHandler(FAKE_TOKEN_SECONDARY, async (url) => {
			if (url.includes("/messages?")) return makeJsonResponse(makeMessageListResponse(["new"]));
			return makeJsonResponse(
				makeMessageDetailResponse("new", "New", "a@b.com", "Wed, 30 Mar 2026 12:00:00 +0000")
			);
		});
		pushRouteHandler(FAKE_TOKEN_SECONDARY, async () =>
			makeJsonResponse(
				makeMessageDetailResponse("new", "New", "a@b.com", "Wed, 30 Mar 2026 12:00:00 +0000")
			)
		);

		const result = await searchAllAccounts();
		expect(result.count).toBe(2);
		expect(result.emails[0].id).toBe("new");
		expect(result.emails[1].id).toBe("old");
	});

	test("only queries accounts whose env var is set", async () => {
		process.env.GOOGLE_REFRESH_TOKEN = "rt1";
		// GOOGLE_REFRESH_TOKEN_2 NOT set — secondary account skipped

		pushFetchHandler(async () => makeJsonResponse(makeMessageListResponse(["only-primary"])));
		pushFetchHandler(async () => makeJsonResponse(makeMessageDetailResponse("only-primary")));

		const result = await searchAllAccounts();
		expect(result.count).toBe(1);
		expect(result.emails[0].id).toBe("only-primary");
	});

	test("handles failure from one account gracefully and still returns the other", async () => {
		process.env.GOOGLE_REFRESH_TOKEN = "rt1";
		process.env.GOOGLE_REFRESH_TOKEN_2 = "rt2";

		// Primary fails on its list call
		pushRouteHandler(FAKE_TOKEN_PRIMARY, async () => makeErrorResponse(500, "Server Error"));

		// Secondary succeeds
		pushRouteHandler(FAKE_TOKEN_SECONDARY, async (url) => {
			if (url.includes("/messages?")) return makeJsonResponse(makeMessageListResponse(["s-ok"]));
			return makeJsonResponse(makeMessageDetailResponse("s-ok", "Secondary OK"));
		});
		pushRouteHandler(FAKE_TOKEN_SECONDARY, async () =>
			makeJsonResponse(makeMessageDetailResponse("s-ok", "Secondary OK"))
		);

		const result = await searchAllAccounts();
		expect(result.count).toBe(1);
		expect(result.emails[0].id).toBe("s-ok");
	});

	test("returns empty list when no accounts are active", async () => {
		// Neither env var set
		const result = await searchAllAccounts();
		expect(result.count).toBe(0);
		expect(result.emails).toHaveLength(0);
	});

	test("returns empty list when both accounts fail", async () => {
		process.env.GOOGLE_REFRESH_TOKEN = "rt1";
		process.env.GOOGLE_REFRESH_TOKEN_2 = "rt2";

		pushRouteHandler(FAKE_TOKEN_PRIMARY, async () => makeErrorResponse(403, "Forbidden"));
		pushRouteHandler(FAKE_TOKEN_SECONDARY, async () => makeErrorResponse(403, "Forbidden"));

		const result = await searchAllAccounts();
		expect(result.count).toBe(0);
	});
});

// ── manageEmail routing ───────────────────────────────────────────────────────

describe("manageEmail routing", () => {
	test("archive — calls messages/modify with removeLabelIds: INBOX", async () => {
		let capturedBody = "";
		let capturedUrl = "";
		pushFetchHandler(async (url, opts) => {
			capturedUrl = url;
			capturedBody = (opts?.body as string) ?? "";
			return makeJsonResponse({ id: "m1" });
		});

		await manageEmail("m1", "archive");

		expect(capturedUrl).toContain("/messages/m1/modify");
		const body = JSON.parse(capturedBody);
		expect(body.removeLabelIds).toContain("INBOX");
	});

	test("trash — calls messages/trash endpoint", async () => {
		let capturedUrl = "";
		pushFetchHandler(async (url) => {
			capturedUrl = url;
			return makeJsonResponse({ id: "m2" });
		});

		await manageEmail("m2", "trash");

		expect(capturedUrl).toContain("/messages/m2/trash");
	});

	test("markAsRead — calls messages/modify with removeLabelIds: UNREAD", async () => {
		let capturedBody = "";
		pushFetchHandler(async (_url, opts) => {
			capturedBody = (opts?.body as string) ?? "";
			return makeJsonResponse({ id: "m3" });
		});

		await manageEmail("m3", "markAsRead");

		const body = JSON.parse(capturedBody);
		expect(body.removeLabelIds).toContain("UNREAD");
	});

	test("addLabel — resolves label and adds to message", async () => {
		// First fetch: labels.list to resolve label ID
		pushFetchHandler(async (url) => {
			if (url.endsWith("/labels")) {
				return makeJsonResponse({ labels: [{ id: "Label_123", name: "MyLabel" }] });
			}
			throw new Error(`Unexpected url: ${url}`);
		});
		// Second fetch: modify
		let capturedBody = "";
		pushFetchHandler(async (_url, opts) => {
			capturedBody = (opts?.body as string) ?? "";
			return makeJsonResponse({ id: "m4" });
		});

		await manageEmail("m4", "addLabel", "MyLabel");

		const body = JSON.parse(capturedBody);
		expect(body.addLabelIds).toContain("Label_123");
	});

	test("removeLabel — resolves label and removes from message", async () => {
		// Use "google-2" provider to get a fresh label cache (avoids cache from addLabel test)
		pushFetchHandler(async () =>
			makeJsonResponse({ labels: [{ id: "Label_456", name: "OldLabel" }] })
		);
		let capturedBody = "";
		pushFetchHandler(async (_url, opts) => {
			capturedBody = (opts?.body as string) ?? "";
			return makeJsonResponse({ id: "m5" });
		});

		await removeLabel("m5", "OldLabel", "google-2");

		const body = JSON.parse(capturedBody);
		expect(body.removeLabelIds).toContain("Label_456");
	});

	test("addLabel throws when label arg is missing", async () => {
		await expect(manageEmail("m6", "addLabel")).rejects.toThrow(/addLabel requires a label/);
	});

	test("removeLabel throws when label arg is missing", async () => {
		await expect(manageEmail("m7", "removeLabel")).rejects.toThrow(/removeLabel requires a label/);
	});

	test("archive propagates error on non-ok response", async () => {
		pushFetchHandler(async () => makeErrorResponse(403, "Forbidden"));
		await expect(manageEmail("m8", "archive")).rejects.toThrow(/archive failed/);
	});

	test("trash propagates error on non-ok response", async () => {
		// First attempt (primary) returns 404 → triggers fallback
		pushFetchHandler(async () => makeErrorResponse(404, "Not Found"));
		// Fallback attempt (secondary) also returns 404
		pushFetchHandler(async () => makeErrorResponse(404, "Not Found"));
		await expect(manageEmail("m9", "trash")).rejects.toThrow(/trash failed/);
	});

	test("uses secondary provider when specified", async () => {
		let capturedHeaders: Record<string, string> = {};
		pushFetchHandler(async (_url, opts) => {
			capturedHeaders = (opts?.headers ?? {}) as Record<string, string>;
			return makeJsonResponse({ id: "m10" });
		});

		await manageEmail("m10", "trash", undefined, "google-2");
		expect(capturedHeaders["Authorization"]).toBe(`Bearer ${FAKE_TOKEN_SECONDARY}`);
	});
});

// ── batchManage ───────────────────────────────────────────────────────────────

describe("batchManage", () => {
	test("executes all operations and reports success count", async () => {
		pushFetchHandler(async () => makeJsonResponse({ id: "b1" }));
		pushFetchHandler(async () => makeJsonResponse({ id: "b2" }));

		const result = await batchManage([
			{ messageId: "b1", action: "archive" },
			{ messageId: "b2", action: "archive" },
		]);

		expect(result.success).toBe(true);
		expect(result.count).toBe(2);
		expect(result.errors).toHaveLength(0);
	});

	test("collects errors from failed operations and continues", async () => {
		pushFetchHandler(async () => makeJsonResponse({ id: "ok" }));
		pushFetchHandler(async () => makeErrorResponse(500, "fail"));

		const result = await batchManage([
			{ messageId: "ok", action: "archive" },
			{ messageId: "fail", action: "trash" },
		]);

		expect(result.success).toBe(false);
		expect(result.count).toBe(1);
		expect(result.errors).toHaveLength(1);
		expect(result.errors[0]).toContain("fail/trash");
	});

	test("returns success=true and count=0 for empty operations list", async () => {
		const result = await batchManage([]);
		expect(result.success).toBe(true);
		expect(result.count).toBe(0);
		expect(result.errors).toHaveLength(0);
	});
});

// ── Direct action helpers ─────────────────────────────────────────────────────

describe("archiveEmail", () => {
	test("sends correct request", async () => {
		let method = "";
		let url = "";
		pushFetchHandler(async (u, opts) => {
			url = u;
			method = opts?.method ?? "GET";
			return makeJsonResponse({});
		});

		await archiveEmail("arc1");
		expect(url).toContain("/messages/arc1/modify");
		expect(method).toBe("POST");
	});
});

describe("trashEmail", () => {
	test("sends correct request", async () => {
		let url = "";
		pushFetchHandler(async (u) => {
			url = u;
			return makeJsonResponse({});
		});

		await trashEmail("tr1");
		expect(url).toContain("/messages/tr1/trash");
	});
});

describe("markAsRead", () => {
	test("sends removeLabelIds UNREAD", async () => {
		let body = "";
		pushFetchHandler(async (_u, opts) => {
			body = (opts?.body as string) ?? "";
			return makeJsonResponse({});
		});

		await markAsRead("rd1");
		expect(JSON.parse(body).removeLabelIds).toContain("UNREAD");
	});
});

describe("addLabel / removeLabel", () => {
	test("addLabel skips label lookup for already-uppercase IDs", async () => {
		// ID like "INBOX" is treated as a known label — no labels.list call
		let capturedBody = "";
		pushFetchHandler(async (_url, opts) => {
			capturedBody = (opts?.body as string) ?? "";
			return makeJsonResponse({});
		});

		await addLabel("m1", "INBOX");
		// Only one fetch call (no labels.list)
		expect(JSON.parse(capturedBody).addLabelIds).toContain("INBOX");
	});

	test("addLabel throws when label name not found", async () => {
		// Use a fresh provider "google-3" to avoid cached labels from other tests
		// We set up a token for it in the store first, then give it an empty label list
		const futureExpiry = new Date(Date.now() + 3600_000).toISOString();
		_store.set("google-3", {
			provider: "google-3",
			access_token: "fake-token-google-3",
			refresh_token: "rt3",
			expires_at: futureExpiry,
		});

		pushFetchHandler(async () =>
			makeJsonResponse({ labels: [{ id: "Label_1", name: "Existing" }] })
		);

		await expect(addLabel("m2", "NonExistent", "google-3")).rejects.toThrow(/label not found/i);
	});
});
