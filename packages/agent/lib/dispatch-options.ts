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
import { IS_CLOUD } from "./config";
import { assembleSystemPrompt } from "./context";
import { PROJECT_ROOT } from "./state";
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

	const spawnStart = Date.now();
	console.log(
		`[spawn] starting: ${options.command} ${(options.args ?? []).slice(0, 3).join(" ")} (cwd: ${options.cwd})`
	);

	const proc = spawn(options.command, options.args, {
		cwd: options.cwd,
		env: options.env as NodeJS.ProcessEnv,
		signal: options.signal,
		stdio: ["pipe", "pipe", "pipe"],
	});

	console.log(`[spawn] pid=${proc.pid ?? "none"} started in ${Date.now() - spawnStart}ms`);

	proc.on("exit", (code, signal) => {
		console.log(
			`[spawn] pid=${proc.pid} exited code=${code} signal=${signal} after ${Date.now() - spawnStart}ms`
		);
	});

	proc.on("error", (err) => {
		console.log(`[spawn] pid=${proc.pid} error: ${err.message}`);
	});

	// Belt-and-suspenders: if the abort signal fires but the process doesn't die
	// within 5s (observed on macOS), force-kill it.
	if (options.signal) {
		options.signal.addEventListener(
			"abort",
			() => {
				if (proc.exitCode === null) {
					console.log(`[spawn] pid=${proc.pid} abort signal received, sending SIGTERM`);
					proc.kill("SIGTERM");
					setTimeout(() => {
						if (proc.exitCode === null) {
							console.log(`[spawn] pid=${proc.pid} still alive after SIGTERM, sending SIGKILL`);
							proc.kill("SIGKILL");
						}
					}, 5_000);
				}
			},
			{ once: true }
		);
	}

	// Capture stderr into buffer for error reporting
	proc.stderr?.on("data", (chunk: Buffer) => {
		const text = chunk.toString();
		// Keep last 2KB of stderr (enough for error messages, not too much for logs)
		lastStderr = (lastStderr + text).slice(-2048);
	});

	return proc;
}

// --- MCP config ---

/** Servers that require local machine access and cannot run in cloud. */
const CLOUD_EXCLUDED_SERVERS = new Set(["computer-use", "codegraph"]);

function loadMcpConfig(): Record<string, McpServerConfig> {
	try {
		const config = loadJson<Record<string, unknown>>(`${PROJECT_ROOT}/.mcp.json`, {});
		const servers = (config.mcpServers as Record<string, McpServerConfig>) ?? {};

		if (!IS_CLOUD) return servers;

		// Filter out cloud-incompatible servers
		const filtered: Record<string, McpServerConfig> = {};
		for (const [name, cfg] of Object.entries(servers)) {
			if (CLOUD_EXCLUDED_SERVERS.has(name)) {
				console.log(`[mcp] skipping ${name} — not compatible with cloud mode`);
				continue;
			}
			filtered[name] = cfg;
		}
		return filtered;
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
	// Use continue:true for multi-turn — SDK finds the most recent session on disk.
	// No stale session ID tracking needed. If session file is gone (deploy), starts fresh.
	if (resume) {
		sdkOptions.continue = true;
	} else {
		// Ephemeral sessions for scheduled tasks
		sdkOptions.persistSession = false;
	}

	return sdkOptions;
}
