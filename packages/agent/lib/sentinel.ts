/**
 * Sentinel — post-message quality agent that evaluates every outbound
 * message to Randy against all available data sources.
 *
 * Checks: accuracy, freshness, dedup, timing, format rules, completeness,
 * missed opportunities, and system health.
 *
 * Runs fire-and-forget after each send_message call. Logs findings to
 * events.jsonl and files GitHub issues for critical/system bugs.
 */

import { execSync } from "node:child_process";
import { appendFileSync, readFileSync } from "node:fs";
import { query } from "@anthropic-ai/claude-agent-sdk";
import { EVENTS_FILE, SENTINEL_ENABLED, TASKBOARD_FILE } from "./config";
import { edithLog } from "./edith-logger";
import { PROJECT_ROOT } from "./state";

const SENTINEL_REPORT_FILE = `${PROJECT_ROOT}/.state/sentinel-report.md`;

// Communication rules from .claude/rules/communication.md
const FORMAT_RULES = {
	maxLinesPerMessage: 5, // "3-5 lines max"
	maxWordsPerBullet: 12, // "Max 10-12 words per bullet"
	bannedOpeners: [
		"Great",
		"Certainly",
		"Sure",
		"Of course",
		"I'd be happy to help",
		"Good morning",
		"Let me know",
	],
};

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type IssueSeverity = "critical" | "high" | "low";
/** Known issue types — but the LLM can return any string it discovers. */
export const KNOWN_ISSUE_TYPES = [
	"accuracy",
	"freshness",
	"dedup",
	"timing",
	"format",
	"completeness",
	"missed_opportunity",
	"system_health",
	"cost",
] as const;

export type IssueType = (typeof KNOWN_ISSUE_TYPES)[number] | (string & {});

export interface SentinelIssue {
	type: IssueType;
	severity: IssueSeverity;
	description: string;
	suggestion: string;
}

export interface SentinelVerdict {
	score: number;
	issues: SentinelIssue[];
	improvements: string[];
	systemBugs: Array<{ description: string; evidence: string }>;
}

// ---------------------------------------------------------------------------
// Context gathering — reads local state without network calls
// ---------------------------------------------------------------------------

/** Gather local context for evaluation. Fast, no API calls. */
function gatherLocalContext(): {
	recentMessages: string[];
	taskboard: string;
	recentErrors: string[];
	currentTime: string;
	timezone: string;
} {
	const currentTime = new Date().toISOString();
	const timezone = Intl.DateTimeFormat().resolvedOptions().timeZone;

	// Recent message_sent events from events.jsonl (last 2h)
	const recentMessages: string[] = [];
	const recentErrors: string[] = [];
	const twoHoursAgo = Date.now() - 2 * 60 * 60 * 1000;

	try {
		const events = readFileSync(EVENTS_FILE, "utf-8").trim().split("\n");
		// Read last 200 lines for efficiency
		const tail = events.slice(-200);
		for (const line of tail) {
			try {
				const ev = JSON.parse(line);
				const evTime = new Date(ev.ts).getTime();
				if (evTime < twoHoursAgo) continue;

				if (ev.type === "message_sent" || ev.type === "image_sent") {
					recentMessages.push(
						`[${ev.ts}] ${ev.type}: ${(ev.text ?? ev.caption ?? "").slice(0, 300)}`
					);
				}
				if (ev.level === "error") {
					recentErrors.push(
						`[${ev.ts}] ${ev.type}: ${(ev.message ?? ev.error ?? "").slice(0, 200)}`
					);
				}
			} catch {
				// skip malformed lines
			}
		}
	} catch {
		// events.jsonl might not exist yet
	}

	// Taskboard
	let taskboard = "";
	try {
		taskboard = readFileSync(TASKBOARD_FILE, "utf-8").slice(0, 2000);
	} catch {
		// no taskboard yet
	}

	return { recentMessages, taskboard, recentErrors, currentTime, timezone };
}

// ---------------------------------------------------------------------------
// Fast local checks (no LLM needed)
// ---------------------------------------------------------------------------

