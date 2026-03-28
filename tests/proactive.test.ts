/**
 * Tests for lib/proactive.ts — intervention rate limits, quiet hours, cooldowns.
 *
 * Reimplements the core logic against temp files to avoid config side effects.
 */
import { describe, test, expect, beforeAll, afterAll, beforeEach } from "bun:test";
import { join } from "path";
import { writeFileSync, readFileSync, existsSync } from "fs";
import { setupTestDir, cleanupTestDir } from "./helpers";

let tempDir: string;

beforeAll(() => {
  tempDir = setupTestDir();
});
afterAll(() => cleanupTestDir());

// --- Reimplemented proactive logic against temp files ---

interface Intervention { timestamp: string; category: string; message: string; }
interface ProactiveState { interventions: Intervention[]; lastCheck: string; }
interface ProactiveConfig { maxPerHour: number; cooldownMinutes: number; quietHoursStart: number; quietHoursEnd: number; }

const DEFAULT_CONFIG: ProactiveConfig = { maxPerHour: 2, cooldownMinutes: 60, quietHoursStart: 22, quietHoursEnd: 8 };

let stateFile: string;
let configFile: string;

function loadState(): ProactiveState {
  if (!existsSync(stateFile)) return { interventions: [], lastCheck: "" };
  try { return JSON.parse(readFileSync(stateFile, "utf-8")); } catch { return { interventions: [], lastCheck: "" }; }
}

function saveState(state: ProactiveState) {
  writeFileSync(stateFile, JSON.stringify(state, null, 2), "utf-8");
}

function canIntervene(category?: string, nowOverride?: Date): { allowed: boolean; reason?: string } {
  // Check dashboard toggle
  let toggle = { enabled: true };
  if (existsSync(configFile)) {
    try { toggle = JSON.parse(readFileSync(configFile, "utf-8")); } catch {}
  }
  if (toggle.enabled === false) return { allowed: false, reason: "proactive disabled via dashboard" };

  const config = DEFAULT_CONFIG;
  const now = nowOverride ?? new Date();
  const hour = now.getHours();

  // Quiet hours (wraps midnight: 22-8)
  if (config.quietHoursStart > config.quietHoursEnd) {
    if (hour >= config.quietHoursStart || hour < config.quietHoursEnd) {
      return { allowed: false, reason: "quiet hours" };
    }
  } else {
    if (hour >= config.quietHoursStart && hour < config.quietHoursEnd) {
      return { allowed: false, reason: "quiet hours" };
    }
  }

  const state = loadState();
  const oneHourAgo = now.getTime() - 60 * 60 * 1000;
  const recentCount = state.interventions.filter(i => new Date(i.timestamp).getTime() > oneHourAgo).length;
  if (recentCount >= config.maxPerHour) return { allowed: false, reason: `rate limit (${recentCount}/${config.maxPerHour} this hour)` };

  if (category) {
    const cooldownMs = config.cooldownMinutes * 60 * 1000;
    const lastSame = state.interventions.filter(i => i.category === category).sort((a, b) => b.timestamp.localeCompare(a.timestamp))[0];
    if (lastSame && now.getTime() - new Date(lastSame.timestamp).getTime() < cooldownMs) {
      return { allowed: false, reason: `cooldown (${category})` };
    }
  }

  return { allowed: true };
}

function recordIntervention(category: string, message: string) {
  const state = loadState();
  state.interventions.push({ timestamp: new Date().toISOString(), category, message: message.slice(0, 200) });
  const cutoff = Date.now() - 24 * 60 * 60 * 1000;
  state.interventions = state.interventions.filter(i => new Date(i.timestamp).getTime() > cutoff);
  state.lastCheck = new Date().toISOString();
  saveState(state);
}

function getInterventionHistory(hours: number = 4): Intervention[] {
  const state = loadState();
  const cutoff = Date.now() - hours * 60 * 60 * 1000;
  return state.interventions.filter(i => new Date(i.timestamp).getTime() > cutoff).sort((a, b) => b.timestamp.localeCompare(a.timestamp));
}

let testCounter = 0;
beforeEach(() => {
  testCounter++;
  stateFile = join(tempDir, `proactive-state-${Date.now()}-${testCounter}.json`);
  configFile = join(tempDir, `proactive-config-${Date.now()}-${testCounter}.json`);
});

