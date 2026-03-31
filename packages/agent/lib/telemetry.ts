/**
 * OTEL + Langfuse tracing — must be imported FIRST in edith.ts.
 *
 * Auto-instruments every Claude Agent SDK query(), tool call, and agent spawn.
 * Traces visible at LANGFUSE_BASE_URL (default: http://localhost:3000).
 *
 * Sentry is initialized separately via instrument.ts (loaded with bun --preload).
 */

import { ClaudeAgentSDKInstrumentation } from "@arizeai/openinference-instrumentation-claude-agent-sdk";
import { LangfuseSpanProcessor } from "@langfuse/otel";
import { NodeSDK } from "@opentelemetry/sdk-node";

const publicKey = process.env.LANGFUSE_PUBLIC_KEY ?? "";
const secretKey = process.env.LANGFUSE_SECRET_KEY ?? "";
const baseUrl = process.env.LANGFUSE_BASE_URL ?? "http://localhost:3000";

if (publicKey && secretKey) {
	const processor = new LangfuseSpanProcessor({
		publicKey,
		secretKey,
		baseUrl,
	});

	const sdk = new NodeSDK({
		spanProcessors: [processor],
		instrumentations: [new ClaudeAgentSDKInstrumentation()],
	});

	sdk.start();
	console.log(`[telemetry] OTEL + Langfuse initialized (${baseUrl})`);
} else {
	console.warn("[telemetry] Langfuse keys not set — tracing disabled");
}
