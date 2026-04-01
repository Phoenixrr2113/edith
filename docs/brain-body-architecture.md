# Edith Architecture: Brain/Body Split

## Context

Cloud migration exposed 10+ issues where cloud Edith calls macOS-only binaries, loads incompatible MCP servers, or lacks a notification path. Rather than patching each issue, we're redesigning the architecture with a clean **brain (cloud) / body (companion app)** split — similar to how Claude Desktop is the local body for Claude's cloud brain.

**Goal**: Any capability that requires the local machine routes through the companion app. The cloud brain never touches macOS APIs directly. Both sides work independently when disconnected.

---

## Architecture

```
                    CLOUD (Railway)                          LOCAL (macOS)
              ┌─────────────────────┐              ┌──────────────────────┐
              │   edith.ts (brain)  │              │  Desktop App (body)  │
              │                     │◄────WSS────►│                      │
              │  - Telegram bot     │              │  - Desktop notifs    │
              │  - Scheduler        │              │  - Screen capture    │
              │  - Agent dispatch   │              │  - Computer use      │
              │  - Gmail/Calendar   │              │  - Audio I/O         │
              │  - Cognee memory    │              │  - Idle detection    │
              │  - BetterStack logs │              │  - File access       │
              │  - Push notifs      │              │  - Clipboard         │
              │  - Session mgmt     │              │  - Screenpipe        │
              └─────────────────────┘              └──────────────────────┘
```

### What goes WHERE

| Capability | Cloud brain | Desktop body | Notes |
|------------|:-----------:|:------------:|-------|
| Telegram messaging | X | | API-based, works anywhere |
| Push notifications | X | | ntfy.sh — works on any device (iOS, Android, macOS, browser) |
| Gmail / Calendar | X | | OAuth + REST API |
| Cognee memory | X | | HTTP to Railway Cognee |
| Scheduling / cron | X | | SQLite + scheduler loop |
| Agent dispatch (Claude) | X | | Agent SDK subprocess |
| BetterStack logging | X | | Remote MCP |
| Desktop notifications | | X | Tauri native notifications (when companion running) |
| Screen capture | | X | xcrun screencapture |
| Computer use | | X | cliclick, osascript |
| Audio capture / TTS | | X | microphone, speakers |
| System idle detection | | X | IOKit ioreg |
| Screenpipe context | | X | localhost:3030 |
| File browsing (local) | | X | Finder, local FS |
| Clipboard | | X | pbcopy/pbpaste |

---

## Key Changes

### 1. MCP Server Filtering (cloud side)

**File**: `packages/agent/lib/dispatch-options.ts`

Cloud mode excludes local-only MCP servers:

```typescript
const CLOUD_EXCLUDED_SERVERS = ['computer-use', 'cognee'];
```

Add `filterMcpServers(config, IS_CLOUD)` that strips incompatible servers before passing to Agent SDK.

### 2. ntfy.sh Push Notifications

**New file**: `packages/agent/lib/ntfy.ts`

Universal push notification service replacing macOS-only terminal-notifier:
- Cloud pushes via `POST https://ntfy.sh/<topic>` (or self-hosted)
- Randy subscribes on any device via ntfy app or browser
- Supports priorities, tags/emojis, action buttons, click URLs
- No SDK needed — just HTTP POST

```typescript
async function pushNotification(title: string, body: string, opts?: {
  priority?: 1 | 2 | 3 | 4 | 5
  tags?: string[]
  click?: string
  actions?: NtfyAction[]
}): Promise<void>
```

### 3. Notification Stack Redesign

**Files**: `packages/agent/lib/notify.ts` + `packages/agent/mcp/tools/messaging.ts`

Replace macOS binary calls with multi-channel routing:

```
send_notification(channel, ...)
  ├─ "push"      → ntfy.sh (any device)
  ├─ "telegram"  → Telegram Bot API (conversational)
  ├─ "desktop"   → WS push → companion (Tauri notification)
  ├─ "email"     → Gmail API
  ├─ "sms"       → Twilio
  └─ "whatsapp"  → Twilio
```

