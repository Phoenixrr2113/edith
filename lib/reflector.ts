/**
 * Reflector — a lightweight agent that monitors running Claude sessions
 * and injects contextual reflection prompts via streamInput().
 *
 * Inspired by agntk's reflact system + Anthropic's harness design article.
 * Key difference: this is an external observer, not a self-evaluation callback.
 * It reads the actual transcript, compares against the original goal, and crafts
 * specific contextual feedback — not static "are you on track?" templates.
 *
 * Triggers:
 *   - Every Nth tool call (configurable, default 8)
 *   - After every context compaction (mandatory — this is where drift happens most)
 *   - Before irreversible actions (send_message, manage_emails, manage_calendar writes)
 */

import { query } from "@anthropic-ai/claude-agent-sdk";
import { REFLECTOR_ENABLED, REFLECTOR_TOOL_CALL_FREQUENCY } from "./config";
import { logEvent, PROJECT_ROOT } from "./state";

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

export interface ReflectorConfig {
  /** Inject after every N tool calls (0 = disabled). */
  toolCallFrequency: number;
  /** Always inject after compaction. */
  injectOnCompaction: boolean;
  /** Inject before irreversible tool calls. */
  guardIrreversible: boolean;
  /** Enable/disable the whole reflector. */
  enabled: boolean;
}

export const DEFAULT_REFLECTOR_CONFIG: ReflectorConfig = {
  toolCallFrequency: REFLECTOR_TOOL_CALL_FREQUENCY,
  injectOnCompaction: true,
  guardIrreversible: true,
  enabled: REFLECTOR_ENABLED,
};

// Tool calls that should trigger a quality gate before execution
const IRREVERSIBLE_TOOLS = new Set([
  "mcp__edith__send_message",
  "mcp__edith__send_notification",
  "mcp__edith__manage_emails",   // only write actions, checked in shouldGuard
  "mcp__edith__manage_calendar", // only write actions, checked in shouldGuard
]);

// manage_emails/calendar actions that are read-only (don't guard these)
const READ_ONLY_ACTIONS = new Set(["get"]);

// ---------------------------------------------------------------------------
// Transcript accumulator — fed by dispatch.ts as messages stream in
// ---------------------------------------------------------------------------

export interface TranscriptEntry {
  type: "tool_use" | "tool_result" | "text" | "compaction" | "user";
  name?: string;        // tool name
  inputPreview?: string; // truncated tool input
  text?: string;        // text content or compaction metadata
  ts: string;
}

export class ReflectorSession {
  readonly originalPrompt: string;
  readonly label: string;
  readonly config: ReflectorConfig;

  private transcript: TranscriptEntry[] = [];
  private toolCallCount = 0;
  private lastReflectionAt = 0; // tool call count at last reflection
  private pendingInjection: string | null = null;

  constructor(originalPrompt: string, label: string, config?: Partial<ReflectorConfig>) {
    this.originalPrompt = originalPrompt;
    this.label = label;
    this.config = { ...DEFAULT_REFLECTOR_CONFIG, ...config };
  }

  /** Record a tool use from the message stream. */
  recordToolUse(name: string, inputPreview: string): void {
    this.toolCallCount++;
    this.transcript.push({
      type: "tool_use",
      name,
      inputPreview: inputPreview.slice(0, 300),
      ts: new Date().toISOString(),
    });
  }

  /** Record a text block from the assistant. */
  recordText(text: string): void {
    this.transcript.push({
      type: "text",
      text: text.slice(0, 500),
      ts: new Date().toISOString(),
    });
  }

  /** Record a user message (including injections). */
  recordUserMessage(text: string): void {
    this.transcript.push({
      type: "user",
      text: text.slice(0, 300),
      ts: new Date().toISOString(),
    });
  }

  /** Record that compaction occurred. */
  recordCompaction(preTokens: number, trigger: string): void {
    this.transcript.push({
      type: "compaction",
      text: `Context compacted (${preTokens} tokens, trigger: ${trigger})`,
      ts: new Date().toISOString(),
    });
  }

  // -------------------------------------------------------------------------
  // Decision logic — should we inject?
  // -------------------------------------------------------------------------

  /** Check if Nth tool call threshold is met. */
  shouldReflectOnToolCall(): boolean {
    if (!this.config.enabled || this.config.toolCallFrequency <= 0) return false;
    const sinceLast = this.toolCallCount - this.lastReflectionAt;
    return sinceLast >= this.config.toolCallFrequency;
  }

