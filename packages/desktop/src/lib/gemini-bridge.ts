/**
 * gemini-bridge.ts — Gemini vision API bridge for screen understanding.
 *
 * sendToGemini() sends a base64-encoded screen capture to Gemini 2.0 Flash
 * and returns a structured ScreenContext describing what is visible.
 *
 * The bridge is deliberately stateless — callers decide when to invoke it.
 * Wire it to ScreenTriggerEngine events for event-driven screen understanding.
 *
 * Requires GOOGLE_GENERATIVE_AI_API_KEY in settings (geminiApiKey).
 */

import { settingsStore } from "./settings.svelte.js";

// ── Types ──────────────────────────────────────────────────────────────────────

/** Structured understanding of the current screen state returned by Gemini. */
export interface ScreenContext {
	/** ISO-8601 timestamp of when this context was produced */
	timestamp: string;
	/** Primary application(s) visible on screen */
	apps: string[];
	/** Summary of what the user is doing */
	activity: string;
	/** Inferred user intent (best-effort) */
	intent: string;
	/** Gemini confidence in the analysis (0–1) */
	confidence: number;
	/** Optional proactive suggestion, only present when Gemini finds one */
	suggestedAction?: string;
}

// ── Gemini REST API types (minimal) ───────────────────────────────────────────

interface GeminiInlinePart {
	inlineData: {
		mimeType: string;
		data: string;
	};
}

interface GeminiTextPart {
	text: string;
}

type GeminiPart = GeminiTextPart | GeminiInlinePart;

interface GeminiContent {
	parts: GeminiPart[];
}

interface GeminiRequest {
	contents: GeminiContent[];
	generationConfig?: {
		responseMimeType?: string;
	};
}

interface GeminiResponse {
	candidates?: Array<{
		content?: {
			parts?: Array<{ text?: string }>;
		};
	}>;
}

// ── Constants ──────────────────────────────────────────────────────────────────

const GEMINI_MODEL = "gemini-2.0-flash";
const GEMINI_BASE = "https://generativelanguage.googleapis.com/v1beta/models";

const SCREEN_ANALYSIS_PROMPT = `Analyze this screenshot and return a JSON object with these fields:
- "apps": array of application names visible (strings, e.g. ["Chrome", "Slack"])
- "activity": one-sentence description of what the user is doing
- "intent": the user's inferred goal or task
- "confidence": your confidence in this analysis from 0.0 to 1.0
- "suggestedAction": optional string with a proactive suggestion if something actionable is visible (omit if nothing useful)

Respond ONLY with valid JSON, no markdown fences.`;

// ── sendToGemini ───────────────────────────────────────────────────────────────

/**
 * Send a base64 screen capture to Gemini for vision analysis.
 *
 * @param base64Image  Base64-encoded PNG (no data-URI prefix needed)
 * @param prompt       Optional override prompt (defaults to screen analysis prompt)
 * @returns            Structured ScreenContext
 * @throws             Error if the API key is missing, the request fails, or JSON
 *                     cannot be parsed from the response
 */
export async function sendToGemini(
	base64Image: string,
	prompt = SCREEN_ANALYSIS_PROMPT
): Promise<ScreenContext> {
	const apiKey = settingsStore.value.geminiApiKey?.trim();
	if (!apiKey) {
		throw new Error("[gemini-bridge] geminiApiKey is not set in settings");
	}

	const url = `${GEMINI_BASE}/${GEMINI_MODEL}:generateContent?key=${encodeURIComponent(apiKey)}`;

	const body: GeminiRequest = {
		contents: [
			{
				parts: [
					{ text: prompt } as GeminiTextPart,
					{
						inlineData: {
							mimeType: "image/png",
							data: base64Image,
						},
					} as GeminiInlinePart,
				],
			},
		],
		generationConfig: {
			responseMimeType: "application/json",
		},
	};

	let response: Response;
	try {
		response = await fetch(url, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify(body),
		});
	} catch (err) {
		throw new Error(
			`[gemini-bridge] Network error: ${err instanceof Error ? err.message : String(err)}`
		);
	}

	if (!response.ok) {
		const text = await response.text().catch(() => "");
		throw new Error(`[gemini-bridge] API error ${response.status}: ${text}`);
	}

	const json = (await response.json()) as GeminiResponse;
	const rawText = json.candidates?.[0]?.content?.parts?.[0]?.text ?? "";

	if (!rawText) {
		throw new Error("[gemini-bridge] Empty response from Gemini");
	}

	let parsed: Partial<ScreenContext>;
	try {
		// Strip any accidental markdown fences before parsing
		const cleaned = rawText
			.replace(/^```(?:json)?\s*/i, "")
			.replace(/\s*```$/, "")
			.trim();
		parsed = JSON.parse(cleaned) as Partial<ScreenContext>;
	} catch {
		throw new Error(`[gemini-bridge] Could not parse Gemini response as JSON: ${rawText}`);
	}

	return {
		timestamp: new Date().toISOString(),
		apps: Array.isArray(parsed.apps) ? (parsed.apps as string[]) : [],
		activity: typeof parsed.activity === "string" ? parsed.activity : "",
		intent: typeof parsed.intent === "string" ? parsed.intent : "",
		confidence: typeof parsed.confidence === "number" ? parsed.confidence : 0.5,
		...(typeof parsed.suggestedAction === "string" && parsed.suggestedAction
			? { suggestedAction: parsed.suggestedAction }
			: {}),
	};
}
