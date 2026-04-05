/**
 * Tests for lib/gcal.ts, lib/gdocs.ts, and lib/gdrive.ts.
 *
 * Strategy: mock fetch globally to intercept all HTTP calls, and mock
 * lib/google-auth to return a deterministic fake token. All three libs
 * are covered in a single file since they share the same mock setup.
 *
 * Mocks must be declared before any lib imports (Bun hoisting requirement).
 */
import { beforeEach, describe, expect, mock, test } from "bun:test";

// ── Fake token ────────────────────────────────────────────────────────────────

const FAKE_TOKEN = "fake-access-token-xyz";

// ── Mock lib/db so getAccessToken works without real SQLite ──────────────────
//
// Previous approach mocked ../lib/google-auth entirely, which poisoned the
// module cache for google-auth.test.ts and gmail.test.ts running in the same
// Bun worker.  Now we mock the DB layer and seed a fresh token instead.

const _tokenStore = new Map<
	string,
	{ provider: string; access_token: string; refresh_token: string; expires_at: string }
>();

mock.module("../lib/db", () => ({
	openDatabase: () => ({
		dialect: "sqlite",
		exec: () => {},
		get: (sql: string, params?: unknown[]) => {
			const provider = params?.[0] as string;
			return _tokenStore.get(provider) ?? null;
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
				_tokenStore.set(provider, { provider, access_token, refresh_token, expires_at });
			}
		},
		transaction: <T>(fn: () => T) => fn(),
		close: () => {},
	}),
	upsertSql: () =>
		"INSERT OR REPLACE INTO oauth_tokens (provider, access_token, refresh_token, expires_at) VALUES (?, ?, ?, ?)",
	closeDb: () => {},
}));

// ── Imports after mocks ───────────────────────────────────────────────────────

import { createEvent, deleteEvent, getEvents, updateEvent } from "../lib/gcal";
import { createDoc, getDoc } from "../lib/gdocs";
import { downloadFile, getFile, searchFiles, uploadFile } from "../lib/gdrive";
import { clearTokenCache } from "../lib/google-auth";

// ── fetch mock helpers ────────────────────────────────────────────────────────

type FetchCall = { url: string; init: RequestInit };
const fetchCalls: FetchCall[] = [];

function mockFetch(handler: (url: string, init: RequestInit) => Response) {
	global.fetch = mock(async (url: string, init: RequestInit = {}) => {
		fetchCalls.push({ url, init });
		return handler(url, init);
	}) as typeof fetch;
}

function jsonResponse(body: unknown, status = 200): Response {
	return new Response(JSON.stringify(body), {
		status,
		headers: { "Content-Type": "application/json" },
	});
}

function textResponse(body: string, status = 200): Response {
	return new Response(body, { status, headers: { "Content-Type": "text/plain" } });
}

function noContent(): Response {
	return new Response(null, { status: 204 });
}

beforeEach(() => {
	fetchCalls.length = 0;
	_tokenStore.clear();
	clearTokenCache();
	// Seed a fresh, non-expired token so getAccessToken returns FAKE_TOKEN
	const futureExpiry = new Date(Date.now() + 60 * 60 * 1000).toISOString();
	_tokenStore.set("google", {
		provider: "google",
		access_token: FAKE_TOKEN,
		refresh_token: "rt-test",
		expires_at: futureExpiry,
	});
});

// ═══════════════════════════════════════════════════════════════════════════════
// lib/gcal.ts
// ═══════════════════════════════════════════════════════════════════════════════

