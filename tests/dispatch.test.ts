/**
 * Tests for lib/dispatch.ts — buildSdkOptions, processMessageStream, circuit breaker, queue.
 *
 * Strategy:
 * - buildSdkOptions: import directly and verify Options shape
 * - processMessageStream: call with mocked async generator (no real SDK calls)
 * - Circuit breaker / queue: reimplement core state machine logic to test behavior
 *   in isolation (same pattern as other tests in this suite)
 */
import { describe, test, expect, beforeAll, afterAll, beforeEach } from "bun:test";
import { setupTestDir, cleanupTestDir } from "./helpers";
import type { DispatchOptions, DispatchJob } from "../lib/dispatch";
import { buildSdkOptions } from "../lib/dispatch";
import { MAX_CONSECUTIVE_FAILURES, CIRCUIT_BREAKER_COOLDOWN_MS } from "../lib/config";

let tempDir: string;

beforeAll(() => {
  tempDir = setupTestDir();
});
afterAll(() => cleanupTestDir());

// ─── buildSdkOptions ──────────────────────────────────────────────────────────

describe("buildSdkOptions", () => {
  test("returns valid Options shape with defaults", () => {
    const abort = new AbortController();
    const opts: DispatchOptions = {};
    const result = buildSdkOptions(opts, abort);

    expect(result).toBeDefined();
    expect(result.abortController).toBe(abort);
    expect(result.permissionMode).toBe("bypassPermissions");
    expect(result.allowDangerouslySkipPermissions).toBe(true);
    expect(result.maxTurns).toBe(50);
    expect(result.settingSources).toEqual(["project"]);
  });

  test("respects custom maxTurns", () => {
    const abort = new AbortController();
    const result = buildSdkOptions({ maxTurns: 10 }, abort);
    expect(result.maxTurns).toBe(10);
  });

  test("sets systemPrompt with preset=claude_code", () => {
    const abort = new AbortController();
    const result = buildSdkOptions({}, abort);
    const sp = result.systemPrompt as any;
    expect(sp.type).toBe("preset");
    expect(sp.preset).toBe("claude_code");
    expect(typeof sp.append).toBe("string");
  });

  test("sets persistSession=false when resume=false (ephemeral)", () => {
    const abort = new AbortController();
    const result = buildSdkOptions({ resume: false }, abort);
    expect(result.persistSession).toBe(false);
    expect(result.resume).toBeUndefined();
  });

  test("includes expected allowedTools", () => {
    const abort = new AbortController();
    const result = buildSdkOptions({}, abort);
    expect(result.allowedTools).toContain("Read");
    expect(result.allowedTools).toContain("Write");
    expect(result.allowedTools).toContain("Bash");
    expect(result.allowedTools).toContain("WebFetch");
  });

  test("cwd is set to a non-empty string (PROJECT_ROOT)", () => {
    const abort = new AbortController();
    const result = buildSdkOptions({}, abort);
    expect(typeof result.cwd).toBe("string");
    expect((result.cwd as string).length).toBeGreaterThan(0);
  });

  test("mcpServers is an object", () => {
    const abort = new AbortController();
    const result = buildSdkOptions({}, abort);
    expect(typeof result.mcpServers).toBe("object");
    expect(result.mcpServers).not.toBeNull();
  });
});

// ─── processMessageStream ─────────────────────────────────────────────────────

/**
 * Build a minimal fake Query handle that yields the provided messages.
 * processMessageStream iterates `queryHandle` via `for await`, so we only
 * need a proper async iterable + a no-op streamInput.
 */
function fakeQuery(messages: any[]): any {
  return {
    [Symbol.asyncIterator]: async function* () {
      for (const msg of messages) {
        yield msg;
      }
    },
    streamInput: async () => {},
  };
}

// Import processMessageStream after mocking deps via fakes passed at call time.
// We import it at the top level — it only touches module-level state inside
// processMessageStream's finally block (activeProcesses), which is safe.
import { processMessageStream } from "../lib/dispatch";
import { setActiveQuery } from "../lib/session";