/** Check format rules without an LLM call. */
export function checkFormatRules(messageText: string): SentinelIssue[] {
	const issues: SentinelIssue[] = [];
	const lines = messageText.split("\n").filter((l) => l.trim().length > 0);

	// Line count (exclude the header line with emoji)
	const contentLines = lines.filter((l) => !l.startsWith("📋") && !l.startsWith("📬") && l.trim());
	if (contentLines.length > 20) {
		issues.push({
			type: "format",
			severity: "high",
			description: `Message has ${contentLines.length} lines (rule: 3-5 max per message unless detailed brief)`,
			suggestion: "Condense to scannable bullets. Move detail to Google Doc.",
		});
	}

	// Banned openers
	const firstLine = lines[0]?.trim() ?? "";
	for (const opener of FORMAT_RULES.bannedOpeners) {
		if (firstLine.toLowerCase().startsWith(opener.toLowerCase())) {
			issues.push({
				type: "format",
				severity: "low",
				description: `Message starts with banned opener: "${opener}"`,
				suggestion: "Lead with content, not pleasantries.",
			});
			break;
		}
	}

	// Bullet word count
	const bullets = lines.filter((l) => l.trim().startsWith("•") || l.trim().startsWith("-"));
	for (const bullet of bullets) {
		const words = bullet.replace(/^[•-]\s*/, "").split(/\s+/).length;
		if (words > 18) {
			issues.push({
				type: "format",
				severity: "low",
				description: `Bullet has ${words} words (rule: max 10-12)`,
				suggestion: "Shorten bullet to core info. Details in sub-bullet or doc.",
			});
			break; // only flag once
		}
	}

	return issues;
}

/** Check for duplicate content against recent messages. */
export function checkDedup(messageText: string, recentMessages: string[]): SentinelIssue[] {
	const issues: SentinelIssue[] = [];
	if (recentMessages.length === 0) return issues;

	// Extract key phrases (4+ word sequences) from current message
	const phrases = extractKeyPhrases(messageText);

	for (const prior of recentMessages) {
		const priorPhrases = extractKeyPhrases(prior);
		const overlapping = phrases.filter((p) => priorPhrases.includes(p));

		if (overlapping.length >= 2) {
			issues.push({
				type: "dedup",
				severity: "high",
				description: `Duplicate content found in recent message: "${overlapping[0]}"`,
				suggestion:
					"Check taskboard before composing message. Skip items already reported in prior brief.",
			});
			break;
		}
	}

	return issues;
}

/** Extract 4+ word phrases from text for dedup comparison. */
function extractKeyPhrases(text: string): string[] {
	const words = text
		.toLowerCase()
		.replace(/[^\w\s]/g, "")
		.split(/\s+/);
	const phrases: string[] = [];
	for (let i = 0; i <= words.length - 4; i++) {
		phrases.push(words.slice(i, i + 4).join(" "));
	}
	return phrases;
}

/** Check timing consistency (label vs actual time). */
export function checkTiming(
	messageText: string,
	label: string,
	currentTime: string,
	_timezone: string
): SentinelIssue[] {
	const issues: SentinelIssue[] = [];
	const hour = new Date(currentTime).getHours();

	// Check for label/time mismatches
	const timingMap: Record<string, { expectedRange: [number, number]; label: string }> = {
		"morning-brief": { expectedRange: [6, 10], label: "Morning" },
		"midday-check": { expectedRange: [11, 14], label: "Midday" },
		"evening-wrap": { expectedRange: [15, 20], label: "Evening" },
	};

	const expected = timingMap[label];
	if (expected) {
		const [min, max] = expected.expectedRange;
		if (hour < min || hour > max) {
			issues.push({
				type: "timing",
				severity: "high",
				description: `"${expected.label}" skill fired at ${hour}:xx (expected ${min}-${max}:xx). Possible scheduler misconfiguration.`,
				suggestion: "Check edith.ts scheduler schedule and timezone settings.",
			});
		}

		// Check if the message text itself has wrong time label
		const textLower = messageText.toLowerCase();
		if (
			(label === "morning-brief" && textLower.includes("midday")) ||
			(label === "midday-check" && textLower.includes("morning brief")) ||
			(label === "evening-wrap" && textLower.includes("midday"))
		) {
			issues.push({
				type: "timing",
				severity: "critical",
				description: `Message text contains wrong time-of-day label for a ${label} dispatch`,
				suggestion: "Skill prompt or template has wrong label. Fix the SKILL.md.",
			});
		}
	}

	return issues;
}

/** Check for repeated error patterns in events.jsonl. */
export function checkSystemHealth(recentErrors: string[]): SentinelIssue[] {
	const issues: SentinelIssue[] = [];
	if (recentErrors.length === 0) return issues;

	// Count error types
	const errorCounts: Record<string, number> = {};
	for (const err of recentErrors) {
		const match = err.match(/\] (\w+):/);
		const type = match?.[1] ?? "unknown";
		errorCounts[type] = (errorCounts[type] ?? 0) + 1;
	}

	for (const [type, count] of Object.entries(errorCounts)) {
		if (count >= 5) {
			issues.push({
				type: "system_health",
				severity: count >= 10 ? "critical" : "high",
				description: `Error "${type}" occurred ${count} times in the last 2h`,
				suggestion: "Check events.jsonl for pattern. May indicate a loop or misconfiguration.",
			});
		}
	}

	return issues;
}

// ---------------------------------------------------------------------------
// LLM-powered deep evaluation
// ---------------------------------------------------------------------------

