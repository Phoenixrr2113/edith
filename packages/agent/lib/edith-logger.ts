/**
 * Unified Edith logger — replaces Langfuse, Sentry, and BetterStack wrapper.
 *
 * Every log entry captures:
 *   - Timestamp, level, event type
 *   - Caller info (function name, file, line) via stack trace parsing
 *   - Full stack trace for errors
 *   - Structured data fields
 *
 * Writes to events.jsonl (local) + optional BetterStack/Logtail (remote).
 * Queryable via the MCP query_logs tool.
 */
import { appendFileSync, existsSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { basename, relative } from "node:path";
import { Logtail } from "@logtail/node";
import { EVENTS_FILE, EVENTS_MAX_AGE_MS, IS_CLOUD } from "./config";

// --- BetterStack / Logtail (optional remote sink) ---
const bsToken = process.env.BETTERSTACK_SOURCE_TOKEN;
const heartbeatUrl = process.env.BETTERSTACK_HEARTBEAT_URL;
const logtail = bsToken ? new Logtail(bsToken) : null;
const EDITH_MODE = IS_CLOUD ? "cloud" : "local";

/** Skip file/remote writes during tests to avoid polluting production events.jsonl. */
function isTestEnv(): boolean {
	return process.env.NODE_ENV === "test";
}

// --- Types ---
export type LogLevel = "trace" | "debug" | "info" | "warn" | "error" | "fatal";

export interface CallerInfo {
	fn: string;
	file: string;
	line: number;
}

export interface LogEntry {
	ts: string;
	type: string;
	level: LogLevel;
	message?: string;
	caller: CallerInfo;
	stackTrace?: string;
	[key: string]: unknown;
}

// --- Stack trace parsing ---
// Bun/V8 stack frame: "    at functionName (/abs/path/file.ts:line:col)"
// or:                 "    at /abs/path/file.ts:line:col"
const FRAME_RE = /at\s+(?:(.+?)\s+)?\(?(.+?):(\d+):\d+\)?/;
const PROJECT_ROOT = new URL("../../", import.meta.url).pathname.replace(/\/$/, "");

/**
 * Parse the call stack to find the actual caller.
 * Walks up the stack past edith-logger internals to find the first external frame.
 */
function getCaller(_depth = 3): CallerInfo {
	const stack = new Error().stack;
	if (!stack) return { fn: "unknown", file: "unknown", line: 0 };

	const lines = stack.split("\n");

	// Walk past the "Error" line and any frames inside edith-logger.ts
	for (let i = 1; i < lines.length; i++) {
		const line = lines[i];
		if (!line || line.includes("edith-logger")) continue;

		const match = FRAME_RE.exec(line);
		if (!match) continue;

		const fn = match[1] ?? "<anonymous>";
		const absPath = match[2] ?? "unknown";
		const lineNum = Number.parseInt(match[3] ?? "0", 10);

		// Make path relative to project root for readability
		const file = absPath.startsWith(PROJECT_ROOT)
			? relative(PROJECT_ROOT, absPath)
			: basename(absPath);

		return { fn, file, line: lineNum };
	}

	return { fn: "unknown", file: "unknown", line: 0 };
}

// --- Core write ---
function writeEvent(entry: LogEntry): void {
	// Skip file and remote writes during tests
	if (isTestEnv()) return;

	// Write to local events.jsonl
	try {
		appendFileSync(EVENTS_FILE, `${JSON.stringify(entry)}\n`, "utf-8");
	} catch {}

	// Ship to BetterStack if configured
	if (logtail) {
		try {
			const { level } = entry;
			// Add runtime context so BetterStack doesn't show "undefined"
			const ctx = {
				...entry,
				mode: EDITH_MODE,
				context: {
					runtime: {
						type: "edith-agent",
						mode: EDITH_MODE,
						file: entry.caller.file,
						function: entry.caller.fn,
						line: entry.caller.line,
					},
				},
			} as Record<string, unknown>;
			if (level === "error" || level === "fatal") {
				logtail.error(entry.message ?? entry.type, ctx);
			} else if (level === "warn") {
				logtail.warn(entry.message ?? entry.type, ctx);
			} else {
				logtail.info(entry.message ?? entry.type, ctx);
			}
		} catch {}
	}
}

// --- Public API ---
function log(
	level: LogLevel,
	type: string,
	data: Record<string, unknown> = {},
	_callerDepth = 4 // Deprecated — getCaller now auto-walks past logger frames
): void {
	const caller = getCaller();
	const { message, stackTrace, ...rest } = data;

	const entry: LogEntry = {
		ts: new Date().toISOString(),
		type,
		level,
		caller,
		...rest,
	};

	if (message) entry.message = String(message);
	if (stackTrace) entry.stackTrace = String(stackTrace);

	// For errors, auto-capture stack trace if not provided
	if ((level === "error" || level === "fatal") && !entry.stackTrace) {
		const err = Object.values(data).find((v) => v instanceof Error);
		if (err instanceof Error && err.stack) {
			entry.stackTrace = err.stack;
		} else {
			entry.stackTrace = new Error("edith-logger:stack-capture").stack ?? "";
		}
	}

	writeEvent(entry);
}

export const edithLog = {
	trace(type: string, data?: Record<string, unknown>) {
		log("trace", type, data, 4);
	},
	debug(type: string, data?: Record<string, unknown>) {
		log("debug", type, data, 4);
	},
	info(type: string, data?: Record<string, unknown>) {
		log("info", type, data, 4);
	},
	warn(type: string, data?: Record<string, unknown>) {
		log("warn", type, data, 4);
	},
	error(type: string, data?: Record<string, unknown>) {
		log("error", type, data, 4);
	},
	fatal(type: string, data?: Record<string, unknown>) {
		log("fatal", type, data, 4);
	},

	/**
	 * Backward-compatible alias for logEvent() — same signature, adds caller + level.
	 * All existing logEvent() call sites can use this without changes.
	 */
	// biome-ignore lint/suspicious/noExplicitAny: logEvent data values are untyped
	event(type: string, data: Record<string, any> = {}) {
		// Default to "info" unless it looks like an error
		const level: LogLevel =
			type.includes("error") || type.includes("circuit_breaker")
				? "error"
				: type.includes("warn") || type.includes("poll_error")
					? "warn"
					: "info";
		log(level, type, data, 4);
	},

	/** Flush buffered logs to BetterStack. */
	async flush() {
		try {
			await logtail?.flush();
		} catch {}
	},
};

/** Ping BetterStack heartbeat endpoint. */
export async function pingHeartbeat() {
	if (!heartbeatUrl) return;
	try {
		await fetch(heartbeatUrl, { method: "HEAD" });
	} catch {}
}

/** Rotate events.jsonl — keep last 48h when file > 1MB. */
export function rotateEvents(): void {
	if (!existsSync(EVENTS_FILE)) return;
	try {
		const stat = statSync(EVENTS_FILE);
		if (stat.size < 1_000_000) return;
		const lines = readFileSync(EVENTS_FILE, "utf-8").split("\n").filter(Boolean);
		const cutoff = Date.now() - EVENTS_MAX_AGE_MS;
		const recent = lines.filter((line) => {
			try {
				return new Date(JSON.parse(line).ts).getTime() > cutoff;
			} catch {
				return false;
			}
		});
		writeFileSync(EVENTS_FILE, `${recent.join("\n")}\n`, "utf-8");
	} catch {}
}

/**
 * Read events from events.jsonl with filters — used by MCP query tool.
 */
export interface LogQuery {
	type?: string; // exact match or comma-separated list
	level?: LogLevel; // minimum level
	timeRange?: string; // "last_hour", "last_6h", "last_24h", "last_48h", or "start,end" ISO
	caller?: string; // substring match on function name
	search?: string; // full-text search across all fields
	limit?: number;
	offset?: number;
	aggregate?:
		| "count_by_type"
		| "count_by_level"
		| "error_summary"
		| "top_callers"
		| "hourly_volume";
}

const LEVEL_ORDER: Record<string, number> = {
	trace: 0,
	debug: 1,
	info: 2,
	warn: 3,
	error: 4,
	fatal: 5,
};

export function queryEvents(q: LogQuery): unknown {
	if (!existsSync(EVENTS_FILE)) return { events: [], total: 0 };

	const lines = readFileSync(EVENTS_FILE, "utf-8").split("\n").filter(Boolean);
	let events: Record<string, unknown>[] = [];

	// Parse all events
	for (const line of lines) {
		try {
			events.push(JSON.parse(line));
		} catch {}
	}

	// Time filter
	if (q.timeRange) {
		const now = Date.now();
		let startMs = 0;
		let endMs = now;

		switch (q.timeRange) {
			case "last_hour":
				startMs = now - 3_600_000;
				break;
			case "last_6h":
				startMs = now - 21_600_000;
				break;
			case "last_24h":
				startMs = now - 86_400_000;
				break;
			case "last_48h":
				startMs = now - 172_800_000;
				break;
			default: {
				const [s, e] = q.timeRange.split(",");
				if (s) startMs = new Date(s).getTime();
				if (e) endMs = new Date(e).getTime();
			}
		}

		events = events.filter((e) => {
			const t = new Date(e.ts as string).getTime();
			return t >= startMs && t <= endMs;
		});
	}

	// Type filter
	if (q.type) {
		const types = new Set(q.type.split(",").map((t) => t.trim()));
		events = events.filter((e) => types.has(e.type as string));
	}

	// Level filter (minimum)
	if (q.level) {
		const minLevel = LEVEL_ORDER[q.level] ?? 0;
		events = events.filter((e) => {
			const lvl = LEVEL_ORDER[e.level as string] ?? 2; // default to "info"
			return lvl >= minLevel;
		});
	}

	// Caller filter
	if (q.caller) {
		const needle = q.caller.toLowerCase();
		events = events.filter((e) => {
			const caller = e.caller as { fn?: string } | undefined;
			return caller?.fn?.toLowerCase().includes(needle);
		});
	}

	// Full-text search
	if (q.search) {
		const needle = q.search.toLowerCase();
		events = events.filter((e) => JSON.stringify(e).toLowerCase().includes(needle));
	}

	// Aggregations
	if (q.aggregate) {
		return runAggregation(q.aggregate, events);
	}

	// Paginate (most recent first)
	const total = events.length;
	events.reverse();
	const start = q.offset ?? 0;
	const limit = q.limit ?? 50;
	const page = events.slice(start, start + limit);

	return { events: page, total, offset: start, limit };
}

function runAggregation(mode: string, events: Record<string, unknown>[]): unknown {
	switch (mode) {
		case "count_by_type": {
			const counts: Record<string, number> = {};
			for (const e of events) {
				const t = e.type as string;
				counts[t] = (counts[t] ?? 0) + 1;
			}
			return { aggregation: mode, data: counts, total: events.length };
		}

		case "count_by_level": {
			const counts: Record<string, number> = {};
			for (const e of events) {
				const l = (e.level as string) ?? "info";
				counts[l] = (counts[l] ?? 0) + 1;
			}
			return { aggregation: mode, data: counts, total: events.length };
		}

		case "error_summary": {
			const errors = events.filter(
				(e) => e.level === "error" || e.level === "fatal" || (e.type as string)?.includes("error")
			);
			const byCaller: Record<string, { count: number; lastSeen: string; types: Set<string> }> = {};
			for (const e of errors) {
				const caller = (e.caller as { fn?: string })?.fn ?? "unknown";
				if (!byCaller[caller]) byCaller[caller] = { count: 0, lastSeen: "", types: new Set() };
				byCaller[caller].count++;
				byCaller[caller].lastSeen = e.ts as string;
				byCaller[caller].types.add(e.type as string);
			}
			const data = Object.entries(byCaller)
				.map(([fn, info]) => ({
					fn,
					count: info.count,
					lastSeen: info.lastSeen,
					types: [...info.types],
				}))
				.sort((a, b) => b.count - a.count);
			return { aggregation: mode, data, totalErrors: errors.length };
		}

		case "top_callers": {
			const counts: Record<string, number> = {};
			for (const e of events) {
				const fn = (e.caller as { fn?: string })?.fn ?? "unknown";
				counts[fn] = (counts[fn] ?? 0) + 1;
			}
			const data = Object.entries(counts)
				.map(([fn, count]) => ({ fn, count }))
				.sort((a, b) => b.count - a.count)
				.slice(0, 20);
			return { aggregation: mode, data, total: events.length };
		}

		case "hourly_volume": {
			const buckets: Record<string, number> = {};
			for (const e of events) {
				const hour = (e.ts as string).slice(0, 13); // "2026-03-31T14"
				buckets[hour] = (buckets[hour] ?? 0) + 1;
			}
			const data = Object.entries(buckets)
				.map(([hour, count]) => ({ hour, count }))
				.sort((a, b) => a.hour.localeCompare(b.hour));
			return { aggregation: mode, data, total: events.length };
		}

		default:
			return { error: `Unknown aggregation: ${mode}` };
	}
}
