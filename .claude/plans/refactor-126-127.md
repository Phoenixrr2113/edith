# Refactor Plan: Split edith.ts (#126) and dispatch.ts (#127)

## Prompt for next session

```
Continue the refactoring work from the previous session. Two issues remain:

## Issue #126: Split edith.ts monolith (540 → ~120 lines)

edith.ts has 9 responsibilities. Extract into focused modules:

1. **Extract processUpdate()** → `lib/telegram-transport.ts`
   - Lines 237-312 of edith.ts
   - Shared handler for both webhook and polling
   - Imports: handlers.ts, state.ts, telegram.ts, edith-logger.ts, config.ts
   - Export: `async function processUpdate(update: Record<string, unknown>): Promise<void>`

2. **Extract poll()** → `lib/telegram-polling.ts`
   - Lines 327-369 of edith.ts
   - Contains: currentOffset, consecutiveErrors, backoff loop
   - Depends on: telegram-transport.ts (processUpdate), telegram.ts (tgCall), state.ts (saveOffset, offset)
   - Export: `async function startPolling(onUpdate: (update: Record<string, unknown>) => Promise<void>): Promise<void>`

3. **Extract webhook helpers** → `lib/telegram-webhook.ts`
   - Lines 372-398 of edith.ts
   - registerWebhook(publicUrl) and deregisterWebhook()
   - Depends on: telegram.ts (tgCall), edith-logger.ts
   - Export both functions + WEBHOOK_SECRET

4. **Extract HTTP server** → `lib/http-server.ts`
   - Lines 114-225 of edith.ts (the entire `if (isCloud)` block)
   - Creates Bun.serve with /health, /webhook/<secret>, /ws routes
   - Depends on: cloud-transport.ts, telegram-transport.ts (processUpdate), config.ts
   - Export: `async function startHttpServer(port: number, webhookSecret: string, processUpdate: Function): Promise<ReturnType<typeof Bun.serve>>`

5. **Extract shutdown** → `lib/shutdown.ts`
   - Lines 440-467 of edith.ts
   - gracefulShutdown() + signal handler registration
   - Depends on: session.ts, dispatch.ts, caffeinate.ts, edith-logger.ts
   - Export: `function registerShutdownHandlers(opts: { isCloud: boolean, httpServer?: Server }): void`

6. **Move isCloud** → `lib/config.ts`
   - Add: `export const IS_CLOUD = !!process.env.RAILWAY_ENVIRONMENT || process.env.CLOUD_MODE === "true"`
   - Update edith.ts to import IS_CLOUD

After extraction, edith.ts should be ~120 lines of pure orchestration:
- Console overrides
- Import modules
- Validate config
- Conditionally start HTTP server
- Bootstrap
- Start scheduler
- Start webhook or polling

## Issue #127: Split dispatch.ts (726 → 3 files)

dispatch.ts is the largest file (726 lines, 3x average). Split into:

1. **dispatch-options.ts** (~100 lines)
   - `buildSdkOptions()` function
   - `spawnWithStderrCapture()` function + `lastStderr` variable
   - `loadMcpConfig()` helper
   - Content block types (ToolUseBlock, TextBlock, ContentBlock)
   - LIGHTWEIGHT_TASKS set

2. **dispatch-stream.ts** (~250 lines)
   - `processMessageStream()` function
   - `StreamResult` interface
   - `ToolCallRecord` interface
   - All reflector injection logic (maybeInject)
   - Message type handlers (assistant, result, system/task events)

3. **dispatch.ts** (~200 lines) — keep as main entry
   - `dispatchToClaude()` function
   - `dispatchToConversation()` function
   - Circuit breaker state (consecutiveFailures, circuitBreakerUntil, lastFailureError, activeLabel)
   - Queue management (busy, dispatchQueue)
   - Re-exports from dispatch-options.ts and dispatch-stream.ts
   - Remove deprecated `DispatchJob` type

Key constraint: existing tests import from `./lib/dispatch` — the re-exports must preserve the same public API so tests don't need changes.

## Execution order
1. Do #127 first (dispatch split) since #126 depends on dispatch exports
2. Then do #126 (edith.ts split)
3. Run full test suite after each
4. Single commit per issue

## Files to read first
- packages/agent/edith.ts (current state)
- packages/agent/lib/dispatch.ts (current state)
- packages/agent/lib/config.ts (add IS_CLOUD)
- packages/agent/tests/dispatch.test.ts (verify imports still work)
```

## Dependency chain
- #127 (dispatch split) has no dependencies, do first
- #126 (edith.ts split) should be done after #127

## What NOT to change
- Don't modify any test files — the refactored modules must maintain the same exports
- Don't change behavior — pure file reorganization
- Don't touch files outside the ownership lists in the ATS specs
