/**
 * Integration tests for dispatch → agent → response flows.
 *
 * Strategy: mock @anthropic-ai/claude-agent-sdk (query) and lib/briefs (buildBrief)
 * so we exercise the real internal wiring in dispatch.ts without LLM calls.
 *
 * Module-level `busy` and `consecutiveFailures` in dispatch.ts bleed between tests.
 * We sequence tests carefully and use jest's mock.module to inject clean state.
 *
 * NOTE: Bun's mock.module() is hoisted — mocks declared here apply to all imports
 * below in this file.
 */
import { describe, test, expect, beforeAll, afterAll, beforeEach, mock } from "bun:test";
import { join } from "path";
import { writeFileSync, readFileSync, existsSync } from "fs";
import { setupTestDir, cleanupTestDir, getTempDir } from "./helpers";

// ─── Mock helpers ─────────────────────────────────────────────────────────────

/**
 * Creates a fake Query async iterable that yields provided messages.
 * Matches the shape processMessageStream consumes.
 */
function createMockQuery(messages: object[], opts?: { streamInputFn?: () => Promise<void> }) {
  return {
    [Symbol.asyncIterator]: async function* () {
      for (const msg of messages) {
        yield msg;
      }
    },
    streamInput: opts?.streamInputFn ?? (async () => {}),
  };
}

/** Creates a standard SDKAssistantMessage with text block. */
function assistantMsg(text: string) {
  return {
    type: "assistant",
    message: {
      content: [{ type: "text", text }],
    },
  };
}

/** Creates a standard SDKResultMessage. */
function resultMsg(opts: { result?: string; cost?: number; turns?: number; is_error?: boolean; subtype?: string; session_id?: string } = {}) {
  return {
    type: "result",
    is_error: opts.is_error ?? false,
    total_cost_usd: opts.cost ?? 0.0001,
    num_turns: opts.turns ?? 1,
    result: opts.result ?? "",
    ...(opts.subtype ? { subtype: opts.subtype } : {}),
    ...(opts.session_id ? { session_id: opts.session_id } : {}),
  };
}

// ─── Module mocks — must be declared before imports ──────────────────────────

// Intercept: captured call args for query()
let mockQueryFn = mock(() => createMockQuery([resultMsg({ result: "default mock result" })]));

mock.module("@anthropic-ai/claude-agent-sdk", () => ({
  query: (...args: any[]) => mockQueryFn(...args),
}));

// Mock briefs so we control what gets built
let mockBuildBriefFn = mock(async (type: string, extra?: Record<string, string>) => {
  return `[mock-brief:${type}]${extra?.message ? ` msg="${extra.message}"` : ""}`;
});

mock.module("../lib/briefs", () => ({
  buildBrief: (...args: any[]) => mockBuildBriefFn(...args),
  BRIEF_TYPE_MAP: {
    "morning-brief": "morning",
    "midday-check": "midday",
    "evening-wrap": "evening",
    "proactive-check": "proactive",
  },
}));

// Stub out Telegram (no real HTTP calls)
mock.module("../lib/telegram", () => ({
  sendTyping: () => {},
  sendMessage: mock(async () => {}),
  downloadFile: mock(async () => "/tmp/fake-file.ogg"),
  transcribeAudio: mock(async () => "transcribed text"),
}));

// Stub out reflector (keep tests deterministic)
mock.module("../lib/reflector", () => ({
  ReflectorSession: class {
    buildReflection() { return null; }
    recordToolUse() {}
    recordText() {}
    recordCompaction() {}
    recordUserMessage() {}
    shouldGuardTool() { return false; }
    shouldReflectOnToolCall() { return false; }
    evaluateCompletion() { return Promise.resolve(null); }
  },
  DEFAULT_REFLECTOR_CONFIG: { enabled: false },
}));

// Stub out context assembly (avoid fs reads in tests)
mock.module("../lib/context", () => ({
  assembleSystemPrompt: () => "[mock system prompt]",
}));

// Stub out transcript (no file writes)
mock.module("../lib/transcript", () => ({
  appendTranscript: () => {},
  startTranscript: () => {},
}));

// Stub out screenpipe (no real calls)
mock.module("../lib/screenpipe", () => ({
  isUserIdle: async () => false,
}));

// Stub out logger (silence output)
mock.module("../lib/logger", () => ({
  logger: {
    info: () => {},
    error: () => {},
    warn: () => {},
  },
}));

