/**
 * Edith Dashboard — status monitor with live logs, task triggers, and transcript viewer.
 * Serves at http://localhost:3456
 */
import {
	closeSync,
	existsSync,
	mkdirSync,
	openSync,
	readdirSync,
	readFileSync,
	readSync,
	statSync,
	writeFileSync,
} from "node:fs";
import { basename, join } from "node:path";
import { STATE_DIR } from "./lib/config";
import { getEventStats, getSystemStatus, readEventsFile } from "./lib/dashboard-data";
import { getEvents } from "./lib/gcal";

const PORT = Number(process.env.DASHBOARD_PORT ?? 3456);
const TRIGGERS_DIR = join(STATE_DIR, "triggers");
const TRANSCRIPTS_DIR = join(STATE_DIR, "transcripts");

// Ensure triggers dir exists
if (!existsSync(TRIGGERS_DIR)) mkdirSync(TRIGGERS_DIR, { recursive: true });

const DASHBOARD_HTML = readFileSync(join(import.meta.dir, "dashboard.html"), "utf-8");

function readJsonFile(path: string): any {
	if (!existsSync(path)) return null;
	try {
		return JSON.parse(readFileSync(path, "utf-8"));
	} catch {
		return null;
	}
}

function readTextFile(path: string): string {
	if (!existsSync(path)) return "";
	try {
		return readFileSync(path, "utf-8");
	} catch {
		return "";
	}
}

function listTranscripts(limit = 20): { name: string; size: number; modified: string }[] {
	if (!existsSync(TRANSCRIPTS_DIR)) return [];
	try {
		return readdirSync(TRANSCRIPTS_DIR)
			.filter((f) => f.endsWith(".jsonl"))
			.map((f) => {
				const fp = join(TRANSCRIPTS_DIR, f);
				const st = statSync(fp);
				return { name: f, size: st.size, modified: st.mtime.toISOString() };
			})
			.sort((a, b) => b.modified.localeCompare(a.modified))
			.slice(0, limit);
	} catch {
		return [];
	}
}

function readTranscript(name: string): any[] {
	const safeName = basename(name);
	const fp = join(TRANSCRIPTS_DIR, safeName);
	if (!existsSync(fp)) return [];
	try {
		return readFileSync(fp, "utf-8")
			.split("\n")
			.filter(Boolean)
			.map((l) => {
				try {
					return JSON.parse(l);
				} catch {
					return null;
				}
			})
			.filter(Boolean);
	} catch {
		return [];
	}
}

// --- SSE log streaming ---
let logFileSize = 0;
const LOG_FILE = join(STATE_DIR, "edith.log");

function getNewLogLines(): string[] {
	if (!existsSync(LOG_FILE)) return [];
	try {
		const st = statSync(LOG_FILE);
		if (st.size <= logFileSize) {
			if (st.size < logFileSize) logFileSize = 0; // file was rotated
			return [];
		}
		const fd = openSync(LOG_FILE, "r");
		const bytesToRead = st.size - logFileSize;
		const buf = Buffer.alloc(bytesToRead);
		readSync(fd, buf, 0, bytesToRead, logFileSize);
		closeSync(fd);
		logFileSize = st.size;
		return buf.toString("utf-8").split("\n").filter(Boolean);
	} catch {
		return [];
	}
}

// Initialize log file position to end
try {
	if (existsSync(LOG_FILE)) logFileSize = statSync(LOG_FILE).size;
} catch {}

// --- handlePost helper ---
async function handlePost<T>(
	req: Request,
	handler: (body: T) => Promise<Response> | Response
): Promise<Response> {
	try {
		const body = (await req.json()) as T;
		return await handler(body);
	} catch (err) {
		return Response.json({ ok: false, error: String(err) }, { status: 500 });
	}
}

// --- Route map ---
type RouteHandler = (req: Request, url: URL) => Promise<Response> | Response;

