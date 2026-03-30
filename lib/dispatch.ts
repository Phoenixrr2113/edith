/**
 * Claude dispatch engine — Agent SDK query() with session management, queue, and retries.
 *
 * Replaces the old spawn("claude -p") approach with the Claude Agent SDK.
 * Key improvements:
 *   - streamInput() for real-time message injection mid-session
 *   - Session continuity via continue/resume
 *   - Streaming message observation (turn counting, transcript logging)
 *   - Circuit breaker for repeated failures
 *   - AbortController timeout to prevent hangs
 */
import { query, type Options, type Query, type SDKResultMessage, type SDKAssistantMessage, type SDKCompactBoundaryMessage, type SDKTaskStartedMessage, type SDKTaskProgressMessage, type SDKTaskNotificationMessage } from "@anthropic-ai/claude-agent-sdk";
import { assembleSystemPrompt } from "./context";
import { setActiveQuery, getActiveQuery, setActiveSessionId, injectMessage } from "./session";
import { CHAT_ID } from "./config";
import {
  sessionId, saveSession, clearSession,
  logEvent, activeProcesses, writeActiveProcesses,
  PROJECT_ROOT,
} from "./state";
import { loadJson } from "./storage";
import { fmtErr } from "./util";
import { sendTyping } from "./telegram";
import { buildBrief, type BriefType } from "./briefs";
import { appendTranscript, startTranscript } from "./transcript";
import { ReflectorSession, DEFAULT_REFLECTOR_CONFIG, type ReflectorMode } from "./reflector";
import { REFLECTOR_EVAL_ONLY_RATIO } from "./config";

// --- Queue ---
let busy = false;

export interface DispatchJob {
  prompt: string;
  opts: DispatchOptions;
  resolve: (result: string) => void;
}

export const dispatchQueue: DispatchJob[] = [];

export interface DispatchOptions {
  resume?: boolean;
  label?: string;
  chatId?: number;
  skipIfBusy?: boolean;
  briefType?: BriefType;
  maxTurns?: number;
  _sessionRetried?: boolean;
}

// --- Circuit breaker ---
let consecutiveFailures = 0;
const MAX_CONSECUTIVE_FAILURES = 5;
const CIRCUIT_BREAKER_COOLDOWN = 10 * 60 * 1000; // 10 minutes
let circuitBreakerUntil = 0;

// --- Unique ID counter ---
let pidCounter = 0;

// --- Query timeout ---
const QUERY_TIMEOUT_MS = 5 * 60 * 1000; // 5 minutes max per dispatch
const LIGHTWEIGHT_TIMEOUT_MS = 90 * 1000; // 90 seconds for lightweight tasks
const LIGHTWEIGHT_TASKS = new Set(["check-reminders", "proactive-check"]);

// --- Inter-dispatch cooldown (allow MCP servers to shut down) ---
const INTER_DISPATCH_DELAY_MS = 3_000;

// --- MCP config ---
function loadMcpConfig(): Record<string, any> {
  try {
    const config = loadJson<Record<string, any>>(`${PROJECT_ROOT}/.mcp.json`, {});
    return config.mcpServers ?? {};
  } catch {
    return {};
  }
}

/** Builds the Agent SDK Options object from dispatch config. */
function buildSdkOptions(
  opts: DispatchOptions,
  abortController: AbortController,
): Options {
  const { resume = true } = opts;
  const systemPrompt = assembleSystemPrompt();

  const sdkOptions: Options = {
    abortController,
    systemPrompt: {
      type: "preset",
      preset: "claude_code",
      append: systemPrompt,
    },
    permissionMode: "bypassPermissions",
    allowDangerouslySkipPermissions: true,
    cwd: PROJECT_ROOT,
    mcpServers: loadMcpConfig(),
    maxTurns: opts.maxTurns ?? 50,
    settingSources: ["project"],
    allowedTools: [
      "Read", "Write", "Edit", "Bash", "Glob", "Grep",
      "WebFetch", "WebSearch", "Agent", "Skill",
    ],
  };

  // Session handling
  if (resume) {
    if (sessionId) {
      sdkOptions.resume = sessionId;
    }
  } else {
    // Ephemeral sessions for scheduled tasks
    sdkOptions.persistSession = false;
  }

  return sdkOptions;
}

interface StreamResult {
  lastResult: string;
  newSessionId: string;
  totalCost: number;
  turns: number;
  needsRetry: boolean;
}

