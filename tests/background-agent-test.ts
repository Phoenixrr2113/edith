/**
 * Test: Does the Agent SDK stream background task events?
 *
 * Spawns a query that uses the Agent tool with run_in_background: true,
 * then logs every message type to verify task_started, task_progress,
 * and task_notification events flow through.
 */
import { query } from "@anthropic-ai/claude-agent-sdk";
import { join } from "path";

const PROJECT_ROOT = join(import.meta.dir, "..");

// Load MCP config
const mcpConfig = (() => {
  try {
    const f = Bun.file(join(PROJECT_ROOT, ".mcp.json"));
    const config = JSON.parse(f.textSync?.() ?? "{}");
    return config.mcpServers ?? {};
  } catch {
    return {};
  }
})();

const prompt = `You have access to the Agent tool. Please do the following:

1. First, spawn a background agent (run_in_background: true) with this prompt: "Read the file /Users/randywilson/Desktop/edith-v3/package.json and report what dependencies are listed."
2. While the background agent is running, immediately respond with "Background agent spawned, waiting for result."
3. When notified the background agent completed, report what it found.

This is a test of background agent functionality.`;

console.log("[test] Starting background agent test...");
console.log("[test] Prompt:", prompt.slice(0, 100), "...");
console.log("---");

const handle = query({
  prompt,
  options: {
    systemPrompt: {
      type: "preset",
      preset: "claude_code",
    },
    permissionMode: "bypassPermissions",
    allowDangerouslySkipPermissions: true,
    cwd: PROJECT_ROOT,
    mcpServers: mcpConfig,
    maxTurns: 20,
    persistSession: false,
    allowedTools: ["Read", "Glob", "Grep", "Agent"],
  },
});

let messageCount = 0;
const taskEvents: any[] = [];
const allTypes: string[] = [];

for await (const message of handle) {
  messageCount++;
  const type = message.type;
  const subtype = "subtype" in message ? (message as any).subtype : undefined;
  const key = subtype ? `${type}:${subtype}` : type;
  allTypes.push(key);

  // Log every message type
  console.log(`[msg ${messageCount}] type=${key}`);

  // Track task-specific events
  if (subtype === "task_started") {
    const m = message as any;
    console.log(`  ✅ TASK STARTED: id=${m.task_id}, desc="${m.description}", prompt="${(m.prompt ?? "").slice(0, 80)}"`);
    taskEvents.push({ event: "started", ...m });
  }

  if (subtype === "task_progress") {
    const m = message as any;
    console.log(`  📊 TASK PROGRESS: id=${m.task_id}, tool=${m.last_tool_name}, tokens=${m.usage?.total_tokens}, tools=${m.usage?.tool_uses}`);
    taskEvents.push({ event: "progress", ...m });
  }

  if (subtype === "task_notification") {
    const m = message as any;
    console.log(`  🏁 TASK COMPLETE: id=${m.task_id}, status=${m.status}, summary="${(m.summary ?? "").slice(0, 100)}"`);
    taskEvents.push({ event: "notification", ...m });
  }

  // Log assistant text
  if (type === "assistant") {
    const content = (message as any).message?.content;
    const textBlocks = content?.filter?.((b: any) => b.type === "text");
    if (textBlocks?.length) {
      console.log(`  💬 "${textBlocks[0].text.slice(0, 150)}"`);
    }
    const toolBlocks = content?.filter?.((b: any) => b.type === "tool_use");
    if (toolBlocks?.length) {
      for (const t of toolBlocks) {
        const bg = t.input?.run_in_background ? " [BACKGROUND]" : "";
        console.log(`  🔧 tool_use: ${t.name}${bg}`);
      }
    }
  }

  // Log result
  if (type === "result") {
    const m = message as any;
    console.log(`  🎯 RESULT: cost=$${m.total_cost_usd?.toFixed(4)}, turns=${m.num_turns}, error=${m.is_error}`);
  }
}

console.log("\n--- SUMMARY ---");
console.log(`Total messages: ${messageCount}`);
console.log(`Message types seen: ${[...new Set(allTypes)].join(", ")}`);
console.log(`Task events: ${taskEvents.length}`);
for (const e of taskEvents) {
  console.log(`  - ${e.event}: ${e.task_id} (${e.status ?? e.last_tool_name ?? ""})`);
}

if (taskEvents.length === 0) {
  console.log("\n⚠️  NO TASK EVENTS RECEIVED — background agents may not stream events through the parent query.");
} else {
  console.log("\n✅ TASK EVENTS CONFIRMED — background agents DO stream events through the parent query.");
}