describe("processMessageStream", () => {
  beforeEach(() => {
    // Ensure no active query leaks from previous tests
    setActiveQuery(null);
  });

  test("extracts lastResult from result message", async () => {
    const messages = [
      {
        type: "result",
        is_error: false,
        total_cost_usd: 0.0042,
        num_turns: 1,
        result: "Task completed.",
      },
    ];

    const result = await processMessageStream(
      fakeQuery(messages),
      "test-label",
      "wake-123",
      false,  // resume=false → skip session save
      {},
      9999,   // pseudoPid that's not in activeProcesses
      null,   // no reflector
    );

    expect(result.lastResult).toBe("Task completed.");
    expect(result.totalCost).toBeCloseTo(0.0042);
    expect(result.turns).toBe(1);
    expect(result.needsRetry).toBe(false);
  });

  test("counts turns from result message num_turns", async () => {
    const messages = [
      { type: "result", is_error: false, total_cost_usd: 0, num_turns: 5, result: "done" },
    ];
    const result = await processMessageStream(fakeQuery(messages), "test", "w", false, {}, 9998, null);
    expect(result.turns).toBe(5);
  });

  test("extracts lastResult from assistant text block", async () => {
    const messages = [
      {
        type: "assistant",
        message: {
          content: [
            { type: "text", text: "First chunk." },
            { type: "text", text: "Final text." },
          ],
        },
      },
      { type: "result", is_error: false, total_cost_usd: 0, num_turns: 0 },
    ];

    const result = await processMessageStream(fakeQuery(messages), "test", "w", false, {}, 9997, null);
    // Last text block wins
    expect(result.lastResult).toBe("Final text.");
  });

  test("counts tool-use blocks as a turn", async () => {
    const messages = [
      {
        type: "assistant",
        message: {
          content: [
            { type: "tool_use", name: "Read", input: { file_path: "/tmp/x" } },
          ],
        },
      },
      { type: "result", is_error: false, total_cost_usd: 0, num_turns: 1 },
    ];

    const result = await processMessageStream(fakeQuery(messages), "test", "w", false, {}, 9996, null);
    expect(result.turns).toBe(1); // from result message
  });

  test("needsRetry=false for non-error result", async () => {
    const messages = [
      { type: "result", is_error: false, total_cost_usd: 0, num_turns: 1, result: "ok" },
    ];
    const result = await processMessageStream(fakeQuery(messages), "test", "w", false, {}, 9995, null);
    expect(result.needsRetry).toBe(false);
  });

  test("handles empty stream gracefully (no messages)", async () => {
    const result = await processMessageStream(fakeQuery([]), "test", "w", false, {}, 9994, null);
    expect(result.lastResult).toBe("");
    expect(result.totalCost).toBe(0);
    expect(result.turns).toBe(0);
    expect(result.needsRetry).toBe(false);
  });

  test("tracks session_id from message", async () => {
    const messages = [
      { type: "result", is_error: false, total_cost_usd: 0, num_turns: 1, session_id: "sess-abc-123", result: "done" },
    ];
    const result = await processMessageStream(fakeQuery(messages), "test", "w", true, {}, 9993, null);
    // session_id on result message — sets newSessionId if resume=true
    expect(result.newSessionId).toBe("sess-abc-123");
  });

  test("returns zero cost when total_cost_usd is 0", async () => {
    const messages = [
      { type: "result", is_error: false, total_cost_usd: 0, num_turns: 1, result: "ok" },
    ];
    const result = await processMessageStream(fakeQuery(messages), "test", "w", false, {}, 9992, null);
    expect(result.totalCost).toBe(0);
  });
});

// ─── Circuit breaker (reimplemented logic) ────────────────────────────────────

/**
 * Reimplements the circuit breaker state machine from dispatch.ts.
 * We test the logic in isolation — no module imports needed.
 */

interface CircuitBreakerState {
  consecutiveFailures: number;
  circuitBreakerUntil: number;
}

function makeCircuitBreaker() {
  let state: CircuitBreakerState = { consecutiveFailures: 0, circuitBreakerUntil: 0 };

  function isOpen(now: number = Date.now()): boolean {
    return now < state.circuitBreakerUntil;
  }

  function recordFailure(now: number = Date.now()): void {
    state.consecutiveFailures++;
    if (state.consecutiveFailures >= MAX_CONSECUTIVE_FAILURES) {
      state.circuitBreakerUntil = now + CIRCUIT_BREAKER_COOLDOWN_MS;
    }
  }

  function recordSuccess(): void {
    state.consecutiveFailures = 0;
  }

  function getState(): CircuitBreakerState {
    return { ...state };
  }

  function reset(): void {
    state = { consecutiveFailures: 0, circuitBreakerUntil: 0 };
  }

  return { isOpen, recordFailure, recordSuccess, getState, reset };
}

