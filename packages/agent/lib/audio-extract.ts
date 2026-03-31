/**
 * Audio knowledge extraction — processes screenpipe audio transcripts
 * through Qwen (via OpenRouter) to extract structured facts,
 * then stores them in Cognee for long-term memory.
 *
 * Flow: screenpipe audio → Qwen 3 235B (extract key facts) → Cognee (graph DB)
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { OPENROUTER_API_KEY, STATE_DIR } from "./config";
import type { AudioTranscript } from "./screenpipe";
import { logEvent } from "./state";
import { fmtErr } from "./util";

const OPENROUTER_URL = "https://openrouter.ai/api/v1/chat/completions";
const MODEL = "qwen/qwen3-235b-a22b";

export interface ExtractedKnowledge {
	type: "meeting" | "call" | "conversation" | "note" | "noise";
	participants?: string[];
	topics?: string[];
	decisions?: string[];
	actionItems?: string[];
	summary: string;
}

/**
 * Extract structured knowledge from audio transcripts using Qwen via OpenRouter.
 * Returns null if transcripts are noise/empty.
 */
export async function extractFromAudio(
	transcripts: AudioTranscript[]
): Promise<ExtractedKnowledge | null> {
	if (!OPENROUTER_API_KEY) return null;
	if (transcripts.length === 0) return null;

	// Combine transcripts into a single block
	const combined = transcripts.map((t) => `[${t.timestamp.slice(11, 19)}] ${t.text}`).join("\n");

	// Skip very short/empty content
	if (combined.replace(/\[.*?\]/g, "").trim().length < 50) return null;

	try {
		const res = await fetch(OPENROUTER_URL, {
			method: "POST",
			headers: {
				"Content-Type": "application/json",
				Authorization: `Bearer ${OPENROUTER_API_KEY}`,
			},
			body: JSON.stringify({
				model: MODEL,
				messages: [
					{
						role: "system",
						content: `You analyze audio transcripts captured from a user's microphone. Extract meaningful knowledge and ignore noise.

Respond with JSON only. No markdown, no explanation.

If the audio is just background noise, music, TV, or unintelligible fragments, respond: {"type": "noise", "summary": ""}

For meaningful audio, respond:
{
  "type": "meeting" | "call" | "conversation" | "note",
  "participants": ["names mentioned or identified"],
  "topics": ["key topics discussed"],
  "decisions": ["any decisions made"],
  "actionItems": ["any action items or follow-ups"],
  "summary": "2-3 sentence summary of what happened"
}

Be strict — only extract facts that are clearly stated. Do not infer or guess.`,
					},
					{
						role: "user",
						content: `Extract knowledge from these audio transcripts:\n\n${combined}`,
					},
				],
				max_tokens: 500,
				temperature: 0.1,
			}),
			signal: AbortSignal.timeout(15_000),
		});

		if (!res.ok) {
			console.warn(`[audio-extract] OpenRouter error: ${res.status}`);
			return null;
		}

		const data = (await res.json()) as { choices?: Array<{ message?: { content?: string } }> };
		const text = data.choices?.[0]?.message?.content?.trim();
		if (!text) return null;

		// Parse JSON response
		const jsonMatch = text.match(/\{[\s\S]*\}/);
		if (!jsonMatch) return null;

		const parsed = JSON.parse(jsonMatch[0]) as ExtractedKnowledge;
		if (parsed.type === "noise" || !parsed.summary) return null;

		logEvent("audio_extracted", {
			type: parsed.type,
			topics: parsed.topics?.join(", "),
			participants: parsed.participants?.join(", "),
		});

		return parsed;
	} catch (err) {
		console.warn("[audio-extract] Extraction failed:", fmtErr(err));
		return null;
	}
}

/**
 * Store extracted knowledge for Cognee ingestion.
 *
 * Cognee runs as an MCP server (SSE transport), not a REST API — so we can't
 * call it directly from outside Claude. Instead, write to a pending file that
 * Claude's session will pick up and store via the cognify MCP tool.
 */
export async function storeInCognee(knowledge: ExtractedKnowledge): Promise<boolean> {
	try {
		const parts: string[] = [
			`[${knowledge.type.toUpperCase()}] ${new Date().toISOString().slice(0, 16)}`,
			knowledge.summary,
		];

		if (knowledge.participants?.length) {
			parts.push(`Participants: ${knowledge.participants.join(", ")}`);
		}
		if (knowledge.topics?.length) {
			parts.push(`Topics: ${knowledge.topics.join(", ")}`);
		}
		if (knowledge.decisions?.length) {
			parts.push(`Decisions: ${knowledge.decisions.join("; ")}`);
		}
		if (knowledge.actionItems?.length) {
			parts.push(`Action items: ${knowledge.actionItems.join("; ")}`);
		}

		const document = parts.join("\n");

		// Write to pending knowledge file for Claude to ingest via Cognee MCP
		const pendingDir = join(STATE_DIR, "pending-knowledge");
		mkdirSync(pendingDir, { recursive: true });
		const filename = `audio-${Date.now()}.json`;
		writeFileSync(
			join(pendingDir, filename),
			JSON.stringify({ document, type: knowledge.type, ts: new Date().toISOString() }, null, 2),
			"utf-8"
		);

		logEvent("audio_pending", {
			type: knowledge.type,
			summary: knowledge.summary.slice(0, 100),
			file: filename,
		});
		console.log(
			`[audio-extract] Queued for Cognee: [${knowledge.type}] ${knowledge.summary.slice(0, 80)}`
		);
		return true;
	} catch (err) {
		console.warn("[audio-extract] Failed to queue knowledge:", fmtErr(err));
		return false;
	}
}

/**
 * Full pipeline: extract knowledge from audio and store in Cognee.
 * Returns the extracted knowledge (or null if nothing meaningful).
 */
export async function processAudioTranscripts(
	transcripts: AudioTranscript[]
): Promise<ExtractedKnowledge | null> {
	const knowledge = await extractFromAudio(transcripts);
	if (!knowledge) return null;

	await storeInCognee(knowledge);
	return knowledge;
}
