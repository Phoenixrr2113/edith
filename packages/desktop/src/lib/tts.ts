/**
 * Unified TTS interface.
 *
 * Routes speech synthesis to the active provider (Cartesia cloud or Piper
 * local) based on settings. Falls back gracefully when a provider is
 * unavailable.
 *
 * Usage:
 *   import { speak } from './tts.js';
 *   await speak('Hello, world!');
 */

import { playAudio } from "./audio.js";
import { settingsStore } from "./settings.svelte.js";
import { synthesize as cartesiaSynthesize } from "./tts-cartesia.js";
import { DEFAULT_PIPER_URL, synthesize as piperSynthesize } from "./tts-piper.svelte.js";

/**
 * Speak the given text using the configured TTS provider.
 *
 * - "cartesia": calls Cartesia Sonic API, plays the returned audio.
 * - "piper":    placeholder — Piper (local) TTS (VOICE-TTS-105).
 * - "none":     no-op.
 *
 * Errors from the provider are logged but not re-thrown so callers never
 * crash due to a TTS failure.
 */
export async function speak(text: string): Promise<void> {
	const s = settingsStore.value;

	if (!s.ttsEnabled) return;

	const provider = s.ttsProvider;

	if (provider === "none") return;

	if (provider === "cartesia") {
		const apiKey = s.cartesiaApiKey.trim();
		if (!apiKey) {
			console.warn(
				"[tts] Cartesia provider selected but cartesiaApiKey is not set — trying Piper fallback."
			);
			await speakViaPiper(text);
			return;
		}
		try {
			const base64Audio = await cartesiaSynthesize(text, apiKey, {
				voiceId: s.cartesiaVoiceId || undefined,
			});
			await playAudio(base64Audio, "audio/mpeg");
		} catch (err) {
			console.error("[tts] Cartesia synthesis failed — trying Piper fallback:", err);
			await speakViaPiper(text);
		}
		return;
	}

	if (provider === "piper") {
		await speakViaPiper(text);
		return;
	}
}

/**
 * Internal helper: synthesize via local Piper HTTP server and play audio.
 * Silently no-ops if Piper is unreachable.
 */
async function speakViaPiper(text: string): Promise<void> {
	try {
		const base64Audio = await piperSynthesize(text, DEFAULT_PIPER_URL);
		// Piper outputs WAV audio
		await playAudio(base64Audio, "audio/wav");
	} catch (err) {
		console.error("[tts] Piper synthesis failed:", err);
	}
}
