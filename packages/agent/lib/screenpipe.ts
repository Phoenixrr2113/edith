/**
 * Screenpipe client — queries local Screenpipe instance for screen OCR + audio transcription.
 * Screenpipe runs on localhost:3030 and captures everything on screen + microphone.
 */

import { edithLog } from "./edith-logger";
import { fmtErr } from "./util";

const BASE_URL = process.env.SCREENPIPE_URL ?? "http://localhost:3030";
const TIMEOUT = 5000;
const IDLE_THRESHOLD_SECONDS = 5 * 60; // 5 minutes of no keyboard/mouse = idle

export interface ScreenContext {
	timeRange: { start: string; end: string };
	apps: AppUsage[];
	audioTranscripts: AudioTranscript[];
	continuousActivityMinutes: number; // how long without a break (gap > 5min)
	empty: boolean;
}

export interface AppUsage {
	appName: string;
	windowTitles: string[];
	durationMinutes: number;
	contentSample: string[];
}

export interface AudioTranscript {
	timestamp: string;
	text: string;
}

/**
 * Get macOS system idle time (seconds since last keyboard/mouse input).
 * Uses IOKit's HIDIdleTime which is the most reliable signal.
 */
export async function getSystemIdleSeconds(): Promise<number> {
	try {
		const proc = Bun.spawn(["ioreg", "-c", "IOHIDSystem"], { stdout: "pipe", stderr: "ignore" });
		const text = await new Response(proc.stdout).text();
		const match = text.match(/HIDIdleTime.*?(\d+)/);
		if (!match) return 0;
		return Number(match[1]) / 1_000_000_000; // nanoseconds → seconds
	} catch {
		return 0; // assume active if we can't check
	}
}

/**
 * Returns true if the user has been idle (no keyboard/mouse) for longer than threshold.
 */
export async function isUserIdle(
	thresholdSeconds: number = IDLE_THRESHOLD_SECONDS
): Promise<boolean> {
	const idle = await getSystemIdleSeconds();
	return idle >= thresholdSeconds;
}

/**
 * Check if Screenpipe is running.
 */
export async function isAvailable(): Promise<boolean> {
	try {
		const res = await fetch(`${BASE_URL}/health`, { signal: AbortSignal.timeout(TIMEOUT) });
		if (!res.ok) return false;
		const data = (await res.json()) as { status?: string };
		return data.status === "healthy" || data.status === "degraded";
	} catch {
		return false;
	}
}

/**
 * Get screen + audio context for the last N minutes.
 */
export async function getContext(minutes: number = 15): Promise<ScreenContext> {
	const now = new Date();
	const start = new Date(now.getTime() - minutes * 60 * 1000);
	const timeRange = { start: start.toISOString(), end: now.toISOString() };

	try {
		const [ocrData, audioData] = await Promise.all([
			search({ contentType: "ocr", startTime: start.toISOString(), limit: 200 }),
			search({ contentType: "audio", startTime: start.toISOString(), limit: 50 }),
		]);

		if (ocrData.length === 0 && audioData.length === 0) {
			return {
				timeRange,
				apps: [],
				audioTranscripts: [],
				continuousActivityMinutes: 0,
				empty: true,
			};
		}

		return {
			timeRange,
			apps: summarizeApps(ocrData),
			audioTranscripts: extractAudio(audioData),
			continuousActivityMinutes: measureContinuousActivity(ocrData),
			empty: false,
		};
	} catch (err) {
		edithLog.warn("screenpipe_get_context_failed", { error: fmtErr(err), timeRange });
		return { timeRange, apps: [], audioTranscripts: [], continuousActivityMinutes: 0, empty: true };
	}
}

/**
 * Format screen context as a brief string for Claude.
 */