  /** Check if compaction just happened (always reflect). */
  shouldReflectOnCompaction(): boolean {
    return this.config.enabled && this.config.injectOnCompaction;
  }

  /** Check if an irreversible tool call should be guarded. */
  shouldGuardTool(toolName: string, toolInput: any): boolean {
    if (!this.config.enabled || !this.config.guardIrreversible) return false;
    if (!IRREVERSIBLE_TOOLS.has(toolName)) return false;

    // For email/calendar, only guard write actions
    if (toolName === "mcp__edith__manage_emails" || toolName === "mcp__edith__manage_calendar") {
      const action = toolInput?.action ?? "get";
      if (READ_ONLY_ACTIONS.has(action)) return false;
    }

    return true;
  }

  // -------------------------------------------------------------------------
  // Reflection generation — uses Gemini Flash for speed + low cost
  // -------------------------------------------------------------------------

  /** Build a reflection prompt and return it, or null if nothing useful to say. */
  async buildReflection(trigger: "periodic" | "compaction" | "guard" | "completion", guardContext?: { toolName: string; toolInput: any }): Promise<string | null> {
    this.lastReflectionAt = this.toolCallCount;

    const compressedTranscript = this.compressTranscript();
    const reflectorPrompt = this.buildReflectorPrompt(trigger, compressedTranscript, guardContext);

    try {
      const reflection = await callReflectorModel(reflectorPrompt);
      if (!reflection || reflection.trim().toLowerCase().includes("no injection needed")) {
        logEvent("reflector_silent", { label: this.label, trigger, toolCalls: this.toolCallCount });
        return null;
      }

      logEvent("reflector_injection", { label: this.label, trigger, toolCalls: this.toolCallCount, reflection: reflection.slice(0, 200) });
      return `<reflection source="edith-reflector" trigger="${trigger}">\n${reflection}\n</reflection>`;
    } catch (err) {
      console.error(`[reflector:${this.label}] Failed to generate reflection:`, err);
      logEvent("reflector_error", { label: this.label, error: String(err) });
      return null;
    }
  }

  /**
   * Post-completion evaluation — called after the session ends.
   * Returns a score + assessment. Not injected (session is over),
   * but logged for learning and surfaced in dashboard.
   */
  async evaluateCompletion(lastResult: string): Promise<{ score: number; assessment: string } | null> {
    if (!this.config.enabled) return null;
    // Skip evaluation for very short sessions (< 2 tool calls) — not worth it
    if (this.toolCallCount < 2) return null;

    const compressedTranscript = this.compressTranscript();
    const prompt = this.buildCompletionPrompt(compressedTranscript, lastResult);

    try {
      const raw = await callReflectorModel(prompt);
      if (!raw) return null;

      // Parse score from response (expects "SCORE: N/10" somewhere)
      const scoreMatch = raw.match(/SCORE:\s*(\d+)/i);
      const score = scoreMatch ? Math.min(10, Math.max(0, parseInt(scoreMatch[1]))) : 5;
      const assessment = raw.replace(/SCORE:\s*\d+\/?\d*/i, "").trim();

      logEvent("reflector_evaluation", {
        label: this.label,
        toolCalls: this.toolCallCount,
        score,
        assessment: assessment.slice(0, 300),
      });

      return { score, assessment };
    } catch (err) {
      console.error(`[reflector:${this.label}] Completion eval failed:`, err);
      return null;
    }
  }

  private buildCompletionPrompt(compressedTranscript: string, lastResult: string): string {
    return [
      `You are evaluating a completed AI session. Score how well the task was accomplished.`,
      `## Original Request\n${this.originalPrompt.slice(0, 2000)}`,
      `## Full Session Activity (${this.toolCallCount} tool calls)\n${compressedTranscript}`,
      `## Final Output\n${lastResult.slice(0, 1000)}`,
      `## Evaluation\nRate this session SCORE: N/10 based on:\n- Did it accomplish the original request?\n- Were there wasted steps or drift?\n- Was the output quality appropriate?\n\nThen write 1-2 sentences explaining the score. Focus on what was missed or done well.\nFormat: SCORE: N/10 followed by your assessment.`,
    ].join("\n\n");
  }

  /** Get and clear pending injection (for async guard flow). */
  getPendingInjection(): string | null {
    const injection = this.pendingInjection;
    this.pendingInjection = null;
    return injection;
  }

  setPendingInjection(injection: string): void {
    this.pendingInjection = injection;
  }

  // -------------------------------------------------------------------------
  // Internal helpers
  // -------------------------------------------------------------------------

