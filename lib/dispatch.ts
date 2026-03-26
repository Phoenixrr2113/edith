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
import { query, type Options, type SDKResultMessage, type SDKAssistantMessage } from "@anthropic-ai/claude-agent-sdk";
import { assembleSystemPrompt } from "./context";
import { setActiveQuery, getActiveQuery, setActiveSessionId, injectMessage } from "./session";
import { CHAT_ID } from "./config";
import {
  sessionId, saveSession, clearSession,
  logEvent, activeProcesses, writeActiveProcesses,
  saveDeadLetter, PROJECT_ROOT,
} from "./state";
import { loadJson } from "./storage";
import { fmtErr } from "./util";
import { sendTyping } from "./telegram";
import { buildBrief, type BriefType } from "./briefs";
import { appendTranscript, startTranscript } from "./transcript";

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

// --- MCP config ---
function loadMcpConfig(): Record<string, any> {
  try {
    const config = loadJson<Record<string, any>>(`${PROJECT_ROOT}/.mcp.json`, {});
    return config.mcpServers ?? {};
  } catch {
    return {};
  }
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
    // If session is running and this is a message, try streamInput
    if (resume && getActiveQuery()) {
      const injected = await injectMessage(prompt, opts.chatId);
      if (injected) {
        logEvent("message_injected", { label, prompt: prompt.slice(0, 200) });
        return "injected";
      }
    }

    if (opts.skipIfBusy) {
      console.log(`[edith:${label}] Skipped — Claude is busy`);
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

  // AbortController for timeout
  const abortController = new AbortController();
  const timeoutHandle = setTimeout(() => {
    console.error(`[edith:${label}] Query timeout after ${QUERY_TIMEOUT_MS / 1000}s, aborting...`);
    logEvent("dispatch_timeout", { label, timeoutMs: QUERY_TIMEOUT_MS });
    abortController.abort();
  }, QUERY_TIMEOUT_MS);

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

    // Build Agent SDK options
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

    // Launch query
    const queryHandle = query({ prompt, options: sdkOptions });
    setActiveQuery(queryHandle);

    // Track as active process (unique ID)
    pseudoPid = ++pidCounter;
    activeProcesses.set(pseudoPid, { pid: pseudoPid, label, startedAt: new Date().toISOString(), prompt: prompt.slice(0, 200) });
    writeActiveProcesses();

    // Process message stream
    let turns = 0;
    let lastResult = "";
    let newSessionId = "";
    let totalCost = 0;
    let needsRetry = false;

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

        // Count turns on assistant messages with tool use
        if (message.type === "assistant") {
          const assistantMsg = message as SDKAssistantMessage;
          const hasToolUse = assistantMsg.message?.content?.some?.(
            (block: any) => block.type === "tool_use"
          );
          if (hasToolUse) turns++;

          // Extract text for logging
          const textBlocks = assistantMsg.message?.content?.filter?.(
            (block: any) => block.type === "text"
          );
          if (textBlocks?.length) {
            lastResult = (textBlocks[textBlocks.length - 1] as any).text ?? "";
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
      const next = dispatchQueue.shift()!;
      console.log(`[edith] Processing queued job (${dispatchQueue.length} remaining)`);
      dispatchToClaude(next.prompt, next.opts).then(next.resolve).catch(() => next.resolve(""));
    }
  }
}

/**
 * Dispatch a conversation message — builds brief, handles retries + dead-letter.
 */
export async function dispatchToConversation(chatId: number, messageId: number, message: string, retryCount = 0): Promise<void> {
  const brief = await buildBrief("message", { message, chatId: String(chatId) });
  const result = await dispatchToClaude(brief, { resume: true, label: "message", chatId });

  // "injected" means streamInput was used — no need to check for errors
  if (result === "injected") return;

  let failed = !result.trim();

  if (failed) {
    if (retryCount < 2) {
      const delay = (retryCount + 1) * 3000;
      console.log(`[edith] Message dispatch failed, retrying in ${delay / 1000}s (attempt ${retryCount + 2}/3)...`);
      logEvent("dispatch_retry", { label: "message", attempt: retryCount + 2 });
      await Bun.sleep(delay);
      return dispatchToConversation(chatId, messageId, message, retryCount + 1);
    }
    saveDeadLetter(chatId, message, "empty response after retries");
  }
}
