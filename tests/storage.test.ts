/**
 * Tests for lib/storage.ts — JSON persistence, schedule defaults, typed wrappers.
 */
import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { join } from "path";
import { writeFileSync } from "fs";
import { setupTestDir, cleanupTestDir } from "./helpers";
import { loadJson, saveJson } from "../lib/storage";

let tempDir: string;

beforeAll(() => {
  tempDir = setupTestDir();
});
afterAll(() => cleanupTestDir());

describe("loadJson / saveJson", () => {
  test("returns fallback when file does not exist", () => {
    const result = loadJson(join(tempDir, "nonexistent.json"), { x: 42 });
    expect(result).toEqual({ x: 42 });
  });

  test("returns fallback on corrupt JSON", () => {
    const path = join(tempDir, "corrupt.json");
    writeFileSync(path, "not-json{{{", "utf-8");
    const result = loadJson(path, []);
    expect(result).toEqual([]);
  });

  test("round-trips object", () => {
    const path = join(tempDir, "roundtrip.json");
    const data = { name: "test", items: [1, 2, 3], nested: { a: true } };
    saveJson(path, data);
    const loaded = loadJson(path, {});
    expect(loaded).toEqual(data);
  });

  test("round-trips array", () => {
    const path = join(tempDir, "array.json");
    const data = [{ id: 1 }, { id: 2 }];
    saveJson(path, data);
    const loaded = loadJson<typeof data>(path, []);
    expect(loaded).toEqual(data);
  });

  test("overwrites existing file", () => {
    const path = join(tempDir, "overwrite.json");
    saveJson(path, { v: 1 });
    saveJson(path, { v: 2 });
    expect(loadJson(path, {})).toEqual({ v: 2 });
  });
});

describe("loadLocations pattern", () => {
  test("handles {locations: [...]} wrapper", () => {
    const path = join(tempDir, "locations-wrapped.json");
    saveJson(path, { locations: [{ name: "home", label: "Home", lat: 1, lon: 2, radiusMeters: 200 }] });
    const raw = loadJson<any>(path, { locations: [] });
    const locations = raw.locations ?? raw ?? [];
    expect(locations).toHaveLength(1);
    expect(locations[0].name).toBe("home");
  });

  test("handles bare array fallback", () => {
    const path = join(tempDir, "locations-bare.json");
    saveJson(path, [{ name: "office", label: "Office", lat: 3, lon: 4, radiusMeters: 300 }]);
    const raw = loadJson<any>(path, { locations: [] });
    const locations = raw.locations ?? raw ?? [];
    expect(locations).toHaveLength(1);
    expect(locations[0].name).toBe("office");
  });
});

describe("loadReminders pattern", () => {
  test("round-trips reminders", () => {
    const path = join(tempDir, "reminders.json");
    const reminders = [
      { id: "r1", text: "Buy milk", type: "time", fireAt: "2026-03-26T10:00:00Z", fired: false, created: "2026-03-25T10:00:00Z" },
      { id: "r2", text: "Pick up dry cleaning", type: "location", location: "home", fired: false, created: "2026-03-25T10:00:00Z" },
    ];
    saveJson(path, reminders);
    const loaded = loadJson<typeof reminders>(path, []);
    expect(loaded).toHaveLength(2);
    expect(loaded[0].id).toBe("r1");
    expect(loaded[1].type).toBe("location");
  });

  test("returns empty array when file missing", () => {
    const result = loadJson(join(tempDir, "no-reminders.json"), []);
    expect(result).toEqual([]);
  });
});

describe("loadSchedule defaults pattern", () => {
  test("seeds defaults when schedule is empty", () => {
    const path = join(tempDir, "schedule-empty.json");
    saveJson(path, []);
    const schedule = loadJson<any[]>(path, []);
    if (schedule.length === 0) {
      const defaults = [
        { name: "morning-brief", prompt: "/morning-brief", hour: 8, minute: 3 },
        { name: "check-reminders", prompt: "/check-reminders", intervalMinutes: 5 },
      ];
      saveJson(path, defaults);
      const reloaded = loadJson<any[]>(path, []);
      expect(reloaded).toHaveLength(2);
      expect(reloaded[0].name).toBe("morning-brief");
    }
  });

  test("merges missing defaults into existing schedule", () => {
    const path = join(tempDir, "schedule-partial.json");
    const existing = [{ name: "morning-brief", prompt: "/morning-brief", hour: 8, minute: 3 }];
    saveJson(path, existing);

    const schedule = loadJson<any[]>(path, []);
    const defaults = [
      { name: "morning-brief", prompt: "/morning-brief", hour: 8, minute: 3 },
      { name: "evening-wrap", prompt: "/evening-wrap", hour: 16, minute: 53 },
    ];

    let updated = false;
    for (const def of defaults) {
      if (!schedule.some((s: any) => s.name === def.name)) {
        schedule.push(def);
        updated = true;
      }
    }
    if (updated) saveJson(path, schedule);

    const final = loadJson<any[]>(path, []);
    expect(final).toHaveLength(2);
    expect(final.map((s: any) => s.name)).toContain("evening-wrap");
  });
});
