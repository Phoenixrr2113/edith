/**
 * Dispatch options, SDK configuration, and subprocess helpers.
 *
 * Split from dispatch.ts — contains buildSdkOptions(), spawn helpers, and types.
 */

import type {
	McpServerConfig,
	Options,
	SpawnedProcess,
	SpawnOptions,
} from "@anthropic-ai/claude-agent-sdk";
import type { BriefType } from "./briefs";
import { assembleSystemPrompt } from "./context";
import { PROJECT_ROOT, sessionId } from "./state";
import { loadJson } from "./storage";

// --- Lightweight task set (uses shorter timeout) ---
export const LIGHTWEIGHT_TASKS = new Set(["check-reminders", "proactive-check"]);

// --- DispatchOptions ---

export interface DispatchOptions {
	resume?: boolean;
	label?: string;
	chatId?: number;
	skipIfBusy?: boolean;
	briefType?: BriefType;
	maxTurns?: number;
	priority?: Priority;
	_sessionRetried?: boolean;
}

// Re-export Priority so DispatchOptions can reference it
import type { Priority } from "./queue";

// --- Stderr capture from Claude Code subprocess ---
// The Agent SDK swallows stderr — we never see why claude exits with code 1.
// This buffer captures the last stderr output for inclusion in error logs.
let lastStderr = "";

/** Returns the last captured stderr output from the Claude Code subprocess. */
export function getLastStderr(): string {
	return lastStderr;
}

/**
 * Custom spawn function that wraps child_process.spawn to capture stderr.
 * The SDK's SpawnedProcess interface doesn't expose stderr, but ChildProcess does.
 * We intercept the spawn, capture stderr into a buffer, and return the process.
 */
export function spawnWithStderrCapture(options: SpawnOptions): SpawnedProcess {
	const { spawn } = require("node:child_process") as typeof import("node:child_process");
	lastStderr = "";

	const proc = spawn(options.command, options.args, {
		cwd: options.cwd,
		env: options.env as NodeJS.ProcessEnv,
		signal: options.signal,
		stdio: ["pipe", "pipe", "pipe"],
	});

	// Capture stderr into buffer for error reporting
	proc.stderr?.on("data", (chunk: Buffer) => {
		const text = chunk.toString();
		// Keep last 2KB of stderr (enough for error messages, not too much for logs)
		lastStderr = (lastStderr + text).slice(-2048);
	});

	return proc;
}

// --- MCP config ---
function loadMcpConfig(): Record<string, McpServerConfig> {
	try {
		const config = loadJson<Record<string, unknown>>(`${PROJECT_ROOT}/.mcp.json`, {});
		// JSON is loaded as unknown; cast to the SDK's expected shape
		return (config.mcpServers as Record<string, McpServerConfig>) ?? {};
	} catch {
		return {};
	}
}

/** Builds the Agent SDK Options object from dispatch config. */
export function buildSdkOptions(opts: DispatchOptions, abortController: AbortController): Options {
	const { resume = true } = opts;
	const systemPrompt = assembleSystemPrompt();

	const sdkOptions: Options = {
		abortController,
		spawnClaudeCodeProcess: spawnWithStderrCapture,
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
			"Read",
			"Write",
			"Edit",
			"Bash",
			"Glob",
			"Grep",
			"WebFetch",
			"WebSearch",
			"Agent",
			"Skill",
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
