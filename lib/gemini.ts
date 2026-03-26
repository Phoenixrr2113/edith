/**
 * Gemini Flash-Lite — cheap/fast model for summarization tasks.
 * Uses the same Google API key as image generation.
 * Keeps expensive Claude calls focused on decisions and actions.
 */
import { GoogleGenerativeAI } from "@google/generative-ai";
import { GOOGLE_API_KEY } from "./config";
import { fmtErr } from "./util";
import type { ScreenContext } from "./screenpipe";

const MODEL = "gemini-2.5-flash-lite-preview-06-17";

let client: GoogleGenerativeAI | null = null;

function getClient(): GoogleGenerativeAI | null {
  if (!GOOGLE_API_KEY) return null;
  if (!client) client = new GoogleGenerativeAI(GOOGLE_API_KEY);
  return client;
}

/**
 * Summarize screenpipe context using Gemini Flash-Lite.
 * Returns a concise summary for Claude to reason about.
 * Falls back to raw formatted context if Gemini is unavailable.
 */
export async function summarizeScreenContext(ctx: ScreenContext, rawFormatted: string): Promise<string> {
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
      contents: [{
        role: "user",
        parts: [{ text: `Summarize this user activity context. Focus on:
- What apps/activities dominated their time
- Signs of hyperfocus (same app for hours)
- Food/drink related activity or lack thereof
- Voice/audio context that indicates their state
- Time-sensitive activities (calendar, meetings)
- Any signs of being stuck or frustrated

Keep the summary under 300 words. Be factual and specific.

${rawFormatted}` }],
      }],
      systemInstruction: {
        role: "user",
        parts: [{ text: "You are a context summarizer for a personal assistant. Distill user screen and audio activity into a clear, actionable summary. Be concise." }],
      },
      generationConfig: {
        maxOutputTokens: 400,
      },
    });

    const text = result.response.text();
    if (text?.trim()) return text.trim();
    return rawFormatted;
  } catch (err) {
    console.warn("[gemini] Summarization failed, using raw context:", fmtErr(err));
    return rawFormatted;
  }
}
