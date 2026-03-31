/**
 * Tests for scheduler shouldFire logic (lib/scheduler.ts).
 *
 * Uses the real exported shouldFire implementation.
 */
import { describe, test, expect } from "bun:test";
import { shouldFire, type ScheduleState } from "../lib/scheduler";

// Helpers
function state(lastFired: Record<string, string> = {}): ScheduleState {
  return { lastFired };
}

describe("shouldFire — interval-based", () => {
  const entry = { name: "check-reminders", prompt: "/check-reminders", intervalMinutes: 5 };

  test("fires when never fired before", () => {
    const now = new Date("2026-03-26T12:00:00");
    expect(shouldFire(entry, now, state())).toBe(true);
  });

  test("fires when elapsed >= interval", () => {
    const now = new Date("2026-03-26T12:06:00");
    expect(shouldFire(entry, now, state({ "check-reminders": "2026-03-26T12:00:00.000Z" }))).toBe(true);
  });

  test("does not fire when too soon", () => {
    const now = new Date("2026-03-26T12:03:00");
    expect(shouldFire(entry, now, state({ "check-reminders": "2026-03-26T12:00:00.000Z" }))).toBe(false);
  });

  test("fires at exact interval boundary", () => {
    const now = new Date("2026-03-26T12:05:00");
    expect(shouldFire(entry, now, state({ "check-reminders": "2026-03-26T12:00:00.000Z" }))).toBe(true);
  });
});

describe("shouldFire — time-based (window)", () => {
  const entry = { name: "morning-brief", prompt: "/morning-brief", hour: 8, minute: 3 };

  test("fires within 30-min window", () => {
    const now = new Date("2026-03-26T08:10:00");
    expect(shouldFire(entry, now, state())).toBe(true);
  });

  test("fires at exact target time", () => {
    const now = new Date("2026-03-26T08:03:00");
    expect(shouldFire(entry, now, state())).toBe(true);
  });

  test("fires at end of window (+ 30 min)", () => {
    const now = new Date("2026-03-26T08:33:00");
    expect(shouldFire(entry, now, state())).toBe(true);
  });

  test("does not fire before target time", () => {
    const now = new Date("2026-03-26T07:59:00");
    expect(shouldFire(entry, now, state())).toBe(false);
  });

  test("does not fire after window closes", () => {
    const now = new Date("2026-03-26T08:34:00");
    expect(shouldFire(entry, now, state())).toBe(false);
  });

  test("does not fire if already fired today", () => {
    const now = new Date("2026-03-26T08:10:00");
    expect(shouldFire(entry, now, state({ "morning-brief": "2026-03-26T08:03:00.000Z" }))).toBe(false);
  });

  test("fires next day even if fired yesterday", () => {
    const now = new Date("2026-03-27T08:10:00");
    expect(shouldFire(entry, now, state({ "morning-brief": "2026-03-26T08:03:00.000Z" }))).toBe(true);
  });

  test("returns false when hour is missing", () => {
    const noHour = { name: "nohour", prompt: "x" };
    expect(shouldFire(noHour, new Date(), state())).toBe(false);
  });
});

describe("shouldFire — edge cases", () => {
  test("midnight task (hour: 0, minute: 0)", () => {
    const entry = { name: "midnight", prompt: "x", hour: 0, minute: 0 };
    const now = new Date("2026-03-26T00:05:00");
    expect(shouldFire(entry, now, state())).toBe(true);
  });

  test("end-of-day task (hour: 23, minute: 50)", () => {
    const entry = { name: "eod", prompt: "x", hour: 23, minute: 50 };
    const now = new Date("2026-03-26T23:55:00");
    expect(shouldFire(entry, now, state())).toBe(true);
  });

  test("different tasks don't interfere", () => {
    const morning = { name: "morning-brief", prompt: "x", hour: 8, minute: 3 };
    const midday = { name: "midday-check", prompt: "x", hour: 12, minute: 7 };
    const now = new Date("2026-03-26T12:10:00");
    const s = state({ "morning-brief": "2026-03-26T08:03:00.000Z" });

    expect(shouldFire(morning, now, s)).toBe(false); // outside window
    expect(shouldFire(midday, now, s)).toBe(true);   // in window, not fired
  });
});