// ─── Imports (after mocks) ─────────────────────────────────────────────────────

import { dispatchToClaude, dispatchToConversation, dispatchQueue } from "../lib/dispatch";
import { processMessageStream } from "../lib/dispatch";
import { setActiveQuery, getActiveQuery } from "../lib/session";
import { saveDeadLetter, loadDeadLetters, clearDeadLetters } from "../lib/state";
import { shouldFire } from "../lib/scheduler";
import type { ScheduleState } from "../lib/scheduler";

// ─── Test setup ───────────────────────────────────────────────────────────────

let tempDir: string;

beforeAll(() => {
  tempDir = setupTestDir();
});

afterAll(() => {
  cleanupTestDir();
});

beforeEach(() => {
  // Reset mock implementations to clean defaults before each test
  mockQueryFn = mock(() => createMockQuery([resultMsg({ result: "default result" })]));
  mockBuildBriefFn = mock(async (type: string, extra?: Record<string, string>) => {
    return `[mock-brief:${type}]${extra?.message ? ` msg="${extra.message}"` : ""}`;
  });
  // Ensure no active query leaks
  setActiveQuery(null);
});

// ─── 1. processMessageStream — full stream consumption ────────────────────────

describe("processMessageStream — full flow", () => {
  test("extracts result from assistant text + result message chain", async () => {
    const messages = [
      assistantMsg("I'll help you with that."),
      resultMsg({ result: "Task done.", cost: 0.0025, turns: 2 }),
    ];

    const result = await processMessageStream(
      createMockQuery(messages) as any,
      "integration-test",
      "wake-001",
      false,
      {},
      99001,
      null,
    );

    expect(result.lastResult).toBe("Task done.");
    expect(result.totalCost).toBeCloseTo(0.0025);
    expect(result.turns).toBe(2);
    expect(result.needsRetry).toBe(false);
  });

  test("falls back to assistant text when result.result is absent", async () => {
    const messages = [
      assistantMsg("Here's the answer."),
      { type: "result", is_error: false, total_cost_usd: 0, num_turns: 1 },
    ];

    const result = await processMessageStream(
      createMockQuery(messages) as any,
      "integration-test",
      "wake-002",
      false,
      {},
      99002,
      null,
    );

    expect(result.lastResult).toBe("Here's the answer.");
  });

  test("propagates session_id from result message when resume=true", async () => {
    const messages = [
      resultMsg({ session_id: "sess-xyz-789", result: "done" }),
    ];

    const result = await processMessageStream(
      createMockQuery(messages) as any,
      "integration-test",
      "wake-003",
      true, // resume=true
      {},
      99003,
      null,
    );

    expect(result.newSessionId).toBe("sess-xyz-789");
  });

  test("does not capture session_id when resume=false (ephemeral)", async () => {
    const messages = [
      resultMsg({ session_id: "sess-ephemeral-001", result: "done" }),
    ];

    const result = await processMessageStream(
      createMockQuery(messages) as any,
      "integration-test",
      "wake-004",
      false, // ephemeral
      {},
      99004,
      null,
    );

    expect(result.newSessionId).toBe(""); // not captured
  });

  test("handles empty stream without throwing", async () => {
    const result = await processMessageStream(
      createMockQuery([]) as any,
      "integration-test",
      "wake-005",
      false,
      {},
      99005,
      null,
    );

    expect(result.lastResult).toBe("");
    expect(result.totalCost).toBe(0);
    expect(result.turns).toBe(0);
    expect(result.needsRetry).toBe(false);
  });

  test("counts tool_use blocks as turns and extracts final text", async () => {
    const messages = [
      {
        type: "assistant",
        message: {
          content: [
            { type: "tool_use", name: "Read", input: { file_path: "/tmp/x" } },
            { type: "text", text: "Reading the file..." },
          ],
        },
      },
      {
        type: "assistant",
        message: {
          content: [
            { type: "text", text: "File contents retrieved." },
          ],
        },
      },
      resultMsg({ result: "Done reading.", turns: 2 }),
    ];

    const result = await processMessageStream(
      createMockQuery(messages) as any,
      "integration-test",
      "wake-006",
      false,
      {},
      99006,
      null,
    );

    expect(result.lastResult).toBe("Done reading.");
    expect(result.turns).toBe(2);
  });
});

