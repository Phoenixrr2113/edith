# Desktop Companion — Tauri + Rive

## Purpose
Give Edith a visible presence on the desktop. Not a dashboard — a character. A smart Bonzi Buddy that earns its place on your screen.

## Design Philosophy
- **Cortana's brain** — smart, contextual, proactive with judgment
- **Bonzi's charm** — visible, quirky, personality-forward
- A presence you WANT on your screen because it's useful AND has character

## Tech Stack

| Component | Technology | Why |
|-----------|-----------|-----|
| App shell | Tauri v2 | 30-50MB RAM (vs Electron 150-300MB), Rust backend, cross-platform |
| Character | Rive | State machine animations (idle/thinking/talking/sleeping), tiny .riv files, free editor. Used by Duolingo. |
| UI chrome | Svelte 5 | Speech bubbles, status indicators, settings panel. Plain Svelte 5 (not SvelteKit — no SSR/routing needed in a desktop app). Lighter than React, smaller bundle. |
| Window | Transparent, frameless, always-on-top | Click-through when not interacting |

## How It Works

### Window
- `NSPanel` equivalent via Tauri: floating, non-activating, appears on all Spaces
- Click-through by default (clicks pass to apps behind)
- When user hovers/clicks on character → becomes interactive
- `setVisibleOnAllWorkspaces(true)` — follows across desktops

### Character States
| State | Trigger | Animation |
|-------|---------|-----------|
| Idle | Nothing happening | Subtle breathing/blinking |
| Thinking | Background agent running | Working animation, subtle progress |
| Talking | Message from Edith | Speaking animation + speech bubble |
| Listening | Voice input active | Ear/antenna animation |
| Sleeping | Night mode (9PM-7AM) | Sleeping animation, dimmed |
| Alert | Something needs attention | Attention-getting but not annoying |

### Speech Bubbles
- Messages appear as speech bubbles from the character
- Alternative/supplement to Telegram — not a replacement
- Dismissable, auto-fade after reading
- Can show worker progress ("Checking your email...")

### Connection to Edith
- WebSocket or local HTTP to orchestrator
- Another input/output channel alongside Telegram
- Can accept voice input (mic → transcribe → orchestrator)
- Shows screen awareness reactions (if Gemini integration active)

## Reference Projects
- **WindowPet** (Tauri + React + Phaser) — best reference for overlay/window mechanics
- **Open-LLM-VTuber** (Electron + Live2D + LLM) — most complete AI companion with desktop pet mode, voice, LLM integration
- **pet-therapy** (Swift/SwiftUI) — native macOS desktop pet, App Store reference

## Implementation Path
1. Scaffold Tauri v2 app with Svelte frontend
2. Create character in Rive editor (idle, thinking, talking, sleeping states)
3. Implement transparent always-on-top window with click-through
4. Connect to Edith via WebSocket (send messages, receive responses + state updates)
5. Speech bubble UI for messages
6. Voice input integration (mic → transcribe → send)
7. Screen awareness state integration (if Gemini active)

## Cross-Platform
- Tauri v2 supports macOS, Windows, Linux
- `NSPanel` behavior abstracted by Tauri
- Keychain/credential storage OS-specific (Tauri handles)
- Always-on-top behavior varies per OS (Tauri abstracts most)

## Status
Design complete. Not yet implemented.