  /** Compress transcript to fit in reflector context. Keep last 20 entries + summary of earlier ones. */
  private compressTranscript(): string {
    const entries = this.transcript;
    if (entries.length === 0) return "(no activity yet)";

    const RECENT_COUNT = 20;
    const recent = entries.slice(-RECENT_COUNT);
    const older = entries.slice(0, -RECENT_COUNT);

    const parts: string[] = [];

    if (older.length > 0) {
      // Summarize older entries
      const toolCounts: Record<string, number> = {};
      for (const e of older) {
        if (e.type === "tool_use" && e.name) {
          toolCounts[e.name] = (toolCounts[e.name] ?? 0) + 1;
        }
      }
      const summary = Object.entries(toolCounts)
        .map(([name, count]) => `${name} x${count}`)
        .join(", ");
      parts.push(`[Earlier: ${older.length} events — ${summary || "text/user messages"}]`);
    }

    // Format recent entries
    for (const e of recent) {
      switch (e.type) {
        case "tool_use":
          parts.push(`→ ${e.name}(${e.inputPreview ?? ""})`);
          break;
        case "text":
          parts.push(`💬 ${e.text}`);
          break;
        case "user":
          parts.push(`👤 ${e.text}`);
          break;
        case "compaction":
          parts.push(`⚠️ ${e.text}`);
          break;
      }
    }

    return parts.join("\n");
  }

  /** Build the prompt sent to the reflector model. */
  private buildReflectorPrompt(
    trigger: "periodic" | "compaction" | "guard",
    compressedTranscript: string,
    guardContext?: { toolName: string; toolInput: any },
  ): string {
    const sections: string[] = [];

    sections.push(`You are a reflection agent monitoring a running AI session. Your job is to analyze progress and provide a concise, contextual injection that re-grounds the main agent.`);

    sections.push(`## Original Request\n${this.originalPrompt.slice(0, 2000)}`);

    sections.push(`## Session Activity (${this.toolCallCount} tool calls so far)\n${compressedTranscript}`);

    sections.push(`## Trigger: ${trigger}`);

    if (trigger === "compaction") {
      sections.push(`CRITICAL: The main agent's context was just compacted (compressed). Earlier conversation details are now summarized or lost. Your reflection MUST re-state the original goal, summarize key progress, and clearly list what remains to be done. This is the most important injection you can make.`);
    }

    if (trigger === "periodic") {
      sections.push(`The main agent has been working for ${this.toolCallCount} tool calls. Check for drift, wasted steps, or missed requirements. If the agent is on track, respond with exactly "no injection needed".`);
    }

    if (trigger === "guard" && guardContext) {
      sections.push(`## Pre-Action Review\nThe agent is about to execute an irreversible action:\nTool: ${guardContext.toolName}\nInput: ${JSON.stringify(guardContext.toolInput).slice(0, 500)}\n\nVerify this action aligns with the original request. Check for correctness, completeness, and appropriateness. If it looks correct, respond with "no injection needed". If there's an issue, describe it concisely.`);
    }

    sections.push(`## Your Response\nRespond with a concise reflection (2-5 lines max) that the main agent will receive as an injected message. Include:\n- What was originally asked (1 line)\n- Key progress so far (1 line)\n- What's left / what needs attention (1-2 lines)\n\nIf the agent is clearly on track and no intervention is needed, respond with exactly "no injection needed".\nDo NOT use headers, bullet points, or formatting. Just direct, actionable text.`);

    return sections.join("\n\n");
  }
}

// ---------------------------------------------------------------------------
// Model call — uses Claude Haiku via Agent SDK query()
// ---------------------------------------------------------------------------

async function callReflectorModel(prompt: string): Promise<string> {
  const handle = query({
    prompt,
    options: {
      model: "claude-haiku-4-5-20251001",
      persistSession: false,
      maxTurns: 1,
      cwd: PROJECT_ROOT,
      systemPrompt: "You are a concise reflection agent. Respond in 2-5 lines max.",
      permissionMode: "bypassPermissions",
      allowDangerouslySkipPermissions: true,
    },
  });

  let result = "";
  for await (const message of handle) {
    if (message.type === "assistant") {
      const content = (message as any).message?.content;
      const textBlock = content?.find?.((b: any) => b.type === "text");
      if (textBlock?.text) result = textBlock.text;
    }
    if (message.type === "result") {
      const resultText = (message as any).result;
      if (typeof resultText === "string") result = resultText || result;
    }
  }

  return result || "no injection needed";
}
