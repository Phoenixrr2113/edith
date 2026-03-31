/**
 * OTEL + Langfuse tracing — must be imported FIRST in edith.ts.
 *
 * Auto-instruments every Claude Agent SDK query(), tool call, and agent spawn.
 * No changes to business logic required. Traces visible at LANGFUSE_BASE_URL.
 *
 * Set LANGFUSE_PUBLIC_KEY, LANGFUSE_SECRET_KEY, LANGFUSE_BASE_URL in .env.
 * If Langfuse is not running, tracing silently no-ops.
 *
 * Sentry: set SENTRY_DSN in .env for crash/exception tracking.
 * Falls back to no-op if not set.
 */

import { ClaudeAgentSDKInstrumentation } from "@arizeai/openinference-instrumentation-claude-agent-sdk";
import { LangfuseSpanProcessor } from "@langfuse/otel";
import { NodeSDK } from "@opentelemetry/sdk-node";
import * as Sentry from "@sentry/node";

// Initialize Sentry before OTEL so it can capture instrumentation errors too
if (process.env.SENTRY_DSN) {
	Sentry.init({
		dsn: process.env.SENTRY_DSN,
		environment: process.env.NODE_ENV ?? "production",
		// Capture 10% of transactions for performance monitoring
		tracesSampleRate: 0.1,
	});
}

const sdk = new NodeSDK({
	spanProcessors: [new LangfuseSpanProcessor()],
	instrumentations: [new ClaudeAgentSDKInstrumentation()],
});

sdk.start();