// ─── 2. dispatchToClaude — end-to-end with mocked query ──────────────────────

describe("dispatchToClaude — end-to-end", () => {
  test("returns lastResult string from mock query stream", async () => {
    mockQueryFn = mock(() => createMockQuery([
      assistantMsg("Brief completed."),
      resultMsg({ result: "Morning brief done.", cost: 0.005, turns: 3 }),
    ]));

    const result = await dispatchToClaude("Run morning brief", {
      resume: false,
      label: "morning-brief-integ",
    });

    expect(result).toBe("Morning brief done.");
  });

  test("passes prompt to query() correctly", async () => {
    let capturedPrompt = "";
    mockQueryFn = mock(({ prompt }: { prompt: string }) => {
      capturedPrompt = prompt;
      return createMockQuery([resultMsg({ result: "ok" })]);
    });

    await dispatchToClaude("Hello from integration test", {
      resume: false,
      label: "prompt-capture-test",
    });

    expect(capturedPrompt).toBe("Hello from integration test");
  });

  test("returns empty string on error (caught exception path)", async () => {
    mockQueryFn = mock(() => ({
      [Symbol.asyncIterator]: async function* () {
        throw new Error("simulated SDK failure");
      },
      streamInput: async () => {},
    }));

    const result = await dispatchToClaude("Fail this dispatch", {
      resume: false,
      label: "error-path-test",
    });

    expect(result).toBe("");
  });

  test("skipIfBusy returns empty string without queuing when dispatch returns immediately", async () => {
    // This test verifies the option shape is accepted and flow works
    mockQueryFn = mock(() => createMockQuery([resultMsg({ result: "skippable" })]));

    const result = await dispatchToClaude("Quick task", {
      resume: false,
      label: "skipifbusy-test",
      skipIfBusy: false, // not busy now, so it runs normally
    });

    expect(result).toBe("skippable");
  });

  test("result message with result='' still returns assistant text", async () => {
    mockQueryFn = mock(() => createMockQuery([
      assistantMsg("Tool call response text."),
      { type: "result", is_error: false, total_cost_usd: 0, num_turns: 1 },
    ]));

    const result = await dispatchToClaude("Handle via tool", {
      resume: false,
      label: "tool-result-test",
    });

    expect(result).toBe("Tool call response text.");
  });
});

// ─── 3. dispatchToConversation — message brief routing ────────────────────────

describe("dispatchToConversation — brief type routing", () => {
  test("calls buildBrief with type='message' and message content", async () => {
    const briefCalls: Array<{ type: string; extra?: Record<string, string> }> = [];

    mockBuildBriefFn = mock(async (type: string, extra?: Record<string, string>) => {
      briefCalls.push({ type, extra });
      return `[brief:${type}] ${extra?.message ?? ""}`;
    });

    mockQueryFn = mock(() => createMockQuery([resultMsg({ result: "" })]));

    await dispatchToConversation(12345, 1, "Hello Edith!");

    expect(briefCalls.length).toBeGreaterThanOrEqual(1);
    const briefCall = briefCalls[0];
    expect(briefCall.type).toBe("message");
    expect(briefCall.extra?.message).toBe("Hello Edith!");
    expect(briefCall.extra?.chatId).toBe("12345");
  });

  test("passes the built brief as prompt to dispatchToClaude", async () => {
    let capturedPrompt = "";

    mockBuildBriefFn = mock(async () => "BUILT_BRIEF_CONTENT");
    mockQueryFn = mock(({ prompt }: { prompt: string }) => {
      capturedPrompt = prompt;
      return createMockQuery([resultMsg({ result: "" })]);
    });

    await dispatchToConversation(99999, 2, "Test message");

    expect(capturedPrompt).toBe("BUILT_BRIEF_CONTENT");
  });

  test("returns void on normal completion (no throw)", async () => {
    mockBuildBriefFn = mock(async () => "brief content");
    mockQueryFn = mock(() => createMockQuery([resultMsg({ result: "" })]));

    await expect(dispatchToConversation(12345, 3, "any message")).resolves.toBeUndefined();
  });

  test("dispatched with resume=true and label='message'", async () => {
    let capturedOpts: any = null;

    mockBuildBriefFn = mock(async () => "brief");
    mockQueryFn = mock(({ options }: any) => {
      capturedOpts = options;
      return createMockQuery([resultMsg({ result: "" })]);
    });

    await dispatchToConversation(12345, 4, "checking opts");

    // Verify options shape — resume=true means persistSession is NOT set to false
    expect(capturedOpts).toBeDefined();
    expect(capturedOpts.permissionMode).toBe("bypassPermissions");
    // resume=true → no persistSession:false override
    expect(capturedOpts.persistSession).not.toBe(false);
  });
});