/** Build the prompt for the Sentinel LLM evaluation. */
function buildSentinelPrompt(
	messageText: string,
	label: string,
	localContext: ReturnType<typeof gatherLocalContext>,
	localIssues: SentinelIssue[]
): string {
	const sections: string[] = [];

	sections.push(
		`You are the Sentinel — a quality evaluation agent for an AI assistant called Edith. Edith just sent a message to her user Randy via Telegram. Your job is to evaluate this message for accuracy, completeness, and quality.`
	);

	sections.push(
		`## Message Sent\nSkill: ${label}\nTime: ${localContext.currentTime} (${localContext.timezone})\n\n${messageText}`
	);

	if (localContext.recentMessages.length > 0) {
		sections.push(`## Recent Messages (last 2h)\n${localContext.recentMessages.join("\n")}`);
	}

	if (localContext.taskboard) {
		sections.push(`## Taskboard (today's context)\n${localContext.taskboard.slice(0, 1500)}`);
	}

	if (localContext.recentErrors.length > 0) {
		sections.push(`## Recent System Errors\n${localContext.recentErrors.slice(0, 10).join("\n")}`);
	}

	if (localIssues.length > 0) {
		sections.push(
			`## Already Detected (local checks)\n${localIssues.map((i) => `- [${i.severity}] ${i.type}: ${i.description}`).join("\n")}`
		);
	}

	sections.push(
		`## Your Evaluation\nCheck for issues the local checks might have missed:\n1. **Completeness**: Is there important context missing? (upcoming meetings, urgent emails, unresolved incidents)\n2. **Accuracy**: Do any claims seem stale or wrong based on the taskboard/error log?\n3. **Missed opportunities**: Based on recent context, should Edith have mentioned something she didn't?\n4. **System bugs**: Do the error logs suggest a recurring system problem that should be filed as a GitHub issue?\n5. **Improvements**: What process changes would prevent issues like these?\n\nRespond in this exact JSON format:\n{\n  "score": <1-10>,\n  "issues": [{"type": "<type>", "severity": "<critical|high|low>", "description": "<what's wrong>", "suggestion": "<how to fix>"}],\n  "improvements": ["<process improvement suggestion>"],\n  "systemBugs": [{"description": "<bug>", "evidence": "<from logs>"}]\n}\n\nKnown issue types: accuracy, freshness, dedup, timing, format, completeness, missed_opportunity, system_health, cost.\nYou are NOT limited to these — if you discover a new category (e.g. "tone", "privacy_leak", "urgency_misclass", "context_gap"), use it. New types help us improve the system.\n\nIf the message is excellent and you find no issues, return score 9-10 with empty arrays. Be concise.`
	);

	return sections.join("\n\n");
}

/** Call the Sentinel model (Haiku for speed). */
async function callSentinelModel(prompt: string): Promise<string> {
	const handle = query({
		prompt,
		options: {
			model: "claude-haiku-4-5-20251001",
			persistSession: false,
			maxTurns: 1,
			cwd: PROJECT_ROOT,
			systemPrompt:
				"You are a concise quality evaluation agent. Respond only in valid JSON. No markdown fences.",
			permissionMode: "bypassPermissions",
			allowDangerouslySkipPermissions: true,
		},
	});

	let result = "";
	for await (const message of handle) {
		if (message.type === "assistant") {
			const content = message.message?.content as
				| Array<{ type: string; text?: string }>
				| undefined;
			const textBlock = content?.find((b) => b.type === "text");
			if (textBlock?.text) result = textBlock.text;
		}
		if (message.type === "result" && "result" in message) {
			const resultText = message.result;
			if (typeof resultText === "string") result = resultText || result;
		}
	}

	return result;
}

/** Parse the LLM response into a SentinelVerdict. */
function parseVerdict(raw: string): SentinelVerdict | null {
	try {
		// Strip markdown fences if present
		const cleaned = raw
			.replace(/^```json?\n?/m, "")
			.replace(/\n?```$/m, "")
			.trim();
		const parsed = JSON.parse(cleaned);

		return {
			score: Math.min(10, Math.max(0, Number(parsed.score ?? 5))),
			issues: Array.isArray(parsed.issues) ? parsed.issues : [],
			improvements: Array.isArray(parsed.improvements) ? parsed.improvements : [],
			systemBugs: Array.isArray(parsed.systemBugs) ? parsed.systemBugs : [],
		};
	} catch {
		edithLog.warn("sentinel_parse_failed", { raw: raw.slice(0, 300) });
		return null;
	}
}

// ---------------------------------------------------------------------------
// Actions — what to do with findings
// ---------------------------------------------------------------------------