describe("shouldFire — daysOfWeek", () => {
  // 2026-03-26 is a Thursday (dow=4)
  const now = new Date("2026-03-26T08:10:00");
  const entry = { name: "weekday-task", prompt: "x", hour: 8, minute: 3 };

  test("fires when today's dow is in daysOfWeek", () => {
    expect(shouldFire({ ...entry, daysOfWeek: [4] }, now, state())).toBe(true);
  });

  test("does not fire when today's dow is not in daysOfWeek", () => {
    expect(shouldFire({ ...entry, daysOfWeek: [1, 2, 3] }, now, state())).toBe(false);
  });

  test("fires when daysOfWeek is empty/undefined (no filter)", () => {
    expect(shouldFire(entry, now, state())).toBe(true);
  });

  test("interval task also respects daysOfWeek", () => {
    const intervalEntry = { name: "interval-task", prompt: "x", intervalMinutes: 5 };
    // Thursday only — should fire
    expect(shouldFire({ ...intervalEntry, daysOfWeek: [4] }, now, state())).toBe(true);
    // Monday only — should not fire
    expect(shouldFire({ ...intervalEntry, daysOfWeek: [1] }, now, state())).toBe(false);
  });
});

describe("shouldFire — months", () => {
  // 2026-03-26: month=3
  const now = new Date("2026-03-26T08:10:00");
  const entry = { name: "quarterly", prompt: "x", hour: 8, minute: 3 };

  test("fires when current month is in months list", () => {
    expect(shouldFire({ ...entry, months: [1, 3, 6, 9] }, now, state())).toBe(true);
  });

  test("does not fire when current month is not in months list", () => {
    expect(shouldFire({ ...entry, months: [1, 6, 9, 12] }, now, state())).toBe(false);
  });

  test("fires when months is undefined (no filter)", () => {
    expect(shouldFire(entry, now, state())).toBe(true);
  });
});

describe("shouldFire — dayOfMonth", () => {
  // 2026-03-26: dom=26
  const now = new Date("2026-03-26T08:10:00");
  const entry = { name: "monthly-task", prompt: "x", hour: 8, minute: 3 };

  test("fires when today matches dayOfMonth", () => {
    expect(shouldFire({ ...entry, dayOfMonth: 26 }, now, state())).toBe(true);
  });

  test("does not fire when today does not match dayOfMonth", () => {
    expect(shouldFire({ ...entry, dayOfMonth: 1 }, now, state())).toBe(false);
  });

  test("fires when dayOfMonth is undefined (no filter)", () => {
    expect(shouldFire(entry, now, state())).toBe(true);
  });

  test("combined: dayOfMonth + months — both match", () => {
    expect(shouldFire({ ...entry, dayOfMonth: 26, months: [3] }, now, state())).toBe(true);
  });

  test("combined: dayOfMonth + months — month mismatch", () => {
    expect(shouldFire({ ...entry, dayOfMonth: 26, months: [6] }, now, state())).toBe(false);
  });
});

describe("shouldFire — quietHours", () => {
  const intervalEntry = { name: "check", prompt: "x", intervalMinutes: 5, quietStart: 22, quietEnd: 7 };

  test("fires outside quiet hours", () => {
    const now = new Date("2026-03-26T12:00:00"); // noon
    expect(shouldFire(intervalEntry, now, state())).toBe(true);
  });

  test("does not fire during quiet hours (evening side)", () => {
    const now = new Date("2026-03-26T23:00:00"); // 11 PM
    expect(shouldFire(intervalEntry, now, state())).toBe(false);
  });

  test("does not fire during quiet hours (morning side)", () => {
    const now = new Date("2026-03-26T06:00:00"); // 6 AM
    expect(shouldFire(intervalEntry, now, state())).toBe(false);
  });

  test("fires at boundary (exactly quietEnd hour)", () => {
    // quietEnd=7 means hour < 7 is quiet; hour=7 is NOT quiet
    const now = new Date("2026-03-26T07:00:00");
    expect(shouldFire(intervalEntry, now, state())).toBe(true);
  });

  test("non-wrapping quiet hours: quietStart < quietEnd", () => {
    // e.g., quiet from 13:00 to 14:00 (lunch break)
    const lunchEntry = { name: "lunch", prompt: "x", intervalMinutes: 5, quietStart: 13, quietEnd: 14 };
    expect(shouldFire(lunchEntry, new Date("2026-03-26T13:30:00"), state())).toBe(false);
    expect(shouldFire(lunchEntry, new Date("2026-03-26T12:00:00"), state())).toBe(true);
    expect(shouldFire(lunchEntry, new Date("2026-03-26T14:00:00"), state())).toBe(true);
  });

  test("quiet hours only affect interval tasks, not window tasks", () => {
    // A time-based task with quietStart/quietEnd should still fire (quietHours check only runs for intervalMinutes)
    const windowEntry = { name: "morning-brief", prompt: "x", hour: 6, minute: 0, quietStart: 22, quietEnd: 7 };
    const now = new Date("2026-03-26T06:05:00"); // inside quiet hours
    expect(shouldFire(windowEntry, now, state())).toBe(true);
  });
});