describe("gcal — getEvents", () => {
	test("builds correct URL params with defaults", async () => {
		mockFetch(() => jsonResponse({ items: [] }));

		await getEvents();

		expect(fetchCalls).toHaveLength(1);
		const url = new URL(fetchCalls[0].url);
		expect(url.origin + url.pathname).toBe(
			"https://www.googleapis.com/calendar/v3/calendars/randyrowanwilson%40gmail.com/events"
		);
		expect(url.searchParams.get("singleEvents")).toBe("true");
		expect(url.searchParams.get("orderBy")).toBe("startTime");
		expect(url.searchParams.get("maxResults")).toBe("50");
		expect(url.searchParams.has("timeMin")).toBe(true);
		expect(url.searchParams.has("timeMax")).toBe(true);
	});

	test("forwards custom calendarId, timeMin, timeMax, maxResults", async () => {
		mockFetch(() => jsonResponse({ items: [] }));

		await getEvents({
			calendarId: "other@example.com",
			timeMin: "2025-01-01T00:00:00Z",
			timeMax: "2025-01-02T00:00:00Z",
			maxResults: 10,
		});

		const url = new URL(fetchCalls[0].url);
		expect(url.pathname).toContain(encodeURIComponent("other@example.com"));
		expect(url.searchParams.get("timeMin")).toBe("2025-01-01T00:00:00Z");
		expect(url.searchParams.get("timeMax")).toBe("2025-01-02T00:00:00Z");
		expect(url.searchParams.get("maxResults")).toBe("10");
	});

	test("sends Authorization header with token", async () => {
		mockFetch(() => jsonResponse({ items: [] }));

		await getEvents();

		const headers = fetchCalls[0].init.headers as Record<string, string>;
		expect(headers["Authorization"]).toBe(`Bearer ${FAKE_TOKEN}`);
	});

	test("normalizes returned events", async () => {
		mockFetch(() =>
			jsonResponse({
				items: [
					{
						id: "evt1",
						summary: "Team sync",
						start: { dateTime: "2025-06-01T10:00:00Z" },
						end: { dateTime: "2025-06-01T11:00:00Z" },
						location: "Zoom",
					},
				],
			})
		);

		const events = await getEvents();
		expect(events).toHaveLength(1);
		expect(events[0]).toEqual({
			id: "evt1",
			summary: "Team sync",
			start: "2025-06-01T10:00:00Z",
			end: "2025-06-01T11:00:00Z",
			location: "Zoom",
		});
	});

	test("filters all-day events when includeAllDay=false", async () => {
		mockFetch(() =>
			jsonResponse({
				items: [
					{
						id: "a",
						summary: "All day",
						start: { date: "2025-06-01" },
						end: { date: "2025-06-02" },
					},
					{
						id: "b",
						summary: "Timed",
						start: { dateTime: "2025-06-01T10:00:00Z" },
						end: { dateTime: "2025-06-01T11:00:00Z" },
					},
				],
			})
		);

		const events = await getEvents({ includeAllDay: false });
		expect(events).toHaveLength(1);
		expect(events[0].id).toBe("b");
	});

	test("throws on API error", async () => {
		mockFetch(() => textResponse("Unauthorized", 401));
		await expect(getEvents()).rejects.toThrow("401");
	});
});

describe("gcal — createEvent", () => {
	test("POSTs to the correct events endpoint", async () => {
		mockFetch(() =>
			jsonResponse({
				id: "new-evt",
				summary: "Dentist",
				start: { dateTime: "2025-06-01T09:00:00Z" },
				end: { dateTime: "2025-06-01T10:00:00Z" },
			})
		);

		await createEvent({ summary: "Dentist", start: "2025-06-01T09:00:00Z" });

		expect(fetchCalls[0].init.method).toBe("POST");
		const url = fetchCalls[0].url;
		expect(url).toContain("/calendar/v3/calendars/");
		expect(url).toContain("/events");
	});

	test("sends correct body fields for a timed event", async () => {
		mockFetch(() =>
			jsonResponse({
				id: "e1",
				summary: "Stand-up",
				start: { dateTime: "2025-06-01T09:00:00Z" },
				end: { dateTime: "2025-06-01T09:30:00Z" },
			})
		);

		await createEvent({
			summary: "Stand-up",
			start: "2025-06-01T09:00:00Z",
			end: "2025-06-01T09:30:00Z",
			description: "Daily sync",
			location: "Office",
		});

		const body = JSON.parse(fetchCalls[0].init.body as string);
		expect(body.summary).toBe("Stand-up");
		expect(body.start.dateTime).toBe("2025-06-01T09:00:00Z");
		expect(body.end.dateTime).toBe("2025-06-01T09:30:00Z");
		expect(body.description).toBe("Daily sync");
		expect(body.location).toBe("Office");
	});

	test("uses date fields for all-day events", async () => {
		mockFetch(() =>
			jsonResponse({
				id: "e2",
				summary: "Holiday",
				start: { date: "2025-07-04" },
				end: { date: "2025-07-05" },
			})
		);

		await createEvent({ summary: "Holiday", start: "2025-07-04", allDay: true });

		const body = JSON.parse(fetchCalls[0].init.body as string);
		expect(body.start.date).toBe("2025-07-04");
		expect(body.start.dateTime).toBeUndefined();
	});

	test("returns normalized CalendarEvent", async () => {
		mockFetch(() =>
			jsonResponse({
				id: "e3",
				summary: "Review",
				start: { dateTime: "2025-06-10T14:00:00Z" },
				end: { dateTime: "2025-06-10T15:00:00Z" },
			})
		);

		const event = await createEvent({ summary: "Review", start: "2025-06-10T14:00:00Z" });
		expect(event.id).toBe("e3");
		expect(event.summary).toBe("Review");
	});
});