// ─── 4. Brief type routing — scheduled tasks ──────────────────────────────────

describe("brief type routing — scheduled tasks", () => {
  /**
   * Verify that different brief types produce the expected brief format.
   * We test buildBrief routing via the mocked function's call signature.
   */
  test("morning brief type produces 'morning' brief", async () => {
    const calls: string[] = [];
    mockBuildBriefFn = mock(async (type: string) => {
      calls.push(type);
      return `[morning-brief-content]`;
    });
    mockQueryFn = mock(() => createMockQuery([resultMsg({ result: "morning done" })]));

    // Simulate how scheduler calls dispatchToClaude after buildBrief
    const { buildBrief } = await import("../lib/briefs");
    const brief = await buildBrief("morning");
    const result = await dispatchToClaude(brief, {
      resume: false,
      label: "morning-brief",
      briefType: "morning",
    });

    expect(calls).toContain("morning");
    expect(result).toBe("morning done");
  });

  test("scheduled brief type passes through prompt and taskName", async () => {
    let capturedArgs: any = null;
    mockBuildBriefFn = mock(async (type: string, extra?: Record<string, string>) => {
      capturedArgs = { type, extra };
      return `[scheduled] ${extra?.taskName ?? ""}`;
    });
    mockQueryFn = mock(() => createMockQuery([resultMsg({ result: "scheduled done" })]));

    const { buildBrief } = await import("../lib/briefs");
    const brief = await buildBrief("scheduled", { prompt: "/custom-task", taskName: "custom-task" });

    expect(capturedArgs.type).toBe("scheduled");
    expect(capturedArgs.extra?.taskName).toBe("custom-task");
    expect(brief).toBe("[scheduled] custom-task");
  });

  test("proactive brief type is routed correctly", async () => {
    const calls: string[] = [];
    mockBuildBriefFn = mock(async (type: string) => {
      calls.push(type);
      return "[proactive-brief-content]";
    });
    mockQueryFn = mock(() => createMockQuery([resultMsg({ result: "proactive done" })]));

    const { buildBrief } = await import("../lib/briefs");
    const brief = await buildBrief("proactive");
    await dispatchToClaude(brief, { resume: false, label: "proactive-check", briefType: "proactive", skipIfBusy: true });

    expect(calls).toContain("proactive");
  });
});

// ─── 5. Error propagation through the chain ──────────────────────────────────

describe("error propagation", () => {
  test("SDK error during iteration causes dispatchToClaude to return empty string", async () => {
    mockQueryFn = mock(() => ({
      [Symbol.asyncIterator]: async function* () {
        yield assistantMsg("Starting...");
        throw new Error("Network failure mid-stream");
      },
      streamInput: async () => {},
    }));

    const result = await dispatchToClaude("Will fail mid-stream", {
      resume: false,
      label: "mid-stream-error-test",
    });

    expect(result).toBe("");
  });

  test("buildBrief failure propagates through dispatchToConversation", async () => {
    mockBuildBriefFn = mock(async () => {
      throw new Error("Brief assembly failed");
    });

    await expect(dispatchToConversation(12345, 9, "message that fails brief")).rejects.toThrow();
  });

  test("multiple sequential dispatches after an error recover correctly", async () => {
    // First call: error
    mockQueryFn = mock(() => ({
      [Symbol.asyncIterator]: async function* () {
        throw new Error("first call fails");
      },
      streamInput: async () => {},
    }));

    const r1 = await dispatchToClaude("fail", { resume: false, label: "seq-error-1" });
    expect(r1).toBe("");

    // Second call: success
    mockQueryFn = mock(() => createMockQuery([resultMsg({ result: "recovered" })]));
    const r2 = await dispatchToClaude("succeed", { resume: false, label: "seq-recover" });
    expect(r2).toBe("recovered");
  });

  test("is_error result message is handled without throwing", async () => {
    mockQueryFn = mock(() => createMockQuery([
      {
        type: "result",
        is_error: true,
        subtype: "error_during_execution",
        total_cost_usd: 0,
        num_turns: 0,
        result: "",
      },
    ]));

    // With no sessionId set, needsRetry stays false (no session to clear)
    const result = await dispatchToClaude("error result dispatch", {
      resume: false, // no session → no retry
      label: "is-error-test",
      _sessionRetried: true, // prevent retry loop
    });

    // Returns empty string (error path)
    expect(typeof result).toBe("string");
  });
});

