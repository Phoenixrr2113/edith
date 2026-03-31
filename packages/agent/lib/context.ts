/**
 * System prompt assembly — reads prompt files and builds the full system prompt.
 */
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { edithLog } from "./edith-logger";
import { PROMPTS_DIR } from "./state";

/**
 * Assemble the custom system prompt from system.md + reasoning.md.
 * This gets appended to Claude Code's default system prompt via the preset.
 */
export function assembleSystemPrompt(): string {
	const systemPath = join(PROMPTS_DIR, "system.md");
	const reasoningPath = join(PROMPTS_DIR, "reasoning.md");

	const system = existsSync(systemPath) ? readFileSync(systemPath, "utf-8") : "";
	const reasoning = existsSync(reasoningPath) ? readFileSync(reasoningPath, "utf-8") : "";

	if (!system && !reasoning) {
		edithLog.warn("context_no_prompt_files", { path: PROMPTS_DIR });
		return "";
	}

	return [system, reasoning].filter(Boolean).join("\n\n---\n\n");
}
