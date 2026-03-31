/**
 * Direct Google Calendar REST API client.
 *
 * Uses fetch() only — no googleapis SDK.
 * Auth via lib/google-auth.ts (env-based OAuth2, no SQLite dependency here).
 *
 * Default calendar: randyrowanwilson@gmail.com
 */

import { getAccessToken } from "./google-auth";

// ── Constants ─────────────────────────────────────────────────────────────────

const BASE = "https://www.googleapis.com/calendar/v3/calendars";
const DEFAULT_CALENDAR = "randyrowanwilson@gmail.com";

// ── Types ─────────────────────────────────────────────────────────────────────

export interface CalendarEvent {
	id: string;
	summary: string;
	start: string; // ISO 8601 or date string (all-day: "2025-01-01")
	end: string;
	location?: string;
	description?: string;
}

// Internal Google API event shape (subset we use)
interface GCalEvent {
	id?: string;
	summary?: string;
	description?: string;
	location?: string;
	start?: { dateTime?: string; date?: string; timeZone?: string };
	end?: { dateTime?: string; date?: string; timeZone?: string };
	status?: string;
}

// ── Helpers ───────────────────────────────────────────────────────────────────

async function authHeaders(): Promise<Record<string, string>> {
	const token = await getAccessToken();
	return {
		Authorization: `Bearer ${token}`,
		"Content-Type": "application/json",
	};
}

function calendarUrl(calendarId: string, ...segments: string[]): string {
	const encoded = encodeURIComponent(calendarId);
	return [BASE, encoded, "events", ...segments].join("/").replace(/\/+$/, "");
}

function normalizeEvent(e: GCalEvent): CalendarEvent {
	const start = e.start?.dateTime ?? e.start?.date ?? "";
	const end = e.end?.dateTime ?? e.end?.date ?? "";
	return {
		id: e.id ?? "",
		summary: e.summary ?? "(no title)",
		start,
		end,
		...(e.location ? { location: e.location } : {}),
		...(e.description ? { description: e.description } : {}),
	};
}

async function gcalFetch<T>(url: string, init: RequestInit): Promise<T> {
	const res = await fetch(url, init);
	if (!res.ok) {
		const body = await res.text();
		throw new Error(`Google Calendar API error (${res.status}): ${body}`);
	}
	// 204 No Content (delete)
	if (res.status === 204) return undefined as unknown as T;
	return res.json() as Promise<T>;
}

// ── Public API ────────────────────────────────────────────────────────────────

export interface GetEventsOptions {
	calendarId?: string;
	/** ISO 8601 — start of window. Default: now */
	timeMin?: string;
	/** ISO 8601 — end of window. Default: now + 24h */
	timeMax?: string;
	/** Max events to return. Default: 50 */
	maxResults?: number;
	/** Include all-day events. Default: true */
	includeAllDay?: boolean;
}

/**
 * List events within a time window.
 * Computed from hoursAhead/hoursBehind by the caller (see manage_calendar).
 */
export async function getEvents(options: GetEventsOptions = {}): Promise<CalendarEvent[]> {
	const {
		calendarId = DEFAULT_CALENDAR,
		timeMin = new Date().toISOString(),
		timeMax = new Date(Date.now() + 24 * 3600_000).toISOString(),
		maxResults = 50,
		includeAllDay = true,
	} = options;

	const params = new URLSearchParams({
		timeMin,
		timeMax,
		maxResults: String(maxResults),
		singleEvents: "true",
		orderBy: "startTime",
	});

	const url = `${calendarUrl(calendarId)}?${params}`;
	const headers = await authHeaders();

	const data = await gcalFetch<{ items?: GCalEvent[] }>(url, { headers });
	const items = data.items ?? [];

	return items
		.filter((e) => {
			if (!includeAllDay && e.start?.date && !e.start?.dateTime) return false;
			return true;
		})
		.map(normalizeEvent);
}

export interface CreateEventOptions {
	calendarId?: string;
	summary: string;
	start: string; // ISO 8601 datetime or date
	end?: string; // ISO 8601 datetime or date — defaults to start + 1h
	description?: string;
	location?: string;
	/** True for all-day events (uses date instead of dateTime) */
	allDay?: boolean;
}

/** Insert a new event and return the created event. */
export async function createEvent(options: CreateEventOptions): Promise<CalendarEvent> {
	const {
		calendarId = DEFAULT_CALENDAR,
		summary,
		start,
		end,
		description,
		location,
		allDay,
	} = options;

	const startDate = allDay
		? { date: start.slice(0, 10) }
		: { dateTime: start, timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone };

	const endValue = end ?? new Date(new Date(start).getTime() + 3600_000).toISOString();
	const endDate = allDay
		? { date: endValue.slice(0, 10) }
		: { dateTime: endValue, timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone };

	const body: GCalEvent = {
		summary,
		start: startDate,
		end: endDate,
		...(description ? { description } : {}),
		...(location ? { location } : {}),
	};

	const headers = await authHeaders();
	const created = await gcalFetch<GCalEvent>(calendarUrl(calendarId), {
		method: "POST",
		headers,
		body: JSON.stringify(body),
	});

	return normalizeEvent(created);
}

export interface UpdateEventOptions {
	calendarId?: string;
	eventId: string;
	summary?: string;
	start?: string;
	end?: string;
	description?: string;
	location?: string;
}

/** Patch an existing event (partial update). Returns the updated event. */
export async function updateEvent(options: UpdateEventOptions): Promise<CalendarEvent> {
	const {
		calendarId = DEFAULT_CALENDAR,
		eventId,
		summary,
		start,
		end,
		description,
		location,
	} = options;

	const body: GCalEvent = {};
	if (summary !== undefined) body.summary = summary;
	if (description !== undefined) body.description = description;
	if (location !== undefined) body.location = location;

	const tz = Intl.DateTimeFormat().resolvedOptions().timeZone;
	if (start !== undefined) body.start = { dateTime: start, timeZone: tz };
	if (end !== undefined) body.end = { dateTime: end, timeZone: tz };

	const headers = await authHeaders();
	const updated = await gcalFetch<GCalEvent>(calendarUrl(calendarId, eventId), {
		method: "PATCH",
		headers,
		body: JSON.stringify(body),
	});

	return normalizeEvent(updated);
}

export interface DeleteEventOptions {
	calendarId?: string;
	eventId: string;
}

/** Delete an event by ID. Throws on failure. */
export async function deleteEvent(options: DeleteEventOptions): Promise<void> {
	const { calendarId = DEFAULT_CALENDAR, eventId } = options;
	const headers = await authHeaders();
	await gcalFetch<void>(calendarUrl(calendarId, eventId), {
		method: "DELETE",
		headers,
	});
}