const routes: Record<string, RouteHandler> = {
	"/": () => new Response(DASHBOARD_HTML, { headers: { "Content-Type": "text/html" } }),
	"/index.html": () => new Response(DASHBOARD_HTML, { headers: { "Content-Type": "text/html" } }),

	"/api/status": async () => Response.json(await getSystemStatus()),

	"/api/events": (_req, url) => {
		const limit = Number(url.searchParams.get("limit") ?? 100);
		const events = readEventsFile(limit);
		return Response.json({ events, stats: getEventStats(events) });
	},

	"/api/taskboard": () =>
		new Response(readTextFile(join(STATE_DIR, "taskboard.md")), {
			headers: { "Content-Type": "text/plain" },
		}),

	"/api/schedule": () =>
		Response.json({
			schedule: readJsonFile(join(STATE_DIR, "schedule.json")) ?? [],
			state: readJsonFile(join(STATE_DIR, "schedule-state.json")) ?? {},
		}),

	"/api/trigger": (req) => {
		if (req.method !== "POST") return new Response("Method not allowed", { status: 405 });
		return handlePost<{ task: string }>(req, ({ task }) => {
			if (!task) return Response.json({ ok: false, error: "missing task" }, { status: 400 });
			const safeName = basename(task);
			if (!safeName || safeName === "." || safeName === "..")
				return Response.json({ ok: false, error: "invalid task" }, { status: 400 });
			writeFileSync(join(TRIGGERS_DIR, safeName), new Date().toISOString(), "utf-8");
			return Response.json({ ok: true, task });
		});
	},

	"/api/logs/stream": () => {
		let ctrl: ReadableStreamDefaultController;
		const stream = new ReadableStream({
			start(controller) {
				ctrl = controller;
				sseClients.add(controller);
				controller.enqueue("data: [connected to log stream]\n\n");
			},
			cancel() {
				sseClients.delete(ctrl);
			},
		});
		return new Response(stream, {
			headers: {
				"Content-Type": "text/event-stream",
				"Cache-Control": "no-cache",
				Connection: "keep-alive",
			},
		});
	},

	"/api/transcripts": () => Response.json(listTranscripts()),

	"/api/message": (req) => {
		if (req.method !== "POST") return new Response("Method not allowed", { status: 405 });
		return handlePost<{ text: string }>(req, ({ text }) => {
			if (!text?.trim())
				return Response.json({ ok: false, error: "empty message" }, { status: 400 });
			if (Buffer.byteLength(text, "utf-8") > 10 * 1024)
				return Response.json({ ok: false, error: "message too large" }, { status: 413 });
			const inboxDir = join(STATE_DIR, "inbox");
			mkdirSync(inboxDir, { recursive: true });
			const filename = `dashboard-${Date.now()}.json`;
			writeFileSync(
				join(inboxDir, filename),
				JSON.stringify({
					source: "dashboard",
					text: text.trim(),
					ts: new Date().toISOString(),
				}),
				"utf-8"
			);
			return Response.json({ ok: true });
		});
	},

	"/api/proactive/toggle": (req) => {
		if (req.method !== "POST") return new Response("Method not allowed", { status: 405 });
		try {
			const stateFile = join(STATE_DIR, "proactive-config.json");
			const config = readJsonFile(stateFile) ?? { enabled: true };
			config.enabled = !config.enabled;
			writeFileSync(stateFile, JSON.stringify(config, null, 2), "utf-8");
			return Response.json({ ok: true, enabled: config.enabled });
		} catch (err) {
			return Response.json({ ok: false, error: String(err) }, { status: 500 });
		}
	},

	"/api/proactive/config": () => {
		const config = readJsonFile(join(STATE_DIR, "proactive-config.json")) ?? { enabled: true };
		return Response.json(config);
	},

	"/api/reminders": () => Response.json(readJsonFile(join(STATE_DIR, "reminders.json")) ?? []),

	"/api/upcoming": async () => {
		// Calendar events for the next 12 hours
		let calendarEvents: any[] = [];
		try {
			const timeMax = new Date(Date.now() + 12 * 60 * 60 * 1000).toISOString();
			calendarEvents = await getEvents({ timeMax, includeAllDay: true });
		} catch {}

		// Unfired reminders
		const reminders = (readJsonFile(join(STATE_DIR, "reminders.json")) ?? []).filter(
			(r: any) => !r.fired
		);

		return Response.json({ calendar: calendarEvents, reminders });
	},
};

// --- Server ---
const sseClients = new Set<ReadableStreamDefaultController>();

// Poll log file for new lines and push to SSE clients
setInterval(() => {
	const lines = getNewLogLines();
	if (lines.length === 0 || sseClients.size === 0) return;
	for (const line of lines) {
		// SSE requires each line prefixed with "data: "; escape internal newlines
		const data = `${line
			.split("\n")
			.map((l) => `data: ${l}`)
			.join("\n")}\n\n`;
		for (const controller of sseClients) {
			try {
				controller.enqueue(data);
			} catch {
				sseClients.delete(controller);
			}
		}
	}
}, 1000);

const _server = Bun.serve({
	port: PORT,
	hostname: "127.0.0.1",
	idleTimeout: 120, // SSE connections can be long-lived
	async fetch(req) {
		const url = new URL(req.url);

		// Static route lookup
		const handler = routes[url.pathname];
		if (handler) return handler(req, url);

		// Dynamic route: /api/transcripts/:name
		if (url.pathname.startsWith("/api/transcripts/")) {
			const name = decodeURIComponent(url.pathname.slice("/api/transcripts/".length));
			return Response.json(readTranscript(name));
		}

		return new Response("Not found", { status: 404 });
	},
});

console.log(`[dashboard] Edith Dashboard running at http://localhost:${PORT}`);
