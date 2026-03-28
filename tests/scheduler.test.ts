/**
 * Tests for scheduler shouldFire logic (lib/scheduler.ts).
 *
 * shouldFire is not exported, so we reimplement the same logic here.
 * This tests the core scheduling decision: interval-based and time-window tasks.
 */
import { describe, test, expect } from "bun:test";

interface ScheduleEntry { name: string; prompt: string; hour?: number; minute?: number; intervalMinutes?: number; }
interface ScheduleState { lastFired: Record<string, string>; }

/** Reimplemented from lib/scheduler.ts — exact same logic */
function shouldFire(entry: ScheduleEntry, now: Date, state: ScheduleState): boolean {
  const lastFired = state.lastFired[entry.name];
  const lastFiredTime = lastFired ? new Date(lastFired).getTime() : 0;

  if (entry.intervalMinutes) {
    return (now.getTime() - lastFiredTime) >= entry.intervalMinutes * 60 * 1000;
  }

  const targetHour = entry.hour ?? -1;
  const targetMinute = entry.minute ?? 0;
  if (targetHour < 0) return false;

  const h = now.getHours();
  const m = now.getMinutes();
  const nowMinutes = h * 60 + m;
  const targetMinutes = targetHour * 60 + targetMinute;

  if (nowMinutes < targetMinutes || nowMinutes > targetMinutes + 30) return false;

  if (lastFiredTime > 0) {
    const lastDate = new Date(lastFiredTime);
    if (lastDate.getFullYear() === now.getFullYear() && lastDate.getMonth() === now.getMonth() &&
        lastDate.getDate() === now.getDate()) {
      return false;
    }
  }
  return true;
}

describe("shouldFire — interval-based", () => {
  const entry: ScheduleEntry = { name: "check-reminders", prompt: "/check-reminders", intervalMinutes: 5 };

  test("fires when never fired before", () => {
    const now = new Date("2026-03-26T12:00:00");
    expect(shouldFire(entry, now, { lastFired: {} })).toBe(true);
  });

  test("fires when elapsed >= interval", () => {
    const now = new Date("2026-03-26T12:06:00");
    const state = { lastFired: { "check-reminders": "2026-03-26T12:00:00.000Z" } };
    expect(shouldFire(entry, now, state)).toBe(true);
  });

  test("does not fire when too soon", () => {
    const now = new Date("2026-03-26T12:03:00");
    const state = { lastFired: { "check-reminders": "2026-03-26T12:00:00.000Z" } };
    expect(shouldFire(entry, now, state)).toBe(false);
  });

  test("fires at exact interval boundary", () => {
    const now = new Date("2026-03-26T12:05:00");
    const state = { lastFired: { "check-reminders": "2026-03-26T12:00:00.000Z" } };
    expect(shouldFire(entry, now, state)).toBe(true);
  });
});

describe("shouldFire — time-based (window)", () => {
  const entry: ScheduleEntry = { name: "morning-brief", prompt: "/morning-brief", hour: 8, minute: 3 };

  test("fires within 30-min window", () => {
    const now = new Date("2026-03-26T08:10:00");
    expect(shouldFire(entry, now, { lastFired: {} })).toBe(true);
  });

  test("fires at exact target time", () => {
    const now = new Date("2026-03-26T08:03:00");
    expect(shouldFire(entry, now, { lastFired: {} })).toBe(true);
  });

  test("fires at end of window (+ 30 min)", () => {
    const now = new Date("2026-03-26T08:33:00");
    expect(shouldFire(entry, now, { lastFired: {} })).toBe(true);
  });

  test("does not fire before target time", () => {
    const now = new Date("2026-03-26T07:59:00");
    expect(shouldFire(entry, now, { lastFired: {} })).toBe(false);
  });

  test("does not fire after window closes", () => {
    const now = new Date("2026-03-26T08:34:00");
    expect(shouldFire(entry, now, { lastFired: {} })).toBe(false);
  });

  test("does not fire if already fired today", () => {
    const now = new Date("2026-03-26T08:10:00");
    const state = { lastFired: { "morning-brief": "2026-03-26T08:03:00.000Z" } };
    expect(shouldFire(entry, now, state)).toBe(false);
  });

  test("fires next day even if fired yesterday", () => {
    const now = new Date("2026-03-27T08:10:00");
    const state = { lastFired: { "morning-brief": "2026-03-26T08:03:00.000Z" } };
    expect(shouldFire(entry, now, state)).toBe(true);
  });

  test("returns false when hour is missing (hour: -1)", () => {
    const noHour: ScheduleEntry = { name: "nohour", prompt: "x" };
    expect(shouldFire(noHour, new Date(), { lastFired: {} })).toBe(false);
  });
});

describe("shouldFire — edge cases", () => {
  test("midnight task (hour: 0, minute: 0)", () => {
    const entry: ScheduleEntry = { name: "midnight", prompt: "x", hour: 0, minute: 0 };
    const now = new Date("2026-03-26T00:05:00");
    expect(shouldFire(entry, now, { lastFired: {} })).toBe(true);
  });

  test("end-of-day task (hour: 23, minute: 50)", () => {
    const entry: ScheduleEntry = { name: "eod", prompt: "x", hour: 23, minute: 50 };
    const now = new Date("2026-03-26T23:55:00");
    expect(shouldFire(entry, now, { lastFired: {} })).toBe(true);
  });

  test("different tasks don't interfere", () => {
    const morning: ScheduleEntry = { name: "morning-brief", prompt: "x", hour: 8, minute: 3 };
    const midday: ScheduleEntry = { name: "midday-check", prompt: "x", hour: 12, minute: 7 };
    const now = new Date("2026-03-26T12:10:00");
    const state = { lastFired: { "morning-brief": "2026-03-26T08:03:00.000Z" } };

    expect(shouldFire(morning, now, state)).toBe(false); // outside window
    expect(shouldFire(midday, now, state)).toBe(true);   // in window, not fired
  });
});