describe("circuit breaker", () => {
  let cb: ReturnType<typeof makeCircuitBreaker>;

  beforeEach(() => {
    cb = makeCircuitBreaker();
  });

  test("starts closed (not open)", () => {
    expect(cb.isOpen()).toBe(false);
  });

  test("stays closed below MAX_CONSECUTIVE_FAILURES", () => {
    for (let i = 0; i < MAX_CONSECUTIVE_FAILURES - 1; i++) {
      cb.recordFailure();
    }
    expect(cb.isOpen()).toBe(false);
    expect(cb.getState().consecutiveFailures).toBe(MAX_CONSECUTIVE_FAILURES - 1);
  });

  test("opens after exactly MAX_CONSECUTIVE_FAILURES failures", () => {
    const now = Date.now();
    for (let i = 0; i < MAX_CONSECUTIVE_FAILURES; i++) {
      cb.recordFailure(now);
    }
    expect(cb.isOpen(now)).toBe(true);
  });

  test("circuit breaker until is set to now + CIRCUIT_BREAKER_COOLDOWN_MS", () => {
    const now = 1_000_000_000;
    for (let i = 0; i < MAX_CONSECUTIVE_FAILURES; i++) {
      cb.recordFailure(now);
    }
    expect(cb.getState().circuitBreakerUntil).toBe(now + CIRCUIT_BREAKER_COOLDOWN_MS);
  });

  test("circuit is still open before cooldown expires", () => {
    const now = 1_000_000_000;
    for (let i = 0; i < MAX_CONSECUTIVE_FAILURES; i++) {
      cb.recordFailure(now);
    }
    // 1 ms before cooldown ends → still open
    expect(cb.isOpen(now + CIRCUIT_BREAKER_COOLDOWN_MS - 1)).toBe(true);
  });

  test("circuit is closed after cooldown expires", () => {
    const now = 1_000_000_000;
    for (let i = 0; i < MAX_CONSECUTIVE_FAILURES; i++) {
      cb.recordFailure(now);
    }
    // At or after cooldown end → closed
    expect(cb.isOpen(now + CIRCUIT_BREAKER_COOLDOWN_MS)).toBe(false);
  });

  test("resets consecutiveFailures on success", () => {
    cb.recordFailure();
    cb.recordFailure();
    cb.recordSuccess();
    expect(cb.getState().consecutiveFailures).toBe(0);
  });

  test("success after circuit opens does not un-open it immediately", () => {
    const now = Date.now();
    for (let i = 0; i < MAX_CONSECUTIVE_FAILURES; i++) {
      cb.recordFailure(now);
    }
    cb.recordSuccess(); // clears failure count, but circuitBreakerUntil already set
    // Failure count reset
    expect(cb.getState().consecutiveFailures).toBe(0);
    // But the until timestamp is still in the future — circuit still open
    expect(cb.isOpen(now)).toBe(true);
  });

  test("additional failures beyond threshold don't double-extend cooldown", () => {
    const now = 1_000_000_000;
    for (let i = 0; i < MAX_CONSECUTIVE_FAILURES + 3; i++) {
      cb.recordFailure(now);
    }
    // circuitBreakerUntil was set on the Nth failure; later failures set it again
    // with the same `now`, so the value should remain consistent (same formula)
    expect(cb.getState().circuitBreakerUntil).toBe(now + CIRCUIT_BREAKER_COOLDOWN_MS);
  });
});

// ─── Queue behavior ───────────────────────────────────────────────────────────

/**
 * Reimplements the dispatch queue logic from dispatch.ts.
 */

interface FakeDispatchJob {
  prompt: string;
  opts: DispatchOptions;
  resolve: (result: string) => void;
}