/** File a GitHub issue for critical bugs or system issues. */
function fileGitHubIssue(title: string, body: string, labels: string[]): void {
	try {
		const labelArgs = labels.map((l) => `-l "${l}"`).join(" ");
		execSync(
			`cd "${PROJECT_ROOT}" && gh issue create --title "${title.replace(/"/g, '\\"')}" --body "$(cat <<'SENTINEL_EOF'\n${body}\nSENTINEL_EOF\n)" ${labelArgs}`,
			{ timeout: 15_000, stdio: "pipe" }
		);
		edithLog.info("sentinel_issue_filed", { title, labels });
	} catch (err) {
		edithLog.error("sentinel_issue_failed", {
			title,
			error: err instanceof Error ? err.message : String(err),
		});
	}
}

/** Append finding to sentinel-report.md for trend analysis. */
function appendToReport(verdict: SentinelVerdict, label: string): void {
	try {
		const entry = [
			`## ${new Date().toISOString()} — ${label} (score: ${verdict.score}/10)`,
			...verdict.issues.map((i) => `- [${i.severity}] **${i.type}**: ${i.description}`),
			...verdict.improvements.map((s) => `- 💡 ${s}`),
			"",
		].join("\n");
		appendFileSync(SENTINEL_REPORT_FILE, entry);
	} catch {
		// report file write is best-effort
	}
}

/** Act on the verdict — log, file issues, update report. */
function actOnFindings(verdict: SentinelVerdict, label: string): void {
	// Always log the evaluation
	edithLog.info("sentinel_evaluation", {
		label,
		score: verdict.score,
		issueCount: verdict.issues.length,
		bugCount: verdict.systemBugs.length,
		improvementCount: verdict.improvements.length,
		issues: verdict.issues.map((i) => `[${i.severity}] ${i.type}: ${i.description}`),
	});

	// File GitHub issues for critical findings
	for (const issue of verdict.issues) {
		if (issue.severity === "critical") {
			fileGitHubIssue(
				`[sentinel] ${issue.type}: ${issue.description.slice(0, 80)}`,
				`## Sentinel Detection\n\n**Type:** ${issue.type}\n**Severity:** ${issue.severity}\n**Skill:** ${label}\n\n### Description\n${issue.description}\n\n### Suggestion\n${issue.suggestion}\n\n---\n*Auto-filed by Sentinel quality agent*`,
				["sentinel-detected", "bug"]
			);
		}
	}

	// File GitHub issues for system bugs
	for (const bug of verdict.systemBugs) {
		fileGitHubIssue(
			`[sentinel] system: ${bug.description.slice(0, 80)}`,
			`## System Bug Detected by Sentinel\n\n### Description\n${bug.description}\n\n### Evidence\n${bug.evidence}\n\n---\n*Auto-filed by Sentinel quality agent*`,
			["sentinel-detected", "bug"]
		);
	}

	// Append to report for high+ findings
	if (verdict.issues.some((i) => i.severity !== "low") || verdict.systemBugs.length > 0) {
		appendToReport(verdict, label);
	}
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Evaluate an outbound message. Call fire-and-forget after send_message.
 *
 * @param messageText - The full message text sent to Randy
 * @param label - The skill/dispatch label (e.g., "morning-brief", "message")
 * @param metadata - Additional context (chatId, etc.)
 */
export async function evaluateOutboundMessage(
	messageText: string,
	label: string,
	_metadata: Record<string, unknown> = {}
): Promise<SentinelVerdict | null> {
	if (!SENTINEL_ENABLED) return null;
	// Skip very short messages (reactions, confirmations)
	if (messageText.length < 30) return null;

	try {
		// Step 1: Gather local context (fast, no API calls)
		const localContext = gatherLocalContext();

		// Step 2: Run fast local checks
		const localIssues: SentinelIssue[] = [
			...checkFormatRules(messageText),
			...checkDedup(messageText, localContext.recentMessages),
			...checkTiming(messageText, label, localContext.currentTime, localContext.timezone),
			...checkSystemHealth(localContext.recentErrors),
		];

		// Step 3: LLM deep evaluation (includes local issues as context)
		const prompt = buildSentinelPrompt(messageText, label, localContext, localIssues);
		const raw = await callSentinelModel(prompt);
		const llmVerdict = parseVerdict(raw);

		// Merge local + LLM findings
		const verdict: SentinelVerdict = {
			score: llmVerdict?.score ?? (localIssues.length === 0 ? 8 : 5),
			issues: [...localIssues, ...(llmVerdict?.issues ?? [])],
			improvements: llmVerdict?.improvements ?? [],
			systemBugs: llmVerdict?.systemBugs ?? [],
		};

		// Step 4: Act on findings
		actOnFindings(verdict, label);

		return verdict;
	} catch (err) {
		edithLog.error("sentinel_failed", {
			label,
			error: err instanceof Error ? err.message : String(err),
		});
		return null;
	}
}