describe("canIntervene", () => {
  test("returns allowed: true in normal conditions (daytime, no recent)", () => {
    const noon = new Date("2026-03-26T12:00:00");
    const result = canIntervene(undefined, noon);
    expect(result.allowed).toBe(true);
  });

  test("blocks during quiet hours (23:00)", () => {
    const lateNight = new Date("2026-03-26T23:00:00");
    const result = canIntervene(undefined, lateNight);
    expect(result.allowed).toBe(false);
    expect(result.reason).toBe("quiet hours");
  });

  test("blocks during quiet hours (3:00 AM)", () => {
    const earlyMorning = new Date("2026-03-26T03:00:00");
    const result = canIntervene(undefined, earlyMorning);
    expect(result.allowed).toBe(false);
    expect(result.reason).toBe("quiet hours");
  });

  test("allows at boundary (8:00 AM — end of quiet hours)", () => {
    const eight = new Date("2026-03-26T08:00:00");
    const result = canIntervene(undefined, eight);
    expect(result.allowed).toBe(true);
  });

  test("blocks at boundary (22:00 — start of quiet hours)", () => {
    const tenPm = new Date("2026-03-26T22:00:00");
    const result = canIntervene(undefined, tenPm);
    expect(result.allowed).toBe(false);
  });

  test("enforces max 2 per hour", () => {
    const now = new Date("2026-03-26T14:00:00");
    const recent1 = new Date("2026-03-26T13:30:00").toISOString();
    const recent2 = new Date("2026-03-26T13:45:00").toISOString();

    saveState({
      interventions: [
        { timestamp: recent1, category: "a", message: "first" },
        { timestamp: recent2, category: "b", message: "second" },
      ],
      lastCheck: "",
    });

    const result = canIntervene(undefined, now);
    expect(result.allowed).toBe(false);
    expect(result.reason).toContain("rate limit");
  });

  test("allows after rate limit window expires", () => {
    const now = new Date("2026-03-26T14:00:00");
    const old = new Date("2026-03-26T12:30:00").toISOString(); // > 1h ago

    saveState({
      interventions: [
        { timestamp: old, category: "a", message: "old" },
        { timestamp: old, category: "b", message: "old too" },
      ],
      lastCheck: "",
    });

    const result = canIntervene(undefined, now);
    expect(result.allowed).toBe(true);
  });

  test("enforces category cooldown (60 min)", () => {
    const now = new Date("2026-03-26T14:00:00");
    const recent = new Date("2026-03-26T13:30:00").toISOString(); // 30 min ago

    saveState({
      interventions: [{ timestamp: recent, category: "email-help", message: "helped" }],
      lastCheck: "",
    });

    const result = canIntervene("email-help", now);
    expect(result.allowed).toBe(false);
    expect(result.reason).toContain("cooldown");
  });

  test("allows different category even if another is cooling down", () => {
    const now = new Date("2026-03-26T14:00:00");
    const recent = new Date("2026-03-26T13:30:00").toISOString();

    saveState({
      interventions: [{ timestamp: recent, category: "email-help", message: "helped" }],
      lastCheck: "",
    });

    const result = canIntervene("meeting-prep", now);
    expect(result.allowed).toBe(true);
  });

  test("respects dashboard toggle (disabled)", () => {
    writeFileSync(configFile, JSON.stringify({ enabled: false }), "utf-8");
    const result = canIntervene(undefined, new Date("2026-03-26T12:00:00"));
    expect(result.allowed).toBe(false);
    expect(result.reason).toContain("disabled");
  });
});

describe("recordIntervention", () => {
  test("persists intervention and trims to 24h", () => {
    // Seed with one old entry (> 24h)
    const old = new Date(Date.now() - 30 * 60 * 60 * 1000).toISOString();
    saveState({ interventions: [{ timestamp: old, category: "old", message: "stale" }], lastCheck: "" });

    recordIntervention("new-cat", "fresh intervention");

    const state = loadState();
    // Old entry should be pruned
    expect(state.interventions).toHaveLength(1);
    expect(state.interventions[0].category).toBe("new-cat");
    expect(state.lastCheck).toBeTruthy();
  });

  test("truncates message to 200 chars", () => {
    const longMsg = "x".repeat(500);
    recordIntervention("test", longMsg);
    const state = loadState();
    expect(state.interventions[0].message).toHaveLength(200);
  });
});

describe("getInterventionHistory", () => {
  test("filters by hours parameter", () => {
    const recent = new Date(Date.now() - 1 * 60 * 60 * 1000).toISOString(); // 1h ago
    const old = new Date(Date.now() - 6 * 60 * 60 * 1000).toISOString();    // 6h ago

    saveState({
      interventions: [
        { timestamp: old, category: "a", message: "old" },
        { timestamp: recent, category: "b", message: "recent" },
      ],
      lastCheck: "",
    });

    const last4h = getInterventionHistory(4);
    expect(last4h).toHaveLength(1);
    expect(last4h[0].category).toBe("b");

    const last8h = getInterventionHistory(8);
    expect(last8h).toHaveLength(2);
  });

  test("returns sorted by newest first", () => {
    const t1 = new Date(Date.now() - 30 * 60 * 1000).toISOString();
    const t2 = new Date(Date.now() - 10 * 60 * 1000).toISOString();

    saveState({
      interventions: [
        { timestamp: t1, category: "a", message: "older" },
        { timestamp: t2, category: "b", message: "newer" },
      ],
      lastCheck: "",
    });

    const history = getInterventionHistory(4);
    expect(history[0].category).toBe("b"); // newer first
    expect(history[1].category).toBe("a");
  });
});
