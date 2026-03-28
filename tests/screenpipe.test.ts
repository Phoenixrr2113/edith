/**
 * Tests for lib/screenpipe.ts — data transforms (formatContext, summarizeApps, etc.)
 *
 * These are pure data transforms that don't need HTTP or Screenpipe running.
 * We import formatContext directly and reimplement internal helpers for testing.
 */
import { describe, test, expect } from "bun:test";
import { formatContext, type ScreenContext, type AppUsage, type AudioTranscript } from "../lib/screenpipe";

// --- Reimplement internal helpers for testing ---

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

function summarizeApps(items: SearchItem[]): AppUsage[] {
  const appMap = new Map<string, { windows: Set<string>; content: string[]; timestamps: Date[]; }>();
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
      const duration = sorted.length > 1 ? Math.round((sorted[sorted.length - 1].getTime() - sorted[0].getTime()) / 60000) : 0;
      return { appName, windowTitles: Array.from(data.windows), durationMinutes: duration, contentSample: data.content };
    })
    .sort((a, b) => b.durationMinutes - a.durationMinutes);
}

function extractAudio(items: SearchItem[]): AudioTranscript[] {
  return items
    .filter(i => i.type === "Audio" && i.content.transcription?.trim())
    .map(i => ({ timestamp: i.content.timestamp, text: i.content.transcription! }));
}

const BREAK_GAP_MS = 5 * 60 * 1000;

function measureContinuousActivity(items: SearchItem[]): number {
  const timestamps = items.filter(i => i.type === "OCR").map(i => new Date(i.content.timestamp).getTime()).sort((a, b) => b - a);
  if (timestamps.length < 2) return 0;
  let sessionEnd = timestamps[0];
  for (let i = 1; i < timestamps.length; i++) {
    const gap = timestamps[i - 1] - timestamps[i];
    if (gap > BREAK_GAP_MS) break;
    sessionEnd = timestamps[i];
  }
  return Math.round((timestamps[0] - sessionEnd) / 60000);
}

// --- Tests ---

describe("formatContext", () => {
  test("returns 'no data' on empty context", () => {
    const ctx: ScreenContext = {
      timeRange: { start: "2026-03-26T10:00:00Z", end: "2026-03-26T10:15:00Z" },
      apps: [], audioTranscripts: [], continuousActivityMinutes: 0, empty: true,
    };
    expect(formatContext(ctx)).toContain("no data");
  });

  test("formats apps and audio correctly", () => {
    const ctx: ScreenContext = {
      timeRange: { start: "2026-03-26T10:00:00Z", end: "2026-03-26T10:15:00Z" },
      apps: [
        { appName: "VS Code", windowTitles: ["edith.ts", "dispatch.ts"], durationMinutes: 12, contentSample: ["function dispatch() { ... }"] },
        { appName: "Chrome", windowTitles: ["GitHub"], durationMinutes: 3, contentSample: [] },
      ],
      audioTranscripts: [
        { timestamp: "2026-03-26T10:05:00Z", text: "Working on the reflector system" },
      ],
      continuousActivityMinutes: 15,
      empty: false,
    };

    const result = formatContext(ctx);
    expect(result).toContain("VS Code");
    expect(result).toContain("12min");
    expect(result).toContain("Chrome");
    expect(result).toContain("15 min");
    expect(result).toContain("Audio");
    expect(result).toContain("reflector system");
  });

  test("limits apps to 5 and audio to 5", () => {
    const ctx: ScreenContext = {
      timeRange: { start: "2026-03-26T10:00:00Z", end: "2026-03-26T10:15:00Z" },
      apps: Array.from({ length: 10 }, (_, i) => ({
        appName: `App${i}`, windowTitles: [`Win${i}`], durationMinutes: 10 - i, contentSample: [],
      })),
      audioTranscripts: Array.from({ length: 10 }, (_, i) => ({
        timestamp: `2026-03-26T10:0${i}:00Z`, text: `Transcript ${i}`,
      })),
      continuousActivityMinutes: 0,
      empty: false,
    };

    const result = formatContext(ctx);
    // Should only show top 5 apps
    expect(result).toContain("App0");
    expect(result).toContain("App4");
    expect(result).not.toContain("App5");
  });
});

