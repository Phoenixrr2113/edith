/**
 * Session management — tracks the active Agent SDK query handle.
 * Enables message injection via streamInput() when Edith is busy.
 */
import type { Query, SDKUserMessage } from "@anthropic-ai/claude-agent-sdk";
import { randomUUID } from "crypto";

let activeQuery: Query | null = null;
let activeSessionId: string = "";

export function setActiveQuery(q: Query | null): void {
  activeQuery = q;
}

export function getActiveQuery(): Query | null {
  return activeQuery;
}

export function setActiveSessionId(id: string): void {
  activeSessionId = id;
}

export function isSessionRunning(): boolean {
  return activeQuery !== null;
}

/**
 * Inject a user message into the active session via streamInput().
 * Returns true if injection succeeded, false if no active session.
 */
export async function injectMessage(text: string, chatId?: number): Promise<boolean> {
  if (!activeQuery) return false;

  try {
    const message: SDKUserMessage = {
      type: "user",
      message: { role: "user", content: text },
      parent_tool_use_id: null,
      timestamp: new Date().toISOString(),
      session_id: activeSessionId,
      uuid: randomUUID(),
    };

    // Create a single-item async iterable
    async function* singleMessage() {
      yield message;
    }

    await activeQuery.streamInput(singleMessage());
    console.log(`[session] Injected message into active session: "${text.slice(0, 80)}..."`);
    return true;
  } catch (err) {
    console.error("[session] streamInput failed:", err instanceof Error ? err.message : err);
    return false;
  }
}
