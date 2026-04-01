/**
 * Gemini Flash-Lite — cheap/fast model for summarization tasks.
 * Uses the same Google API key as image generation.
 * Keeps expensive Claude calls focused on decisions and actions.
 */
import { GoogleGenerativeAI } from "@google/generative-ai";
import { GOOGLE_API_KEY } from "./config";
import { edithLog } from "./edith-logger";
import type { ScreenContext } from "./screenpipe";
import { fmtErr } from "./util";

const MODEL = "gemini-2.5-flash";

let client: GoogleGenerativeAI | null = null;

function getClient(): GoogleGenerativeAI | null {
	if (!GOOGLE_API_KEY) return null;
	if (!client) client = new GoogleGenerativeAI(GOOGLE_API_KEY);
	return client;
}

/**
 * Generate images using Google's Imagen model.
 * Returns base64 data URLs ready for Telegram photo sending.
 */
export async function generateImages(
	prompt: string,
	numberOfImages: number = 1
): Promise<string[]> {
	const ai = getClient();
	if (!ai) throw new Error("GOOGLE_GENERATIVE_AI_API_KEY not set in .env");

	const model = ai.getGenerativeModel({ model: "imagen-3.0-generate-001" });
	const result = await model.generateContent({
		contents: [{ role: "user", parts: [{ text: prompt }] }],
		// `responseModalities` is not in the public SDK type for GenerationConfig but is required
		// by Imagen models — cast to satisfy the type checker.
		generationConfig: { responseModalities: ["image"], candidateCount: numberOfImages } as Record<
			string,
			unknown
		>,
	});

	const images: string[] = [];
	for (const c of result.response.candidates || [])
		for (const p of c.content.parts)
			if (p.inlineData?.data)
				images.push(`data:${p.inlineData.mimeType};base64,${p.inlineData.data}`);
	return images;
}

/**
 * Summarize screenpipe context using Gemini Flash-Lite.
 * Returns a concise summary for Claude to reason about.
 * Falls back to raw formatted context if Gemini is unavailable.
 */
export async function summarizeScreenContext(
	ctx: ScreenContext,
	rawFormatted: string
): Promise<string> {
	if (ctx.empty) return "No screen activity data available.";

	// Skip LLM for simple contexts (same optimization as life-guardian)
	if (ctx.apps.length <= 3 && ctx.audioTranscripts.length <= 2) {
		return rawFormatted;
	}

	const ai = getClient();
	if (!ai) return rawFormatted;

	try {
		const model = ai.getGenerativeModel({ model: MODEL });

		const result = await model.generateContent({
			contents: [
				{
					role: "user",
					parts: [
						{
							text: `Summarize this user activity context. Focus on:
- What apps/activities dominated their time
- Signs of hyperfocus (same app for hours)
- Food/drink related activity or lack thereof
- Voice/audio context that indicates their state
- Time-sensitive activities (calendar, meetings)
- Any signs of being stuck or frustrated

Keep the summary under 300 words. Be factual and specific.

${rawFormatted}`,
						},
					],
				},
			],
			systemInstruction: {
				role: "user",
				parts: [
					{
						text: "You are a context summarizer for a personal assistant. Distill user screen and audio activity into a clear, actionable summary. Be concise.",
					},
				],
			},
			generationConfig: {
				maxOutputTokens: 400,
			},
		});

		const text = result.response.text();
		if (text?.trim()) return text.trim();
		return rawFormatted;
	} catch (err) {
		edithLog.warn("gemini_summarization_failed", {
			error: fmtErr(err),
			inputLength: rawFormatted.length,
		});
		return rawFormatted;
	}
}
