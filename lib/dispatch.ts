/**
 * Claude dispatch engine — spawns `claude -p` and manages queue, sessions, retries.
 */
import { spawn } from "child_process";
import {
  sessionId, saveSession, clearSession,
  logEvent, activeProcesses, writeActiveProcesses,
  saveDeadLetter, CHAT_ID, MCP_CONFIG, SYSTEM_PROMPT_FILE, loadPrompt,
} from "./state";
import { sendTyping } from "./telegram";
import { getRecentTaskboardEntries } from "./taskboard";

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
  _sessionRetried?: boolean; // internal: prevent infinite retry on corrupted session
}

export async function dispatchToClaude(prompt: string, opts: DispatchOptions = {}): Promise<string> {
  const { resume = true, label = "dispatch" } = opts;

  if (busy) {
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

  try {
    const args = [
      "-p", prompt,
      "--permission-mode", "bypassPermissions",
      "--mcp-config", MCP_CONFIG,
      "--output-format", "json",
      "--append-system-prompt-file", SYSTEM_PROMPT_FILE,
    ];

    if (resume && sessionId) {
      args.push("--resume", sessionId);
    }

    console.log(`[edith:${label}] Dispatching (session: ${resume && sessionId ? sessionId.slice(0, 8) : "ephemeral"})...`);
    logEvent("dispatch_start", { label, session: resume ? sessionId : "ephemeral", prompt: prompt.slice(0, 200) });

    const typingChatId = opts.chatId ?? CHAT_ID;
    if (typingChatId) {
      sendTyping(typingChatId);
      typingInterval = setInterval(() => sendTyping(typingChatId), 5_000);
    }

    const result = await new Promise<string>((resolve, reject) => {
      const proc = spawn("claude", args, {
        cwd: process.cwd(),
        env: process.env,
        stdio: ["pipe", "pipe", "pipe"],
      });

      const procPid = proc.pid ?? 0;
      activeProcesses.set(procPid, { pid: procPid, label, startedAt: new Date().toISOString(), prompt: prompt.slice(0, 200) });
      writeActiveProcesses();

      let stdout = "";
      let stderr = "";
      proc.stdout.on("data", (data: Buffer) => { stdout += data.toString(); });
      proc.stderr.on("data", (data: Buffer) => { stderr += data.toString(); });

      proc.on("close", (code: number | null) => {
        activeProcesses.delete(procPid);
        writeActiveProcesses();
        const durationMs = Date.now() - startTime;
        const secs = (durationMs / 1000).toFixed(1);

        if (code !== 0) {
          console.error(`[edith:${label}] ❌ exited ${code} (${secs}s)`);
          if (stderr) console.error(`[edith:${label}] stderr: ${stderr.slice(0, 500)}`);
          logEvent("dispatch_error", { label, exitCode: code, durationMs, error: stderr.slice(0, 300) });
        } else {
          // Parse Claude's JSON output for visibility
          try {
            const json = JSON.parse(stdout);
            const cost = json.total_cost_usd ? `$${json.total_cost_usd.toFixed(4)}` : "";
            const turns = json.num_turns ?? 0;
            const result = json.result?.slice(0, 150) ?? "";
            console.log(`[edith:${label}] ✅ done (${secs}s, ${turns} turns, ${cost})`);
            if (result) console.log(`[edith:${label}] → ${result.replace(/\n/g, " ").slice(0, 120)}`);
          } catch {
            console.log(`[edith:${label}] ✅ done (${secs}s)`);
          }
          logEvent("dispatch_end", { label, durationMs, exitCode: 0 });
        }
        resolve(stdout);
      });

      proc.on("error", (err) => {
        activeProcesses.delete(procPid);
        writeActiveProcesses();
        logEvent("dispatch_error", { label, error: err.message });
        reject(err);
      });

      proc.stdin.end();
    });

    // Extract session ID and cost
    if (resume) {
      try {
        const json = JSON.parse(result);

        // Detect corrupted session — retry once with fresh session
        if (json.is_error && json.result?.includes("API Error") && sessionId && !opts._sessionRetried) {
          console.error(`[edith:${label}] Session corrupted (API rejected history), resetting...`);
          logEvent("session_reset", { label, reason: json.result.slice(0, 200) });
          clearSession();
          return dispatchToClaude(prompt, { ...opts, resume: true, label, _sessionRetried: true });
        }

        if (json.session_id && json.session_id !== sessionId) {
          saveSession(json.session_id);
          console.log(`[edith:${label}] New session: ${json.session_id}`);
        }
        if (json.total_cost_usd) {
          logEvent("cost", { label, usd: json.total_cost_usd, tokens: json.usage?.input_tokens });
        }
      } catch {}
    }

    return result;
  } catch (err) {
    console.error(`[edith:${label}] Error:`, err instanceof Error ? err.message : err);
    logEvent("dispatch_error", { label, error: err instanceof Error ? err.message : String(err) });
    return "";
  } finally {
    if (typingInterval) clearInterval(typingInterval);
    busy = false;

    if (dispatchQueue.length > 0) {
      const next = dispatchQueue.shift()!;
      console.log(`[edith] Processing queued job (${dispatchQueue.length} remaining)`);
      dispatchToClaude(next.prompt, next.opts).then(next.resolve);
    }
  }
}

/**
 * Dispatch a conversation message — injects taskboard context, handles retries + dead-letter.
 */
export async function dispatchToConversation(chatId: number, messageId: number, message: string, retryCount = 0): Promise<void> {
  const taskboardContext = getRecentTaskboardEntries();
  const contextBlock = taskboardContext
    ? `[Recent taskboard context]\n${taskboardContext}\n[End taskboard context]`
    : "";

  const prompt = loadPrompt("message", { message, taskboardContext: contextBlock, chatId });
  const result = await dispatchToClaude(prompt, { resume: true, label: "message", chatId });

  let failed = false;
  let errorMsg = "";
  try {
    const json = JSON.parse(result);
    if (json.is_error) { failed = true; errorMsg = json.result?.slice(0, 300) ?? "unknown error"; }
  } catch {
    if (!result.trim()) { failed = true; errorMsg = "empty response from claude"; }
  }

  if (failed) {
    if (retryCount < 2) {
      const delay = (retryCount + 1) * 3000;
      console.log(`[edith] Message dispatch failed, retrying in ${delay / 1000}s (attempt ${retryCount + 2}/3)...`);
      logEvent("dispatch_retry", { label: "message", attempt: retryCount + 2, error: errorMsg });
      await Bun.sleep(delay);
      return dispatchToConversation(chatId, messageId, message, retryCount + 1);
    }
    saveDeadLetter(chatId, message, errorMsg);
  }
}