describe("gcal — updateEvent", () => {
	test("PATCHes the correct event URL", async () => {
		mockFetch(() =>
			jsonResponse({
				id: "evt99",
				summary: "Updated",
				start: { dateTime: "2025-06-01T10:00:00Z" },
				end: { dateTime: "2025-06-01T11:00:00Z" },
			})
		);

		await updateEvent({ eventId: "evt99", summary: "Updated" });

		expect(fetchCalls[0].init.method).toBe("PATCH");
		expect(fetchCalls[0].url).toContain("/events/evt99");
	});

	test("sends only provided fields", async () => {
		mockFetch(() =>
			jsonResponse({
				id: "evt99",
				summary: "Renamed",
				start: { dateTime: "2025-06-01T10:00:00Z" },
				end: { dateTime: "2025-06-01T11:00:00Z" },
			})
		);

		await updateEvent({ eventId: "evt99", summary: "Renamed" });

		const body = JSON.parse(fetchCalls[0].init.body as string);
		expect(body.summary).toBe("Renamed");
		expect(body.description).toBeUndefined();
		expect(body.location).toBeUndefined();
	});

	test("includes start/end when provided", async () => {
		mockFetch(() =>
			jsonResponse({
				id: "evt99",
				summary: "Moved",
				start: { dateTime: "2025-06-02T10:00:00Z" },
				end: { dateTime: "2025-06-02T11:00:00Z" },
			})
		);

		await updateEvent({
			eventId: "evt99",
			start: "2025-06-02T10:00:00Z",
			end: "2025-06-02T11:00:00Z",
		});

		const body = JSON.parse(fetchCalls[0].init.body as string);
		expect(body.start.dateTime).toBe("2025-06-02T10:00:00Z");
		expect(body.end.dateTime).toBe("2025-06-02T11:00:00Z");
	});
});

describe("gcal — deleteEvent", () => {
	test("DELETEs the correct event URL and resolves", async () => {
		mockFetch(() => noContent());

		await expect(deleteEvent({ eventId: "evt-del" })).resolves.toBeUndefined();

		expect(fetchCalls[0].init.method).toBe("DELETE");
		expect(fetchCalls[0].url).toContain("/events/evt-del");
	});

	test("throws on non-204 error", async () => {
		mockFetch(() => textResponse("Not Found", 404));
		await expect(deleteEvent({ eventId: "ghost" })).rejects.toThrow("404");
	});
});

// ═══════════════════════════════════════════════════════════════════════════════
// lib/gdocs.ts
// ═══════════════════════════════════════════════════════════════════════════════