function makeDispatchQueue() {
  const queue: FakeDispatchJob[] = [];
  let busy = false;
  const results: { prompt: string; result: string }[] = [];

  function enqueue(prompt: string, opts: DispatchOptions): Promise<string> | "" {
    if (opts.skipIfBusy) {
      return "";
    }
    return new Promise<string>((resolve) => {
      queue.push({ prompt, opts, resolve });
    });
  }

  function drainOne(): boolean {
    if (queue.length === 0) return false;
    const job = queue.shift()!;
    // Simulate immediate resolution with prompt echo
    results.push({ prompt: job.prompt, result: `result:${job.prompt}` });
    job.resolve(`result:${job.prompt}`);
    return true;
  }

  function setBusy(val: boolean) { busy = val; }
  function isBusy(): boolean { return busy; }
  function queueLength(): number { return queue.length; }
  function getResults() { return [...results]; }

  return { enqueue, drainOne, setBusy, isBusy, queueLength, getResults };
}

describe("dispatch queue", () => {
  test("skipIfBusy returns empty string immediately", () => {
    const q = makeDispatchQueue();
    q.setBusy(true);
    const result = q.enqueue("hello", { skipIfBusy: true });
    expect(result).toBe("");
    expect(q.queueLength()).toBe(0);
  });

  test("enqueues job when busy and skipIfBusy is false", () => {
    const q = makeDispatchQueue();
    q.setBusy(true);

    // Don't await — just verify it's queued
    const promise = q.enqueue("job-1", {}) as Promise<string>;
    expect(promise).toBeInstanceOf(Promise);
    expect(q.queueLength()).toBe(1);
  });

  test("multiple jobs queue up in order", () => {
    const q = makeDispatchQueue();
    q.setBusy(true);

    q.enqueue("first", {});
    q.enqueue("second", {});
    q.enqueue("third", {});

    expect(q.queueLength()).toBe(3);
  });

  test("draining resolves jobs in FIFO order", async () => {
    const q = makeDispatchQueue();
    q.setBusy(true);

    const results: string[] = [];
    const p1 = (q.enqueue("job-a", {}) as Promise<string>).then(r => results.push(r));
    const p2 = (q.enqueue("job-b", {}) as Promise<string>).then(r => results.push(r));
    const p3 = (q.enqueue("job-c", {}) as Promise<string>).then(r => results.push(r));

    expect(q.queueLength()).toBe(3);

    q.drainOne();
    q.drainOne();
    q.drainOne();

    await Promise.all([p1, p2, p3]);

    expect(results).toEqual(["result:job-a", "result:job-b", "result:job-c"]);
    expect(q.queueLength()).toBe(0);
  });

  test("skipIfBusy does not pollute the queue", () => {
    const q = makeDispatchQueue();
    q.setBusy(true);

    q.enqueue("real-job", {});
    q.enqueue("skipped", { skipIfBusy: true });
    q.enqueue("another-real", {});

    // Only the two non-skipped jobs are in the queue
    expect(q.queueLength()).toBe(2);
  });

  test("empty queue returns false from drainOne", () => {
    const q = makeDispatchQueue();
    expect(q.drainOne()).toBe(false);
  });
});

// ─── DispatchOptions shape ────────────────────────────────────────────────────

describe("DispatchOptions interface", () => {
  test("all fields are optional", () => {
    // Compilation test — no runtime assertions needed
    const opts: DispatchOptions = {};
    expect(opts).toBeDefined();
  });

  test("accepts all valid fields", () => {
    const opts: DispatchOptions = {
      resume: true,
      label: "morning-brief",
      chatId: 12345,
      skipIfBusy: false,
      briefType: "morning",
      maxTurns: 20,
      _sessionRetried: false,
    };
    expect(opts.label).toBe("morning-brief");
    expect(opts.maxTurns).toBe(20);
    expect(opts.briefType).toBe("morning");
  });
});

// ─── DispatchJob shape ────────────────────────────────────────────────────────

describe("DispatchJob interface", () => {
  test("job carries prompt, opts, and resolve", () => {
    let resolved = "";
    const job: DispatchJob = {
      prompt: "do the thing",
      opts: { label: "test" },
      resolve: (r: string) => { resolved = r; },
    };
    job.resolve("done!");
    expect(resolved).toBe("done!");
    expect(job.prompt).toBe("do the thing");
    expect(job.opts.label).toBe("test");
  });
});