/** Consumes the Agent SDK query stream, tracking turns, cost, and session. */
async function processMessageStream(
  queryHandle: Query,
  label: string,
  wakeId: string,
  resume: boolean,
  opts: DispatchOptions,
  pseudoPid: number,
  reflector: ReflectorSession | null,
): Promise<StreamResult> {
  let turns = 0;
  let lastResult = "";
  let newSessionId = "";
  let totalCost = 0;
  let needsRetry = false;

  /** Inject a reflection into the running session (non-blocking). */
  const maybeInject = async (trigger: "periodic" | "compaction" | "guard", guardCtx?: { toolName: string; toolInput: any }) => {
    if (!reflector) return;
    try {
      const reflection = await reflector.buildReflection(trigger, guardCtx);
      if (reflection) {
        const injected = await injectMessage(reflection);
        if (injected) {
          reflector.recordUserMessage(`[reflector:${trigger}] ${reflection.slice(0, 100)}`);
          console.log(`[reflector:${label}] Injected (${trigger}): ${reflection.slice(0, 80)}...`);
        }
      }
    } catch (err) {
      console.error(`[reflector:${label}] Injection failed:`, err);
    }
  };

  try {
    for await (const message of queryHandle) {
      appendTranscript(wakeId, message);

      // Track session ID
      if ("session_id" in message && message.session_id && resume) {
        if (message.session_id !== newSessionId) {
          newSessionId = message.session_id;
          setActiveSessionId(newSessionId);
        }
      }

      // --- Reflector: detect compaction ---
      if (message.type === "system" && "subtype" in message && (message as any).subtype === "compact_boundary") {
        const boundary = message as SDKCompactBoundaryMessage;
        const preTokens = boundary.compact_metadata.pre_tokens;
        const trigger = boundary.compact_metadata.trigger;
        console.log(`[edith:${label}] ⚙️ Context compacted (${preTokens} tokens, ${trigger})`);
        logEvent("compaction", { label, preTokens, trigger });

        if (reflector) {
          reflector.recordCompaction(preTokens, trigger);
          // Compaction reflection is critical — always fire
          await maybeInject("compaction");
        }
      }

      // --- Background agent task events ---
      if (message.type === "system" && "subtype" in message) {
        const subtype = (message as any).subtype;

        if (subtype === "task_started") {
          const m = message as SDKTaskStartedMessage;
          console.log(`[edith:${label}] 🚀 Agent started: ${m.description} (${m.task_id})`);
          logEvent("task_started", { label, taskId: m.task_id, description: m.description });
        }

        if (subtype === "task_progress") {
          const m = message as SDKTaskProgressMessage;
          const tool = m.last_tool_name ?? "working";
          const secs = Math.round((m.usage?.duration_ms ?? 0) / 1000);
          console.log(`[edith:${label}] 📊 Agent progress: ${m.task_id} — ${tool} (${secs}s, ${m.usage?.tool_uses ?? 0} tools)`);
        }

        if (subtype === "task_notification") {
          const m = message as SDKTaskNotificationMessage;
          const durSecs = m.usage?.duration_ms ? Math.round(m.usage.duration_ms / 1000) : 0;
          console.log(`[edith:${label}] 🏁 Agent ${m.status}: ${m.summary ?? m.task_id} (${durSecs}s, ${m.usage?.tool_uses ?? 0} tools)`);
          logEvent("task_complete", { label, taskId: m.task_id, status: m.status, summary: m.summary, duration: durSecs, toolUses: m.usage?.tool_uses });
        }
      }

      // Count turns on assistant messages with tool use
      if (message.type === "assistant") {
        const assistantMsg = message as SDKAssistantMessage;
        const content = assistantMsg.message?.content;
        const toolUseBlocks = content?.filter?.((block: any) => block.type === "tool_use") ?? [];
        const hasToolUse = toolUseBlocks.length > 0;
        if (hasToolUse) turns++;

        // --- Reflector: feed tool uses + check triggers ---
        if (reflector && hasToolUse) {
          for (const block of toolUseBlocks) {
            const toolBlock = block as any;
            const toolName = toolBlock.name ?? "";
            const toolInput = toolBlock.input ?? {};
            const inputPreview = JSON.stringify(toolInput).slice(0, 300);

            reflector.recordToolUse(toolName, inputPreview);

            // Guard irreversible actions
            if (reflector.shouldGuardTool(toolName, toolInput)) {
              await maybeInject("guard", { toolName, toolInput });
            }
          }

          // Periodic reflection on Nth tool call
          if (reflector.shouldReflectOnToolCall()) {
            await maybeInject("periodic");
          }
        }

        // Extract text for logging + reflector
        const textBlocks = content?.filter?.(
          (block: any) => block.type === "text"
        );
        if (textBlocks?.length) {
          lastResult = (textBlocks[textBlocks.length - 1] as any).text ?? "";
          if (reflector) {
            reflector.recordText(lastResult);
          }
        }
      }

      // Extract result info
      if (message.type === "result") {
        const resultMsg = message as SDKResultMessage;
        totalCost = resultMsg.total_cost_usd ?? 0;
        turns = resultMsg.num_turns ?? turns;

        if ("result" in resultMsg && typeof (resultMsg as any).result === "string") {
          lastResult = (resultMsg as any).result ?? lastResult;
        }

        // Check for errors
        if (resultMsg.is_error) {
          const errorSubtype = "subtype" in resultMsg ? resultMsg.subtype : "unknown";
          console.error(`[edith:${label}] ❌ Error: ${errorSubtype}`);

          // Detect corrupted session — flag for retry after cleanup
          if (errorSubtype === "error_during_execution" && sessionId && !opts._sessionRetried) {
            console.error(`[edith:${label}] Session may be corrupted, will reset and retry...`);
            logEvent("session_reset", { label, reason: errorSubtype });
            clearSession();
            needsRetry = true;
          }
        }
      }
    }
  } finally {
    setActiveQuery(null);
    setActiveSessionId("");
    activeProcesses.delete(pseudoPid);
    writeActiveProcesses();
  }

  return { lastResult, newSessionId, totalCost, turns, needsRetry };
}