describe("gdocs — createDoc", () => {
	test("POSTs to Docs API to create an empty document first", async () => {
		let callCount = 0;
		mockFetch((url) => {
			callCount++;
			if (url === "https://docs.googleapis.com/v1/documents") {
				return jsonResponse({ documentId: "doc-abc", title: "My Doc" });
			}
			// batchUpdate
			return jsonResponse({});
		});

		await createDoc("My Doc", "Hello world");

		// First call must be the document creation
		expect(fetchCalls[0].url).toBe("https://docs.googleapis.com/v1/documents");
		expect(fetchCalls[0].init.method).toBe("POST");
		const body = JSON.parse(fetchCalls[0].init.body as string);
		expect(body.title).toBe("My Doc");
	});

	test("calls batchUpdate with insertText request after creation", async () => {
		mockFetch((url) => {
			if (url === "https://docs.googleapis.com/v1/documents") {
				return jsonResponse({ documentId: "doc-abc", title: "My Doc" });
			}
			return jsonResponse({});
		});

		await createDoc("My Doc", "Hello world");

		const batchCall = fetchCalls.find((c) => c.url.includes(":batchUpdate"));
		expect(batchCall).toBeDefined();
		expect(batchCall!.init.method).toBe("POST");
		const body = JSON.parse(batchCall!.init.body as string);
		expect(body.requests[0].insertText.text).toBe("Hello world\n");
		expect(body.requests[0].insertText.location.index).toBe(1);
	});

	test("skips batchUpdate for empty/whitespace content", async () => {
		mockFetch(() => jsonResponse({ documentId: "doc-empty", title: "Empty" }));

		await createDoc("Empty", "   ");

		const batchCall = fetchCalls.find((c) => c.url.includes(":batchUpdate"));
		expect(batchCall).toBeUndefined();
	});

	test("returns correct DocResult shape", async () => {
		mockFetch((url) => {
			if (url === "https://docs.googleapis.com/v1/documents") {
				return jsonResponse({ documentId: "doc-xyz", title: "Report" });
			}
			return jsonResponse({});
		});

		const result = await createDoc("Report", "content");
		expect(result.docId).toBe("doc-xyz");
		expect(result.docUrl).toBe("https://docs.google.com/document/d/doc-xyz/edit");
		expect(result.name).toBe("Report");
	});

	test("moves doc to folder when folderId is provided", async () => {
		mockFetch((url) => {
			if (url === "https://docs.googleapis.com/v1/documents") {
				return jsonResponse({ documentId: "doc-fold", title: "Foldered" });
			}
			if (url.includes(":batchUpdate")) return jsonResponse({});
			if (url.includes("fields=parents")) {
				return jsonResponse({ parents: ["root-folder"] });
			}
			// PATCH move
			return jsonResponse({ id: "doc-fold" });
		});

		await createDoc("Foldered", "text", "target-folder-id");

		const patchCall = fetchCalls.find((c) => c.init.method === "PATCH");
		expect(patchCall).toBeDefined();
		expect(patchCall!.url).toContain("addParents=target-folder-id");
		expect(patchCall!.url).toContain("removeParents=root-folder");
	});

	test("sends Authorization header", async () => {
		mockFetch((url) => {
			if (url === "https://docs.googleapis.com/v1/documents") {
				return jsonResponse({ documentId: "doc-auth", title: "Auth Test" });
			}
			return jsonResponse({});
		});

		await createDoc("Auth Test", "body text");

		const headers = fetchCalls[0].init.headers as Record<string, string>;
		expect(headers["Authorization"]).toBe(`Bearer ${FAKE_TOKEN}`);
	});
});

describe("gdocs — getDoc", () => {
	test("GETs the correct Docs API URL by docId", async () => {
		const fakeDoc = { documentId: "doc-123", title: "My Doc", body: {} };
		mockFetch(() => jsonResponse(fakeDoc));

		await getDoc("doc-123");

		expect(fetchCalls).toHaveLength(1);
		expect(fetchCalls[0].url).toBe("https://docs.googleapis.com/v1/documents/doc-123");
		expect(fetchCalls[0].init.method).toBe("GET");
	});

	test("returns the raw API response", async () => {
		const fakeDoc = { documentId: "doc-123", title: "Test", body: { content: [] } };
		mockFetch(() => jsonResponse(fakeDoc));

		const result = await getDoc("doc-123");
		expect(result).toEqual(fakeDoc);
	});

	test("throws on API error", async () => {
		mockFetch(() => textResponse("Not Found", 404));
		await expect(getDoc("missing-id")).rejects.toThrow("404");
	});
});

// ═══════════════════════════════════════════════════════════════════════════════
// lib/gdrive.ts
// ═══════════════════════════════════════════════════════════════════════════════