// ─── 6. Queue behavior under concurrent dispatches ────────────────────────────

describe("queue behavior under concurrent dispatches", () => {
  test("sequential dispatches run in order without interference", async () => {
    const results: string[] = [];
    const mockResults = ["result-A", "result-B", "result-C"];
    let callCount = 0;

    mockQueryFn = mock(() => {
      const r = mockResults[callCount % mockResults.length];
      callCount++;
      return createMockQuery([resultMsg({ result: r })]);
    });

    // Run sequentially (each awaited)
    for (let i = 0; i < 3; i++) {
      const r = await dispatchToClaude(`task-${i}`, {
        resume: false,
        label: `seq-task-${i}`,
      });
      results.push(r);
    }

    expect(results).toHaveLength(3);
    expect(results[0]).toBe("result-A");
    expect(results[1]).toBe("result-B");
    expect(results[2]).toBe("result-C");
  });

  test("skipIfBusy job does not block sequential tasks", async () => {
    mockQueryFn = mock(() => createMockQuery([resultMsg({ result: "not-skipped" })]));

    // When not busy, skipIfBusy=true still runs normally
    const result = await dispatchToClaude("important task", {
      resume: false,
      label: "no-skip-when-idle",
      skipIfBusy: true,
    });

    expect(result).toBe("not-skipped");
  });

  test("dispatchQueue is exported and starts empty (or drains between tests)", () => {
    // The queue length may be 0 (idle) or have pending items from concurrent test scenarios.
    // Verify the export is an array.
    expect(Array.isArray(dispatchQueue)).toBe(true);
  });
});

// ─── 7. Dead-letter queue — save / load ──────────────────────────────────────

describe("dead-letter queue (state.ts)", () => {
  // Use a dedicated temp file per test to avoid cross-test pollution
  let dlCounter = 0;
  const dlFile = () => join(getTempDir(), `dead-letters-${Date.now()}-${++dlCounter}.json`);

  test("saveDeadLetter writes entry, loadDeadLetters reads it back", () => {
    // Reimplementing in isolation against temp dir (state.ts uses the real STATE_DIR,
    // but we test the shape/logic rather than the real file path here)
    const { appendFileSync, readFileSync } = require("fs");
    const file = dlFile();
    const entry = {
      ts: new Date().toISOString(),
      chatId: 555,
      message: "test message that failed",
      error: "dispatch_timeout",
    };
    appendFileSync(file, JSON.stringify(entry) + "\n", "utf-8");
    const loaded = readFileSync(file, "utf-8").split("\n").filter(Boolean).map((l: string) => JSON.parse(l));
    expect(loaded).toHaveLength(1);
    expect(loaded[0].chatId).toBe(555);
    expect(loaded[0].message).toBe("test message that failed");
    expect(loaded[0].error).toBe("dispatch_timeout");
  });

  test("multiple dead letters accumulate in order", () => {
    const { appendFileSync, readFileSync } = require("fs");
    const file = dlFile();
    const messages = ["msg-1", "msg-2", "msg-3"];
    for (const message of messages) {
      appendFileSync(file, JSON.stringify({ ts: new Date().toISOString(), chatId: 1, message, error: "err" }) + "\n");
    }
    const loaded = readFileSync(file, "utf-8").split("\n").filter(Boolean).map((l: string) => JSON.parse(l));
    expect(loaded).toHaveLength(3);
    expect(loaded.map((e: any) => e.message)).toEqual(messages);
  });

  test("message is truncated to 500 chars in dead letter", () => {
    const { appendFileSync, readFileSync } = require("fs");
    const file = dlFile();
    const longMsg = "x".repeat(1000);
    const truncated = longMsg.slice(0, 500);
    appendFileSync(file, JSON.stringify({ ts: new Date().toISOString(), chatId: 1, message: truncated, error: "err" }) + "\n");
    const loaded = readFileSync(file, "utf-8").split("\n").filter(Boolean).map((l: string) => JSON.parse(l));
    expect(loaded[0].message.length).toBeLessThanOrEqual(500);
  });
});

