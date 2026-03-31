/**
 * OpenTelemetry instrumentation for Langfuse tracing.
 *
 * Wraps the Claude Agent SDK with the Arize OpenInference instrumentation,
 * sending spans to Langfuse via the OTEL span processor.
 *
 * CRASH-SAFE: Everything is wrapped in try/catch. If Langfuse is down,
 * misconfigured, or the packages fail, the original SDK is re-exported as-is.
 *
 * Usage: import { query } from "./instrument" instead of from the SDK directly.
 */
import * as OriginalSDK from "@anthropic-ai/claude-agent-sdk";

// Re-export everything from the original SDK as defaults
export * from "@anthropic-ai/claude-agent-sdk";

// The patched query function — overrides the re-export above
let patchedQuery = OriginalSDK.query;

try {
	const publicKey = process.env.LANGFUSE_PUBLIC_KEY;
	const secretKey = process.env.LANGFUSE_SECRET_KEY;

	if (publicKey && secretKey) {
		const { NodeSDK } = await import("@opentelemetry/sdk-node");
		const { LangfuseSpanProcessor, isDefaultExportSpan } = await import("@langfuse/otel");
		const { ClaudeAgentSDKInstrumentation } = await import(
			"@arizeai/openinference-instrumentation-claude-agent-sdk"
		);

		const instrumentation = new ClaudeAgentSDKInstrumentation();

		// Create mutable copy and manually instrument
		const sdkCopy = { ...OriginalSDK } as Record<string, unknown>;
		instrumentation.manuallyInstrument(sdkCopy);

		// Grab the patched query from the instrumented copy
		if (typeof sdkCopy.query === "function") {
			patchedQuery = sdkCopy.query as typeof OriginalSDK.query;
		}

		const sdk = new NodeSDK({
			spanProcessors: [
				new LangfuseSpanProcessor({
					shouldExportSpan: ({ otelSpan }) =>
						isDefaultExportSpan(otelSpan) ||
						otelSpan.instrumentationScope.name ===
							"@arizeai/openinference-instrumentation-claude-agent-sdk",
				}),
			],
			instrumentations: [instrumentation],
		});

		sdk.start();

		const baseUrl = process.env.LANGFUSE_BASE_URL ?? "https://cloud.langfuse.com";
		console.log(`[instrument] Langfuse OTEL tracing active (${baseUrl})`);

		process.on("beforeExit", async () => {
			try {
				await sdk.shutdown();
			} catch {}
		});
	} else {
		console.log("[instrument] Langfuse keys not set — tracing disabled");
	}
} catch (err) {
	// NEVER crash Edith because of tracing — patchedQuery stays as original
	console.warn("[instrument] Langfuse tracing failed to initialize:", err);
}

// Export the (possibly patched) query function
export { patchedQuery as query };
