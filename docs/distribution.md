# Distribution — Edith as a Product

## Vision
A downloadable app anyone can install. No Docker, no n8n, no Screenpipe, no terminal. Just Edith.

## Install Experience
```
1. Download Edith.dmg (macOS) / Edith.exe (Windows) / Edith.AppImage (Linux)
2. Open → Edith appears on your desktop
3. "Hi, I'm Edith. Let's get you set up."
4. Sign in with Google (OAuth in-app) → Gmail, Calendar, Drive, Tasks connected
5. Enter Claude API key (or sign in with Anthropic account)
6. Optional: Enter Gemini API key for screen awareness
7. Done — Edith is watching, thinking, helping
```

## What's Inside the Binary

| Component | Technology | Purpose |
|-----------|-----------|---------|
| Desktop companion | Tauri v2 + Rive | The visible character, UI, speech bubbles |
| Orchestrator brain | Claude Agent SDK | Persistent session, decision-making |
| Background agents | Claude Agent SDK | Parallel ephemeral sessions for work |
| Google integrations | googleapis + tauri-plugin-oauth | Gmail, Calendar, Drive, Tasks, Contacts |
| Screen awareness | Gemini Live API | Real-time screen understanding (optional) |
| Memory | Local SQLite + vector embeddings (bge-base-en-v1.5) | Replaces Cognee |
| Notifications | Native OS notifications | macOS/Windows/Linux |
| Voice | Whisper API or local model | Speech-to-text input |

## What the User Provides
- Claude API key (or Anthropic account login)
- Google account (OAuth — handled in-app)
- Optional: Gemini API key for screen awareness
- Optional: Telegram bot token (for mobile access)

## What Goes Away (vs POC)
- **Docker** → no containers
- **n8n** → direct googleapis calls in Rust/Node (n8n embed license is $50K/year)
- **Screenpipe** → Gemini Live API (just an API call)
- **Cognee** → local SQLite + LanceDB + fastembed
- **Bun runtime** → Tauri bundles everything
- **Terminal/CLI** → desktop app only
- **Manual env vars** → settings panel in app

## n8n Licensing Problem
n8n **cannot** be bundled:
- $50K/year embed license required for any product shipping n8n to users
- OAuth token injection broken — API blocks writing `oauthTokenData`
- Users would see n8n's UI (breaks the "invisible backend" goal)

**Solution:** Replace n8n with direct `googleapis` calls via `tauri-plugin-oauth`.
- OAuth handled natively in Edith's UI
- Tokens stored in macOS Keychain / Windows Credential Manager
- No background process, no licensing fees
- MCP tool interface stays identical — agents don't know the backend changed

## Architecture (Product Version)

```
┌─────────────────────────────────────────────┐
│              Tauri Desktop App               │
│  ┌─────────┐  ┌──────────┐  ┌───────────┐  │
│  │  Rive   │  │  Speech  │  │  Settings  │  │
│  │Character│  │ Bubbles  │  │   Panel    │  │
│  └────┬────┘  └────┬─────┘  └─────┬─────┘  │
│       └────────────┼──────────────┘         │
│                    │                         │
│  ┌─────────────────┴─────────────────────┐  │
│  │         Orchestrator Brain             │  │
│  │    (Persistent Claude Session)         │  │
│  └──┬──────────┬──────────┬──────────┬──┘  │
│     │          │          │          │      │
│  ┌──┴──┐  ┌───┴──┐  ┌───┴──┐  ┌───┴──┐   │
│  │Agent│  │Agent │  │Agent │  │Agent │   │
│  │  1  │  │  2   │  │  3   │  │  4   │   │
│  └──┬──┘  └──┬───┘  └──┬───┘  └──┬───┘   │
│     └────────┼─────────┼────────┘         │
│              │         │                    │
│  ┌───────────┴─────────┴─────────────────┐  │
│  │        Integration Layer               │  │
│  │  Gmail │ Calendar │ Drive │ Contacts   │  │
│  │  (googleapis + OAuth tokens)           │  │
│  └───────────────────────────────────────┘  │
│                                              │
│  ┌──────────┐  ┌──────────┐  ┌───────────┐  │
│  │  Local   │  │  Gemini  │  │ Telegram   │  │
│  │  Memory  │  │  Screen  │  │  Bridge    │  │
│  │ (SQLite) │  │ (Live API)│ │ (optional) │  │
│  └──────────┘  └──────────┘  └───────────┘  │
└─────────────────────────────────────────────┘
```

## Phasing Strategy

**Phase 1 — POC (now):** n8n + Claude Agent SDK + Bun. Fast iteration, visual workflows, already working. Prove the orchestrator + agents pattern.

**Phase 2 — Polish:** Harden, tune prompts, add integrations via n8n. Still personal use.

**Phase 3 — Product (if/when investors):** Replace n8n with native code. Replace Cognee with bundled SQLite + vector DB. Package as Tauri binary. Build onboarding. This is the expensive phase.

**The MCP tool interface is the abstraction boundary.** `manage_emails`, `manage_calendar`, `send_notification` — same inputs/outputs regardless of backend. Swap n8n for native code without touching agents or orchestrator.

## Cross-Platform
- Tauri v2: macOS, Windows, Linux
- Screen capture: macOS CGDisplayStream, Windows DXGI, Linux PipeWire
- Keychain: OS-specific (Tauri handles)
- Always-on-top: varies per OS (Tauri abstracts)
- Computer use: OS-specific mouse/keyboard control

## Status
Design complete. Phase 1 (POC) in progress. Phase 3 requires business case.
