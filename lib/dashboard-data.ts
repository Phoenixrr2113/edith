/**
 * Dashboard data-access layer — reusable functions extracted from dashboard.ts.
 * Used by dashboard.ts (HTTP server), MCP tools, and future cloud/Grafana integrations.
 */
import { existsSync, readFileSync } from "fs";
import { join } from "path";
import {
  STATE_DIR,
  EVENTS_FILE,
  PID_FILE,
  REMINDERS_FILE,
  SESSION_FILE,
  N8N_URL,
} from "./config";

const COGNEE_URL = process.env.COGNEE_URL ?? "http://localhost:8001";

// --- Interfaces ---

export interface SystemStatus {
  edith: boolean;
  n8n: boolean;
  cognee: boolean;
  screenpipe: boolean;
  sessionId: string | null;
  activeProcesses: Record<string, unknown>[];
  schedule: Record<string, unknown>[];
  scheduleState: Record<string, unknown>;
  proactive: {
    interventions: Record<string, unknown>[];
    lastCheck: string | null;
  };
  reminders: Record<string, unknown>[];
}

export interface EventStats {
  messagesReceived: number;
  messagesSent: number;
  dispatches: number;
  errors: number;
  tasksFired: number;
  avgDispatchMs: number;
  costUsd: number;
}

// --- Internal helpers ---

function readJsonFile(path: string): unknown {
  if (!existsSync(path)) return null;
  try { return JSON.parse(readFileSync(path, "utf-8")); } catch { return null; }
}

function readTextFile(path: string): string {
  if (!existsSync(path)) return "";
  try { return readFileSync(path, "utf-8"); } catch { return ""; }
}

// --- Exported functions ---

/** Read the last `limit` events from events.jsonl, most-recent first. */
export function readEventsFile(limit: number = 100): Record<string, unknown>[] {
  if (!existsSync(EVENTS_FILE)) return [];
  try {
    const lines = readFileSync(EVENTS_FILE, "utf-8").split("\n").filter(Boolean);
    return lines.slice(-limit).reverse().map((l) => {
      try { return JSON.parse(l) as Record<string, unknown>; } catch { return null; }
    }).filter((e): e is Record<string, unknown> => e !== null);
  } catch { return []; }
}

/** Generic HTTP health check — returns true if the URL responds 200-OK within timeout. */
export async function checkHealth(url: string, timeout = 3000): Promise<boolean> {
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeout);
    const res = await fetch(url, { signal: controller.signal });
    clearTimeout(timer);
    return res.ok;
  } catch { return false; }
}

/** Check if the edith process is alive by reading PID_FILE and sending signal 0. */
export function isEdithAlive(): boolean {
  if (!existsSync(PID_FILE)) return false;
  try {
    const pid = Number(readFileSync(PID_FILE, "utf-8").trim());
    process.kill(pid, 0);
    return true;
  } catch { return false; }
}

/** Return current system status: service health, active processes, schedule, proactive state. */
export async function getSystemStatus(): Promise<SystemStatus> {
  const [n8nOk, cogneeOk, screenpipeOk] = await Promise.all([
    checkHealth(`${N8N_URL}/healthz`),
    (async () => {
      const c = new AbortController();
      const timeoutId = setTimeout(() => c.abort(), 2000);
      try {
        await fetch(`${COGNEE_URL}/sse`, { signal: c.signal });
        return true;
      } catch (e: unknown) {
        return (e as { name?: string })?.name === "AbortError";
      } finally {
        clearTimeout(timeoutId);
      }
    })(),
    checkHealth("http://localhost:3030/health"),
  ]);

  const proactiveState = readJsonFile(join(STATE_DIR, "proactive-state.json"));

  return {
    edith: isEdithAlive(),
    n8n: n8nOk,
    cognee: cogneeOk,
    screenpipe: screenpipeOk,
    sessionId: readTextFile(SESSION_FILE).trim() || null,
    activeProcesses: readJsonFile(join(STATE_DIR, "active-processes.json")) as Record<string, unknown>[] ?? [],
    schedule: readJsonFile(join(STATE_DIR, "schedule.json")) as Record<string, unknown>[] ?? [],
    scheduleState: readJsonFile(join(STATE_DIR, "schedule-state.json")) as Record<string, unknown> ?? {},
    proactive: {
      interventions: ((proactiveState as Record<string, unknown> | null)?.interventions as Record<string, unknown>[] ?? []).filter(
        (i) => Date.now() - new Date((i as { timestamp: string }).timestamp).getTime() < 24 * 60 * 60 * 1000
      ),
      lastCheck: (proactiveState as Record<string, unknown> | null)?.lastCheck as string | null ?? null,
    },
    reminders: readJsonFile(REMINDERS_FILE) as Record<string, unknown>[] ?? [],
  };
}

/** Compute today's event statistics from a pre-loaded events array. */
export function getEventStats(events: Record<string, unknown>[]): EventStats {
  const now = Date.now();
  const today = events.filter((e) => now - new Date(e.ts as string).getTime() < 24 * 60 * 60 * 1000);
  return {
    messagesReceived: today.filter((e) => e.type === "message_received").length,
    messagesSent: today.filter((e) => e.type === "message_sent").length,
    dispatches: today.filter((e) => e.type === "dispatch_end").length,
    errors: today.filter((e) => e.type === "dispatch_error").length,
    tasksFired: today.filter((e) => e.type === "schedule_fire").length,
    avgDispatchMs: (() => {
      const durations = today
        .filter((e) => e.type === "dispatch_end" && e.durationMs)
        .map((e) => e.durationMs as number);
      return durations.length > 0
        ? Math.round(durations.reduce((a, b) => a + b, 0) / durations.length)
        : 0;
    })(),
    costUsd: (() => {
      const costs = today.filter((e) => e.type === "cost" && e.usd).map((e) => e.usd as number);
      return costs.length > 0 ? costs.reduce((a, b) => a + b, 0) : 0;
    })(),
  };
}
