/**
 * Cartesia Sonic TTS integration.
 *
 * Calls the Cartesia REST API (non-streaming) and returns base64-encoded
 * audio ready for audio.ts playback.
 *
 * API reference: https://docs.cartesia.ai/reference/tts/bytes
 */

export interface CartesiaOptions {
	/** Cartesia voice ID. Defaults to the English default voice. */
	voiceId?: string;
	/** Playback speed multiplier (0.5–2.0). Default: 1.0 */
	speed?: number;
	/** BCP-47 language code. Default: "en" */
	language?: string;
}

const CARTESIA_API_URL = "https://api.cartesia.ai/tts/bytes";
const CARTESIA_API_VERSION = "2024-06-10";

/** Cartesia's recommended English voice — "Barbershop Man" */
export const CARTESIA_DEFAULT_VOICE_ID = "a0e99841-438c-4a64-b679-ae501e7d6091";

/**
 * Synthesize text using the Cartesia Sonic API.
 *
 * @param text       Text to synthesize.
 * @param apiKey     Cartesia API key.
 * @param options    Optional voice/speed/language overrides.
 * @returns          Base64-encoded MP3 audio string.
 * @throws           Error if the API call fails or returns a non-OK status.
 */
export async function synthesize(
	text: string,
	apiKey: string,
	options?: CartesiaOptions
): Promise<string> {
	const voiceId = options?.voiceId ?? CARTESIA_DEFAULT_VOICE_ID;
	const language = options?.language ?? "en";

	const body: Record<string, unknown> = {
		model_id: "sonic-2",
		transcript: text,
		voice: {
			mode: "id",
			id: voiceId,
		},
		output_format: {
			container: "mp3",
			encoding: "mp3",
			sample_rate: 44100,
		},
		language,
	};

	if (options?.speed !== undefined) {
		body.speed = options.speed;
	}

	const response = await fetch(CARTESIA_API_URL, {
		method: "POST",
		headers: {
			"Content-Type": "application/json",
			"Cartesia-Version": CARTESIA_API_VERSION,
			"X-API-Key": apiKey,
		},
		body: JSON.stringify(body),
	});

	if (!response.ok) {
		const errorText = await response.text().catch(() => "(no body)");
		throw new Error(
			`[tts-cartesia] API error ${response.status} ${response.statusText}: ${errorText}`
		);
	}

	const arrayBuffer = await response.arrayBuffer();
	const bytes = new Uint8Array(arrayBuffer);

	// Convert binary to base64
	let binary = "";
	for (let i = 0; i < bytes.length; i++) {
		binary += String.fromCharCode(bytes[i]);
	}
	return btoa(binary);
}
