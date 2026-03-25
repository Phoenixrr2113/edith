# Edith Debug Log — Resolved

## Issues & Resolutions

### Issue 1: `--dangerously-load-development-channels` doesn't exist
**Status**: Resolved — not needed.
The channel plugin pattern with `experimental: "claude/channel"` isn't shipped in Claude Code v2.1.81. The MCP server works as a standard tool server via `.mcp.json` without any special flags.

### Issue 2/3: MCP tools not loading in `-p` mode
**Root cause**: `Server()` constructor in `server.ts` had capabilities in the wrong argument. The MCP SDK expects `Server(serverInfo, options)` as two args, but the code put everything in `serverInfo`. This caused `assertRequestHandlerCapability` to throw "Server does not support tools" and the MCP connection to fail silently.
**Fix**: `Server({ name, version }, { capabilities: { tools: {} }, instructions })` — split into two arguments.

### Issue 4: Interactive mode permissions dialog
**Status**: Resolved.
`--permission-mode bypassPermissions` works without TUI dialog in `-p` mode. No need for `--dangerously-skip-permissions`.

### Issue 5: `-p` mode is one-shot
**Status**: Resolved.
Built `edith.ts` — a persistent wrapper that polls Telegram and dispatches each message to `claude -p --resume <session-id> --permission-mode bypassPermissions`. Claude maintains conversation context across messages via session resumption.

## Architecture
```
Telegram ──> edith.ts (poll loop) ──> claude -p --resume (MCP tools from .mcp.json)
                                          ├── edith: reply, react
                                          └── cognee: search, cognify, etc.
```

## Key Files
- `edith.ts` — persistent wrapper (polls Telegram, dispatches to Claude)
- `channel/server.ts` — MCP tool server (reply, react) — no polling
- `channel/start.sh` — sources .env and runs the MCP server
- `.mcp.json` — MCP server config (edith + cognee)
- `launch-edith.sh` — entrypoint for daemon/launchd
- `com.edith.claude.plist` — launchd config