describe("gdrive — searchFiles", () => {
	test("builds correct query params", async () => {
		mockFetch(() => jsonResponse({ files: [] }));

		await searchFiles("name contains 'budget'");

		expect(fetchCalls).toHaveLength(1);
		const url = new URL(fetchCalls[0].url);
		expect(url.origin + url.pathname).toBe("https://www.googleapis.com/drive/v3/files");
		expect(url.searchParams.get("q")).toBe("name contains 'budget'");
		expect(url.searchParams.get("orderBy")).toBe("modifiedTime desc");
		expect(url.searchParams.get("fields")).toContain("id");
		expect(url.searchParams.get("fields")).toContain("name");
	});

	test("respects maxResults (capped at 100)", async () => {
		mockFetch(() => jsonResponse({ files: [] }));

		await searchFiles("test", 200);

		const url = new URL(fetchCalls[0].url);
		expect(url.searchParams.get("pageSize")).toBe("100");
	});

	test("uses provided maxResults when under 100", async () => {
		mockFetch(() => jsonResponse({ files: [] }));

		await searchFiles("test", 5);

		const url = new URL(fetchCalls[0].url);
		expect(url.searchParams.get("pageSize")).toBe("5");
	});

	test("sends Authorization header", async () => {
		mockFetch(() => jsonResponse({ files: [] }));

		await searchFiles("anything");

		const headers = fetchCalls[0].init.headers as Record<string, string>;
		expect(headers["Authorization"]).toBe(`Bearer ${FAKE_TOKEN}`);
	});

	test("normalizes returned files", async () => {
		mockFetch(() =>
			jsonResponse({
				files: [
					{
						id: "f1",
						name: "budget.xlsx",
						mimeType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
						modifiedTime: "2025-05-01T12:00:00Z",
						webViewLink: "https://drive.google.com/file/d/f1",
						size: "12345",
					},
				],
			})
		);

		const files = await searchFiles("budget");
		expect(files).toHaveLength(1);
		expect(files[0]).toEqual({
			id: "f1",
			name: "budget.xlsx",
			mimeType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
			modifiedTime: "2025-05-01T12:00:00Z",
			webViewLink: "https://drive.google.com/file/d/f1",
			size: "12345",
		});
	});

	test("throws on API error", async () => {
		mockFetch(() => textResponse("Forbidden", 403));
		await expect(searchFiles("test")).rejects.toThrow("403");
	});
});

describe("gdrive — getFile", () => {
	test("GETs the correct file metadata URL", async () => {
		mockFetch(() =>
			jsonResponse({
				id: "file-abc",
				name: "notes.txt",
				mimeType: "text/plain",
				modifiedTime: "2025-01-01T00:00:00Z",
			})
		);

		await getFile("file-abc");

		expect(fetchCalls).toHaveLength(1);
		const url = new URL(fetchCalls[0].url);
		expect(url.pathname).toBe("/drive/v3/files/file-abc");
		expect(url.searchParams.get("fields")).toContain("id");
		expect(url.searchParams.get("fields")).toContain("mimeType");
	});

	test("returns normalized DriveFile", async () => {
		mockFetch(() =>
			jsonResponse({
				id: "file-abc",
				name: "notes.txt",
				mimeType: "text/plain",
				modifiedTime: "2025-01-01T00:00:00Z",
			})
		);

		const file = await getFile("file-abc");
		expect(file.id).toBe("file-abc");
		expect(file.name).toBe("notes.txt");
		expect(file.mimeType).toBe("text/plain");
	});

	test("throws on 404", async () => {
		mockFetch(() => textResponse("Not Found", 404));
		await expect(getFile("ghost-file")).rejects.toThrow("404");
	});
});