Routing logic:
- `showNotification()` → `pushNotification()` (replaces terminal-notifier)
- `showDialog()` → `pushNotification(priority: 5)` + Telegram (needs interaction)
- `showAlert()` → `pushNotification(priority: 4)`

### 4. Capability Router

**New file**: `packages/agent/lib/capability-router.ts`

Abstraction for local machine capabilities:

```typescript
interface CapabilityRouter {
  notify(title: string, body: string, options?: NotifyOptions): Promise<void>
  captureScreen(): Promise<string>
  getIdleSeconds(): Promise<number>
  getScreenContext(minutes: number): Promise<ScreenContext>
  executeComputerAction(action: ComputerAction): Promise<ActionResult>
}
```

Two implementations:
- **CloudCapabilityRouter** — routes via WebSocket to companion. Falls back gracefully.
- **LocalCapabilityRouter** — calls macOS binaries directly (current behavior).

### 5. WS Request/Response Protocol

Add correlation-based request/response for capabilities:

```typescript
// Cloud sends
{ type: 'capability_request', id: 'req_123', capability: 'capture_screen', params: {} }

// Device responds
{ type: 'capability_response', id: 'req_123', result: { imageData: 'base64...' } }
```

30s timeout, fallback per capability.

### 6. Screen Context via Companion

`get_screen_context` MCP tool routes through capability router:
- Cloud → WS request → companion captures screen + Screenpipe data → returns via WS
- Local → calls Screenpipe directly (current behavior)

### 7. Computer Use via Companion

- Remove `computer-use` from cloud MCP config
- Add `computer_use` tool to edith MCP server
- Cloud → WS request → companion executes (cliclick/osascript) → returns result

### 8. Wire WS Emissions

Connect dispatch events to WebSocket:
- `dispatchToClaude()` → emit `state: thinking/idle`
- `processMessageStream()` → emit `message`
- MCP tool calls → emit `progress`

### 9. Offline Mode (Phase 1: Queue Only)

- User input queued locally (max 50 messages)
- Auto-flush when cloud reconnects
- No local inference — future phase

---

## Implementation Priority

**Phase 1 — Get cloud working (no companion needed):**
1. MCP server filtering
2. Platform guards in notify.ts
3. ntfy.sh integration
4. Notification stack rewrite
5. Disable proactive-check in cloud
6. Fix DEVICE_SECRET config

**Phase 2 — Brain/body protocol:**
7. Capability router (interface + implementations)
8. WS protocol extensions (request/response)
9. Wire WS emissions

**Phase 3 — Companion handlers:**
10. Screen context routing
11. Computer use routing
12. Companion notification handler
13. Companion capability handler

---

## Files to Create/Modify

### New Files
| File | Purpose |
|------|---------|
| `packages/agent/lib/capability-router.ts` | Router interface + Cloud/Local implementations |
| `packages/agent/lib/ntfy.ts` | ntfy.sh push notification client |
| `packages/desktop/src/lib/notification-handler.ts` | Handle incoming notify messages |
| `packages/desktop/src/lib/capability-handler.ts` | Handle capability requests |

### Modified Files
| File | Change |
|------|--------|
| `packages/agent/lib/notify.ts` | Remove macOS calls, route through ntfy + capability router |
| `packages/agent/lib/dispatch-options.ts` | Add `filterMcpServers()` |
| `packages/agent/lib/cloud-transport.ts` | Add capability protocol, wire emissions |
| `packages/agent/lib/http-server.ts` | Wire WS handlers |
| `packages/agent/lib/screenpipe.ts` | Add cloud path through capability router |
| `packages/agent/mcp/tools/messaging.ts` | Update send_notification |
| `packages/agent/mcp/tools/activity.ts` | Update get_screen_context |
| `packages/agent/edith.ts` | Initialize capability router |
| `packages/desktop/src/lib/ws-client.ts` | Add capability message types |
| `packages/desktop/src/App.svelte` | Wire capability handler |

### Remove/Deprecate
| Item | Reason |
|------|--------|
| `computer-use` in `.mcp.json` cloud config | Replaced by capability router |
| `cognee` MCP wrapper | Already using HTTP direct |
| Direct `terminal-notifier`/`osascript` calls | Replaced by ntfy + capability router |