/**
 * Core dispatch — spawns Agent SDK query() and processes the message stream.
 */
export async function dispatchToClaude(prompt: string, opts: DispatchOptions = {}): Promise<string> {
  const { resume = true, label = "dispatch" } = opts;

  // Circuit breaker check
  if (Date.now() < circuitBreakerUntil) {
    console.log(`[edith:${label}] Circuit breaker active, skipping dispatch`);
    logEvent("dispatch_skipped", { label, reason: "circuit_breaker" });
    return "";
  }

  if (busy) {
    // Try streamInput injection if session is running — works for both messages and scheduled tasks
    if (getActiveQuery()) {
      const injected = await injectMessage(prompt, opts.chatId);
      if (injected) {
        logEvent("message_injected", { label, prompt: prompt.slice(0, 200) });
        return "injected";
      }
    }

    if (opts.skipIfBusy) {
      console.log(`[edith:${label}] Skipped — Claude is busy and injection failed`);
      logEvent("dispatch_skipped", { label, reason: "busy" });
      return "";
    }
    console.log(`[edith:${label}] Queued (Claude is busy, ${dispatchQueue.length} in queue)`);
    logEvent("dispatch_queued", { label, queueSize: dispatchQueue.length + 1 });
    return new Promise((resolve) => {
      dispatchQueue.push({ prompt, opts, resolve });
    });
  }

  busy = true;
  const startTime = Date.now();
  let typingInterval: ReturnType<typeof setInterval> | null = null;
  const wakeId = `${label}-${Date.now()}`;
  let pseudoPid = 0;

  // AbortController for timeout — use shorter timeout for lightweight tasks
  const abortController = new AbortController();
  const timeoutMs = LIGHTWEIGHT_TASKS.has(label) ? LIGHTWEIGHT_TIMEOUT_MS : QUERY_TIMEOUT_MS;
  const timeoutHandle = setTimeout(() => {
    console.error(`[edith:${label}] Query timeout after ${timeoutMs / 1000}s, aborting...`);
    logEvent("dispatch_timeout", { label, timeoutMs });
    abortController.abort();
  }, timeoutMs);

  try {
    console.log(`[edith:${label}] Dispatching via Agent SDK (session: ${resume && sessionId ? sessionId.slice(0, 8) : "ephemeral"})...`);
    logEvent("dispatch_start", { label, session: resume ? sessionId : "ephemeral", prompt: prompt.slice(0, 200) });

    // Typing indicator
    const typingChatId = opts.chatId ?? CHAT_ID;
    if (typingChatId) {
      sendTyping(typingChatId);
      typingInterval = setInterval(() => sendTyping(typingChatId), 5_000);
    }

    // Start transcript
    startTranscript(wakeId);

    // Build options and launch query
    const sdkOptions = buildSdkOptions(opts, abortController);
    const queryHandle = query({ prompt, options: sdkOptions });
    setActiveQuery(queryHandle);

    // Track as active process (unique ID)
    pseudoPid = ++pidCounter;
    activeProcesses.set(pseudoPid, { pid: pseudoPid, label, startedAt: new Date().toISOString(), prompt: prompt.slice(0, 200) });
    writeActiveProcesses();

    // Start reflector for this session — randomly assign A/B mode
    const reflectorMode: ReflectorMode = Math.random() < REFLECTOR_EVAL_ONLY_RATIO ? "eval-only" : "active";
    const reflector = DEFAULT_REFLECTOR_CONFIG.enabled
      ? new ReflectorSession(prompt, label, { mode: reflectorMode })
      : null;
    if (reflector) {
      logEvent("reflector_assigned", { label, mode: reflectorMode });
    }

    // Process message stream
    const { lastResult, newSessionId, totalCost, turns, needsRetry } =
      await processMessageStream(queryHandle, label, wakeId, resume, opts, pseudoPid, reflector);

    // Handle session retry — push to front of queue so finally block drains it
    if (needsRetry) {
      return new Promise<string>((retryResolve) => {
        dispatchQueue.unshift({
          prompt,
          opts: { ...opts, resume: true, label, _sessionRetried: true },
          resolve: retryResolve,
        });
      });
    }

    // Save session ID
    if (resume && newSessionId && newSessionId !== sessionId) {
      saveSession(newSessionId);
      console.log(`[edith:${label}] New session: ${newSessionId.slice(0, 8)}`);
    }

    // Log completion
    const durationMs = Date.now() - startTime;
    const secs = (durationMs / 1000).toFixed(1);
    const costStr = totalCost ? `$${totalCost.toFixed(4)}` : "";
    console.log(`[edith:${label}] ✅ done (${secs}s, ${turns} turns${costStr ? `, ${costStr}` : ""})`);
    if (lastResult) console.log(`[edith:${label}] → ${lastResult.replace(/\n/g, " ").slice(0, 120)}`);
    logEvent("dispatch_end", { label, durationMs, turns, cost: totalCost });

    // Reflector: post-completion evaluation (non-blocking)
    if (reflector) {
      reflector.evaluateCompletion(lastResult).then((eval_) => {
        if (eval_) {
          console.log(`[reflector:${label}] Eval: ${eval_.score}/10 — ${eval_.assessment.slice(0, 100)}`);
        }
      }).catch(() => {}); // fire-and-forget
    }

    if (totalCost) {
      logEvent("cost", { label, usd: totalCost });
    }

    // Reset circuit breaker on success
    consecutiveFailures = 0;

    return lastResult;
  } catch (err) {
    const errMsg = fmtErr(err);
    console.error(`[edith:${label}] Error:`, errMsg);
    logEvent("dispatch_error", { label, error: errMsg });

    // Circuit breaker
    consecutiveFailures++;
    if (consecutiveFailures >= MAX_CONSECUTIVE_FAILURES) {
      circuitBreakerUntil = Date.now() + CIRCUIT_BREAKER_COOLDOWN;
      console.error(`[edith] ⚠️ Circuit breaker activated (${consecutiveFailures} failures). Cooling down for 10 minutes.`);
      logEvent("circuit_breaker", { failures: consecutiveFailures, cooldownMs: CIRCUIT_BREAKER_COOLDOWN });
    }

    setActiveQuery(null);
    setActiveSessionId("");
    activeProcesses.delete(pseudoPid); // Clean up if inner finally didn't run
    writeActiveProcesses();
    return "";
  } finally {
    clearTimeout(timeoutHandle);
    if (typingInterval) clearInterval(typingInterval);
    busy = false;

    if (dispatchQueue.length > 0) {
      // Delay to allow MCP servers from previous dispatch to shut down (prevents Kuzu lock contention)
      await Bun.sleep(INTER_DISPATCH_DELAY_MS);
      const next = dispatchQueue.shift()!;
      console.log(`[edith] Processing queued job (${dispatchQueue.length} remaining)`);
      dispatchToClaude(next.prompt, next.opts).then(next.resolve).catch(() => next.resolve(""));
    }
  }
}

/**
 * Dispatch a conversation message — builds brief, dispatches to Claude.
 */
export async function dispatchToConversation(chatId: number, messageId: number, message: string): Promise<void> {
  const brief = await buildBrief("message", { message, chatId: String(chatId) });
  const result = await dispatchToClaude(brief, { resume: true, label: "message", chatId });

  // "injected" means streamInput was used — no need to check for errors
  if (result === "injected") return;

  // Note: empty result is normal — responses sent via tool calls (send_message)
  // produce no text output. Actual failures throw exceptions in dispatchToClaude
  // and are handled by the caller (bootstrap dead-letters on exception).
}