describe("gdrive — downloadFile", () => {
	test("uses export endpoint for Google Docs files", async () => {
		let callCount = 0;
		mockFetch((url) => {
			callCount++;
			if (callCount === 1) {
				// getFile call
				return jsonResponse({
					id: "gdoc-id",
					name: "My Doc",
					mimeType: "application/vnd.google-apps.document",
					modifiedTime: "2025-01-01T00:00:00Z",
				});
			}
			// export call
			return textResponse("Exported plain text content");
		});

		const content = await downloadFile("gdoc-id");

		// Second call should be the export URL
		const exportCall = fetchCalls[1];
		const url = new URL(exportCall.url);
		expect(url.pathname).toContain("/export");
		expect(url.searchParams.get("mimeType")).toBe("text/plain");
		expect(content).toBe("Exported plain text content");
	});

	test("uses export with text/csv for Sheets", async () => {
		mockFetch((url, _init) => {
			if (fetchCalls.length === 1) {
				return jsonResponse({
					id: "sheet-id",
					name: "Budget",
					mimeType: "application/vnd.google-apps.spreadsheet",
					modifiedTime: "2025-01-01T00:00:00Z",
				});
			}
			return textResponse("col1,col2\n1,2");
		});

		await downloadFile("sheet-id");

		const exportCall = fetchCalls[1];
		const url = new URL(exportCall.url);
		expect(url.searchParams.get("mimeType")).toBe("text/csv");
	});

	test("uses alt=media for binary/non-workspace files", async () => {
		mockFetch(() => {
			if (fetchCalls.length === 1) {
				return jsonResponse({
					id: "txt-file",
					name: "readme.txt",
					mimeType: "text/plain",
					modifiedTime: "2025-01-01T00:00:00Z",
				});
			}
			return textResponse("file contents here");
		});

		const content = await downloadFile("txt-file");

		const downloadCall = fetchCalls[1];
		const url = new URL(downloadCall.url);
		expect(url.searchParams.get("alt")).toBe("media");
		expect(content).toBe("file contents here");
	});

	test("throws on download failure", async () => {
		mockFetch(() => {
			if (fetchCalls.length === 1) {
				return jsonResponse({
					id: "bad-file",
					name: "bad.txt",
					mimeType: "text/plain",
					modifiedTime: "2025-01-01T00:00:00Z",
				});
			}
			return textResponse("Server Error", 500);
		});

		await expect(downloadFile("bad-file")).rejects.toThrow("500");
	});
});

describe("gdrive — uploadFile", () => {
	test("POSTs to the upload endpoint with multipart content type", async () => {
		mockFetch(() =>
			jsonResponse({
				id: "uploaded-id",
				name: "report.txt",
				mimeType: "text/plain",
				modifiedTime: "2025-06-01T00:00:00Z",
			})
		);

		await uploadFile("report.txt", "File content here");

		expect(fetchCalls).toHaveLength(1);
		const url = new URL(fetchCalls[0].url);
		expect(url.origin + url.pathname).toBe("https://www.googleapis.com/upload/drive/v3/files");
		expect(url.searchParams.get("uploadType")).toBe("multipart");

		const headers = fetchCalls[0].init.headers as Record<string, string>;
		expect(headers["Content-Type"]).toContain("multipart/related");
		expect(headers["Authorization"]).toBe(`Bearer ${FAKE_TOKEN}`);
	});

	test("includes folderId in metadata when provided", async () => {
		mockFetch(() =>
			jsonResponse({
				id: "u2",
				name: "file.txt",
				mimeType: "text/plain",
				modifiedTime: "2025-06-01T00:00:00Z",
			})
		);

		await uploadFile("file.txt", "content", "folder-123");

		const body = fetchCalls[0].init.body as string;
		expect(body).toContain("folder-123");
		// metadata JSON should contain parents array
		const metaMatch = body.match(/\{.*?\}/s);
		expect(metaMatch).not.toBeNull();
		const meta = JSON.parse(metaMatch![0]);
		expect(meta.parents).toEqual(["folder-123"]);
	});

	test("returns normalized DriveFile", async () => {
		mockFetch(() =>
			jsonResponse({
				id: "u3",
				name: "data.json",
				mimeType: "application/json",
				modifiedTime: "2025-06-01T12:00:00Z",
				size: "500",
			})
		);

		const file = await uploadFile("data.json", "{}", undefined, "application/json");
		expect(file.id).toBe("u3");
		expect(file.name).toBe("data.json");
		expect(file.size).toBe("500");
	});

	test("throws on upload failure", async () => {
		mockFetch(() => textResponse("Quota Exceeded", 429));
		await expect(uploadFile("fail.txt", "content")).rejects.toThrow("429");
	});
});