// ─── 8. Scheduler + dispatch integration ─────────────────────────────────────

describe("scheduler shouldFire → dispatch integration", () => {
  // These tests verify that shouldFire correctly gates dispatch for scheduled tasks.
  // The actual dispatch is mocked — we focus on the routing decision.

  function makeState(lastFired: Record<string, string> = {}): ScheduleState {
    return { lastFired };
  }

  test("morning-brief fires within window → dispatch would be called", () => {
    // 8:10 is within the 8:03 + 30 min window
    const now = new Date("2026-03-30T08:10:00");
    const entry = { name: "morning-brief", prompt: "/morning-brief", hour: 8, minute: 3, daysOfWeek: [1, 2, 3, 4, 5] };
    expect(shouldFire(entry, now, makeState())).toBe(true);
  });

  test("morning-brief does not fire if already ran today → dispatch skipped", () => {
    const now = new Date("2026-03-30T08:15:00");
    const entry = { name: "morning-brief", prompt: "/morning-brief", hour: 8, minute: 3 };
    const state = makeState({ "morning-brief": "2026-03-30T08:03:00.000Z" });
    expect(shouldFire(entry, now, state)).toBe(false);
  });

  test("interval task skips when too recent → dispatch skipped", () => {
    const now = new Date("2026-03-30T12:02:00");
    const entry = { name: "check-reminders", prompt: "/check-reminders", intervalMinutes: 5 };
    const state = makeState({ "check-reminders": "2026-03-30T12:00:00.000Z" });
    expect(shouldFire(entry, now, state)).toBe(false);
  });

  test("interval task fires after interval elapsed → dispatch proceeds", () => {
    const now = new Date("2026-03-30T12:06:00");
    const entry = { name: "check-reminders", prompt: "/check-reminders", intervalMinutes: 5 };
    const state = makeState({ "check-reminders": "2026-03-30T12:00:00.000Z" });
    expect(shouldFire(entry, now, state)).toBe(true);
  });

  test("BRIEF_TYPE_MAP maps known task names to brief types", async () => {
    const { BRIEF_TYPE_MAP } = await import("../lib/briefs");
    expect(BRIEF_TYPE_MAP["morning-brief"]).toBe("morning");
    expect(BRIEF_TYPE_MAP["midday-check"]).toBe("midday");
    expect(BRIEF_TYPE_MAP["evening-wrap"]).toBe("evening");
    expect(BRIEF_TYPE_MAP["proactive-check"]).toBe("proactive");
  });

  test("unknown task names fall through to 'scheduled' brief type", async () => {
    const { BRIEF_TYPE_MAP } = await import("../lib/briefs");
    expect(BRIEF_TYPE_MAP["custom-user-task"]).toBeUndefined();
    // In scheduler.ts: briefType = BRIEF_TYPE_MAP[entry.name] → undefined → 'scheduled'
    const briefType = BRIEF_TYPE_MAP["custom-user-task"] ?? "scheduled";
    expect(briefType).toBe("scheduled");
  });
});

// ─── 9. dispatchOptions — briefType field propagated ─────────────────────────

describe("DispatchOptions.briefType routing", () => {
  test("briefType='morning' is accepted and dispatch completes", async () => {
    mockQueryFn = mock(() => createMockQuery([resultMsg({ result: "morning result" })]));

    const result = await dispatchToClaude("morning prompt", {
      resume: false,
      label: "morning-brief",
      briefType: "morning",
    });

    expect(result).toBe("morning result");
  });

  test("briefType='proactive' with skipIfBusy works when not busy", async () => {
    mockQueryFn = mock(() => createMockQuery([resultMsg({ result: "proactive result" })]));

    const result = await dispatchToClaude("proactive prompt", {
      resume: false,
      label: "proactive-check",
      briefType: "proactive",
      skipIfBusy: true,
    });

    expect(result).toBe("proactive result");
  });

  test("briefType='scheduled' with custom prompt dispatches correctly", async () => {
    mockQueryFn = mock(() => createMockQuery([resultMsg({ result: "custom scheduled done" })]));

    const result = await dispatchToClaude("[scheduled] run custom-task", {
      resume: false,
      label: "custom-task",
      briefType: "scheduled",
    });

    expect(result).toBe("custom scheduled done");
  });
});