export function formatContext(ctx: ScreenContext): string {
	if (ctx.empty) return "Screenpipe: no data available.";

	const parts: string[] = [
		`Screen context (${ctx.timeRange.start.slice(11, 16)}–${ctx.timeRange.end.slice(11, 16)}):`,
	];

	if (ctx.continuousActivityMinutes > 0) {
		parts.push(
			`**Continuous activity:** ${ctx.continuousActivityMinutes} min without a break (gap > 5 min)`
		);
	}

	if (ctx.apps.length > 0) {
		parts.push("**Active apps:**");
		for (const app of ctx.apps.slice(0, 5)) {
			const windows = app.windowTitles.slice(0, 3).join(", ");
			parts.push(`- ${app.appName} (${app.durationMinutes}min) — ${windows}`);
			if (app.contentSample.length > 0) {
				parts.push(`  Content: ${app.contentSample[0].slice(0, 150)}`);
			}
		}
	}

	if (ctx.audioTranscripts.length > 0) {
		parts.push("**Audio:**");
		for (const t of ctx.audioTranscripts.slice(0, 5)) {
			parts.push(`- ${t.timestamp.slice(11, 16)}: ${t.text.slice(0, 200)}`);
		}
	}

	return parts.join("\n");
}

// --- Internal ---

interface SearchItem {
	type: "OCR" | "Audio";
	content: {
		text?: string;
		transcription?: string;
		app_name?: string;
		window_name?: string;
		timestamp: string;
		device_type?: string;
	};
}

async function search(params: {
	contentType: "ocr" | "audio";
	startTime: string;
	limit: number;
}): Promise<SearchItem[]> {
	const qs = new URLSearchParams({
		content_type: params.contentType,
		start_time: params.startTime,
		limit: String(params.limit),
	});

	const res = await fetch(`${BASE_URL}/search?${qs}`, {
		signal: AbortSignal.timeout(TIMEOUT),
	});

	if (!res.ok) return [];
	const data = (await res.json()) as { data?: SearchItem[] };
	return data.data ?? [];
}

function summarizeApps(items: SearchItem[]): AppUsage[] {
	const appMap = new Map<
		string,
		{
			windows: Set<string>;
			content: string[];
			timestamps: Date[];
		}
	>();

	for (const item of items) {
		if (item.type !== "OCR") continue;
		const { app_name = "Unknown", window_name = "", text = "", timestamp } = item.content;

		if (!appMap.has(app_name)) {
			appMap.set(app_name, { windows: new Set(), content: [], timestamps: [] });
		}
		const app = appMap.get(app_name)!;
		if (window_name) app.windows.add(window_name);
		app.timestamps.push(new Date(timestamp));
		if (text.length > 20 && app.content.length < 5) {
			app.content.push(text.slice(0, 200));
		}
	}

	return Array.from(appMap.entries())
		.map(([appName, data]) => {
			const sorted = data.timestamps.sort((a, b) => a.getTime() - b.getTime());
			const duration =
				sorted.length > 1
					? Math.round((sorted[sorted.length - 1].getTime() - sorted[0].getTime()) / 60000)
					: 0;
			return {
				appName,
				windowTitles: Array.from(data.windows),
				durationMinutes: duration,
				contentSample: data.content,
			};
		})
		.sort((a, b) => b.durationMinutes - a.durationMinutes);
}

function extractAudio(items: SearchItem[]): AudioTranscript[] {
	return items
		.filter((i) => i.type === "Audio" && i.content.transcription?.trim())
		.map((i) => ({
			timestamp: i.content.timestamp,
			text: i.content.transcription!,
		}));
}

const BREAK_GAP_MS = 5 * 60 * 1000; // 5 min gap = a break

/**
 * Measure how long Randy has been continuously active (no gap > 5 min between frames).
 * Walks backwards from the most recent frame to find the start of the current session.
 */
function measureContinuousActivity(items: SearchItem[]): number {
	const timestamps = items
		.filter((i) => i.type === "OCR")
		.map((i) => new Date(i.content.timestamp).getTime())
		.sort((a, b) => b - a); // newest first

	if (timestamps.length < 2) return 0;

	// Walk backwards from most recent — find where the last break was
	let sessionEnd = timestamps[0];
	for (let i = 1; i < timestamps.length; i++) {
		const gap = timestamps[i - 1] - timestamps[i];
		if (gap > BREAK_GAP_MS) break; // found a break
		sessionEnd = timestamps[i]; // extend session start backwards
	}

	return Math.round((timestamps[0] - sessionEnd) / 60000);
}