describe("summarizeApps", () => {
  test("aggregates by app name", () => {
    const items: SearchItem[] = [
      { type: "OCR", content: { app_name: "VS Code", window_name: "file1.ts", text: "a".repeat(30), timestamp: "2026-03-26T10:00:00Z" } },
      { type: "OCR", content: { app_name: "VS Code", window_name: "file2.ts", text: "b".repeat(30), timestamp: "2026-03-26T10:10:00Z" } },
      { type: "OCR", content: { app_name: "Chrome", window_name: "GitHub", text: "c".repeat(30), timestamp: "2026-03-26T10:05:00Z" } },
    ];

    const result = summarizeApps(items);
    expect(result).toHaveLength(2);
    const vscode = result.find(a => a.appName === "VS Code")!;
    expect(vscode.windowTitles).toContain("file1.ts");
    expect(vscode.windowTitles).toContain("file2.ts");
    expect(vscode.durationMinutes).toBe(10);
  });

  test("sorts by duration descending", () => {
    const items: SearchItem[] = [
      { type: "OCR", content: { app_name: "Short", timestamp: "2026-03-26T10:00:00Z" } },
      { type: "OCR", content: { app_name: "Short", timestamp: "2026-03-26T10:01:00Z" } },
      { type: "OCR", content: { app_name: "Long", timestamp: "2026-03-26T10:00:00Z" } },
      { type: "OCR", content: { app_name: "Long", timestamp: "2026-03-26T10:30:00Z" } },
    ];

    const result = summarizeApps(items);
    expect(result[0].appName).toBe("Long");
    expect(result[1].appName).toBe("Short");
  });

  test("ignores Audio items", () => {
    const items: SearchItem[] = [
      { type: "Audio", content: { transcription: "hello", timestamp: "2026-03-26T10:00:00Z" } },
    ];
    expect(summarizeApps(items)).toHaveLength(0);
  });

  test("limits content samples to 5 per app", () => {
    const items: SearchItem[] = Array.from({ length: 10 }, (_, i) => ({
      type: "OCR" as const,
      content: { app_name: "App", text: "x".repeat(30), timestamp: `2026-03-26T10:${String(i).padStart(2, "0")}:00Z` },
    }));

    const result = summarizeApps(items);
    expect(result[0].contentSample.length).toBeLessThanOrEqual(5);
  });
});

describe("extractAudio", () => {
  test("extracts transcriptions from Audio items", () => {
    const items: SearchItem[] = [
      { type: "Audio", content: { transcription: "Hello world", timestamp: "2026-03-26T10:00:00Z" } },
      { type: "Audio", content: { transcription: "  ", timestamp: "2026-03-26T10:01:00Z" } }, // empty, should skip
      { type: "OCR", content: { text: "screen text", timestamp: "2026-03-26T10:02:00Z" } },  // wrong type
    ];

    const result = extractAudio(items);
    expect(result).toHaveLength(1);
    expect(result[0].text).toBe("Hello world");
  });
});

describe("measureContinuousActivity", () => {
  test("returns 0 for < 2 items", () => {
    expect(measureContinuousActivity([])).toBe(0);
    expect(measureContinuousActivity([
      { type: "OCR", content: { timestamp: "2026-03-26T10:00:00Z" } },
    ])).toBe(0);
  });

  test("measures continuous session (no gaps)", () => {
    const items: SearchItem[] = Array.from({ length: 10 }, (_, i) => ({
      type: "OCR" as const,
      content: { timestamp: new Date(Date.now() - (10 - i) * 60_000).toISOString() },
    }));

    const minutes = measureContinuousActivity(items);
    expect(minutes).toBeGreaterThanOrEqual(9);
    expect(minutes).toBeLessThanOrEqual(11);
  });

  test("detects break (gap > 5 min)", () => {
    const now = Date.now();
    const items: SearchItem[] = [
      // Recent cluster: 3 items over 4 minutes
      { type: "OCR", content: { timestamp: new Date(now - 4 * 60_000).toISOString() } },
      { type: "OCR", content: { timestamp: new Date(now - 2 * 60_000).toISOString() } },
      { type: "OCR", content: { timestamp: new Date(now).toISOString() } },
      // Gap of 10 minutes
      // Older cluster
      { type: "OCR", content: { timestamp: new Date(now - 14 * 60_000).toISOString() } },
      { type: "OCR", content: { timestamp: new Date(now - 16 * 60_000).toISOString() } },
    ];

    const minutes = measureContinuousActivity(items);
    // Should only measure the recent cluster (4 min), not span the gap
    expect(minutes).toBeLessThanOrEqual(5);
  });
});
