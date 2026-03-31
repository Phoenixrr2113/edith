/**
 * OpenTelemetry instrumentation for Langfuse tracing.
 *
 * Loaded via `bun --preload` so it runs before all other code.
 * Wraps the Claude Agent SDK with the Arize OpenInference instrumentation,
 * sending spans to Langfuse via the OTEL span processor.
 *
 * CRASH-SAFE: Everything is wrapped in try/catch. If Langfuse is down,
 * misconfigured, or the packages fail, Edith runs normally without tracing.
 */
export {};

try {
	const publicKey = process.env.LANGFUSE_PUBLIC_KEY;
	const secretKey = process.env.LANGFUSE_SECRET_KEY;

	if (!publicKey || !secretKey) {
		console.log("[instrument] Langfuse keys not set — tracing disabled");
	} else {
		const { NodeSDK } = await import("@opentelemetry/sdk-node");
		const { LangfuseSpanProcessor, isDefaultExportSpan } = await import("@langfuse/otel");
		const { ClaudeAgentSDKInstrumentation } = await import(
			"@arizeai/openinference-instrumentation-claude-agent-sdk"
		);

		const instrumentation = new ClaudeAgentSDKInstrumentation();

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

		// Flush on shutdown
		process.on("beforeExit", async () => {
			try {
				await sdk.shutdown();
			} catch {}
		});
	}
} catch (err) {
	// NEVER crash Edith because of tracing
	console.warn("[instrument] Langfuse tracing failed to initialize:", err);
	console.warn("[instrument] Continuing without tracing — Edith will run normally");
}
