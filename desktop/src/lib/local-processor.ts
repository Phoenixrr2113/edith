/**
 * LocalProcessor — routes screen-frame analysis locally (Ollama) when possible,
 * falling back to cloud Gemini when no local vision model is available.
 *
 * Privacy guarantee: in preferLocal mode, raw frames NEVER leave the device.
 * Only the resulting text summary is forwarded upstream.
 *
 * Issue: INFRA-LOCAL-093
 */

import { detectOllama, type OllamaModel } from "./ollama.js";
import { settingsStore } from "./settings.js";

// ── Types ─────────────────────────────────────────────────────────────────────

export interface ProcessorConfig {
	/**
	 * Prefer local Ollama processing over cloud Gemini.
	 * Defaults to false (cloud first). Set true for privacy mode.
	 */
	preferLocal: boolean;
	/** Ollama base URL — defaults to settingsStore.value.ollamaUrl */
	ollamaUrl?: string;
	/**
	 * Vision model names to look for in Ollama, in priority order.
	 * First match wins.
	 */
	visionModels?: string[];
}

export interface ProcessResult {
	/** Text summary produced by the model. */
	summary: string;
	/** Which backend produced this result. */
	backend: "local-ollama" | "cloud-gemini";
	/** The model name used. */
	model: string;
	/** Processing time in ms. */
	durationMs: number;
}

// ── Default vision models (Ollama) ────────────────────────────────────────────

/**
 * Vision-capable models that Ollama supports, in preference order.
 * llava variants are fastest; llama3.2-vision is higher quality but larger.
 */
const DEFAULT_VISION_MODELS: string[] = [
	"llama3.2-vision",
	"llava:13b",
	"llava:7b",
	"llava",
	"moondream",
	"bakllava",
];

// ── Ollama inference helper ───────────────────────────────────────────────────

/**
 * Send a frame to a local Ollama vision model.
 * Uses the /api/generate endpoint with `images` array.
 *
 * @throws If the request fails or the model returns an error.
 */
async function runOllamaVision(
	baseUrl: string,
	model: string,
	imageBase64: string,
	prompt: string
): Promise<string> {
	const body = {
		model,
		prompt,
		images: [imageBase64],
		stream: false,
		options: {
			// Keep the response concise — we want a terse context summary, not an essay
			num_predict: 200,
			temperature: 0.1,
		},
	};

	const res = await fetch(`${baseUrl}/api/generate`, {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify(body),
	});

	if (!res.ok) {
		const text = await res.text().catch(() => "(no body)");
		throw new Error(`Ollama ${model} returned ${res.status}: ${text}`);
	}

	const json = (await res.json()) as { response?: string; error?: string };
	if (json.error) throw new Error(`Ollama error: ${json.error}`);
	return json.response ?? "";
}

// ── Cloud Gemini stub ─────────────────────────────────────────────────────────

/**
 * Placeholder for the cloud Gemini call.
 * The real implementation lives in the cloud-transport / gemini modules.
 * LocalProcessor calls this as its fallback; callers should wire up a real
 * implementation via `setCloudProcessor()` before use.
 */
let _cloudProcessor: ((imageBase64: string, prompt: string) => Promise<string>) | null = null;

/**
 * Register the cloud processing callback.
 * Call this once at app startup with the real Gemini send function.
 *
 * @example
 * import { setCloudProcessor } from './local-processor.js';
 * import { sendFrameToGemini } from './gemini.js';
 * setCloudProcessor(sendFrameToGemini);
 */
export function setCloudProcessor(
	fn: (imageBase64: string, prompt: string) => Promise<string>
): void {
	_cloudProcessor = fn;
}

// ── LocalProcessor class ──────────────────────────────────────────────────────

export class LocalProcessor {
	private config: Required<ProcessorConfig>;

	constructor(config: Partial<ProcessorConfig> = {}) {
		this.config = {
			preferLocal: config.preferLocal ?? false,
			ollamaUrl: config.ollamaUrl ?? settingsStore.value.ollamaUrl,
			visionModels: config.visionModels ?? DEFAULT_VISION_MODELS,
		};
	}

	/**
	 * Update processor config at runtime (e.g. when settings change).
	 */
	configure(updates: Partial<ProcessorConfig>): void {
		this.config = { ...this.config, ...updates };
	}

	/**
	 * Find the first available vision model in Ollama.
	 * Returns null if Ollama is not running or has no vision model.
	 */
	async findLocalVisionModel(): Promise<OllamaModel | null> {
		const status = await detectOllama(this.config.ollamaUrl, { useCache: true });
		if (!status.running) return null;

		for (const preferred of this.config.visionModels) {
			const found = status.models.find(
				(m) => m.name === preferred || m.name.startsWith(`${preferred}:`)
			);
			if (found) return found;
		}

		// Accept any model whose name contains a vision keyword
		const visionKeywords = ["vision", "llava", "moondream", "bakllava", "minicpm-v"];
		const fallback = status.models.find((m) =>
			visionKeywords.some((kw) => m.name.toLowerCase().includes(kw))
		);
		return fallback ?? null;
	}

	/**
	 * Process a screen frame and return a text summary.
	 *
	 * Routing:
	 *  - If `preferLocal` is true: try Ollama first, fall back to cloud only if
	 *    no vision model is available.
	 *  - If `preferLocal` is false: use cloud Gemini directly (current default).
	 *
	 * @param imageBase64  Base64-encoded PNG/JPEG screen frame.
	 * @param prompt       Instruction to the vision model. Defaults to a
	 *                     terse context-summary prompt.
	 */
	async process(
		imageBase64: string,
		prompt: string = DEFAULT_SCREEN_PROMPT
	): Promise<ProcessResult> {
		const start = Date.now();

		if (this.config.preferLocal) {
			const model = await this.findLocalVisionModel();
			if (model) {
				try {
					const summary = await runOllamaVision(
						this.config.ollamaUrl,
						model.name,
						imageBase64,
						prompt
					);
					return {
						summary,
						backend: "local-ollama",
						model: model.name,
						durationMs: Date.now() - start,
					};
				} catch (err) {
					console.warn(
						`[local-processor] Ollama vision failed (${model.name}), falling back to cloud:`,
						err
					);
				}
			} else {
				console.info(
					"[local-processor] No local vision model found; falling back to cloud Gemini."
				);
			}
		}

		// Cloud path
		return this._processCloud(imageBase64, prompt, start);
	}

	private async _processCloud(
		imageBase64: string,
		prompt: string,
		start: number
	): Promise<ProcessResult> {
		if (!_cloudProcessor) {
			throw new Error(
				"[local-processor] No cloud processor registered. " +
					"Call setCloudProcessor() at startup before using LocalProcessor."
			);
		}
		const summary = await _cloudProcessor(imageBase64, prompt);
		return {
			summary,
			backend: "cloud-gemini",
			model: "gemini-2.0-flash-live",
			durationMs: Date.now() - start,
		};
	}
}

// ── Default prompt ────────────────────────────────────────────────────────────

/**
 * Terse context-summary prompt used when no custom prompt is given.
 * Designed for 1 FPS ambient screen capture: produce a single sentence
 * that captures the essential activity without quoting private data.
 */
const DEFAULT_SCREEN_PROMPT =
	"In one sentence, describe what the user is currently doing on their computer. " +
	"Focus on the app and high-level task. Do not quote any private content like passwords, " +
	"email bodies, or personal data.";

// ── Module-level singleton ────────────────────────────────────────────────────

/** Shared instance. Configure via `localProcessor.configure(...)`. */
export const localProcessor = new LocalProcessor();
