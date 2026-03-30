/**
 * OTEL + Langfuse tracing — must be imported FIRST in edith.ts.
 *
 * Auto-instruments every Claude Agent SDK query(), tool call, and agent spawn.
 * No changes to business logic required. Traces visible at LANGFUSE_BASE_URL.
 *
 * Set LANGFUSE_PUBLIC_KEY, LANGFUSE_SECRET_KEY, LANGFUSE_BASE_URL in .env.
 * If Langfuse is not running, tracing silently no-ops.
 */
import { NodeSDK } from "@opentelemetry/sdk-node";
import { LangfuseSpanProcessor } from "@langfuse/otel";
import { ClaudeAgentSDKInstrumentation } from "@arizeai/openinference-instrumentation-claude-agent-sdk";

const sdk = new NodeSDK({
  spanProcessors: [new LangfuseSpanProcessor()],
  instrumentations: [new ClaudeAgentSDKInstrumentation()],
});

sdk.start();
