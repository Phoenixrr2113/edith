# Screen Awareness — Gemini Live API

## Purpose
Replace Screenpipe with real-time screen understanding. Edith watches what Randy is doing, researches in the background, offers contextual suggestions, and can take over tasks when asked.

## Architecture

```
Screen capture (macOS CGDisplayStream) → frames at 1 FPS
  → Gemini Live API (WebSocket, bidirectional)
  → Gemini understands: "Randy is writing TypeScript in VS Code, file: auth.ts"
  → Context updates sent to Edith orchestrator
  → Orchestrator decides: spawn worker? suggest? stay silent?
  → If "take over" → Claude computer use (screenshot-based)
```

## Gemini Live API Details
- **Transport:** WebSocket, bidirectional, native screen share support
- **Frame rate:** 1 FPS (by design — adequate for screen content)
- **Latency:** 320ms p50, 780ms p95 for first token
- **Session limits:** Unlimited with context compression. Connection lifetime ~10min; resumption tokens last 2 hours.
- **Video input cost:** 258 tokens/second
- **Models:** `gemini-2.0-flash-live`, `gemini-2.5-flash` (Live variant)

## Cost Analysis

| Approach | Cost/hour | 8hr day |
|----------|-----------|---------|
| Gemini Flash passive watching (1 FPS) | ~$0.28 | ~$2.22 |
| Hybrid: local model + Gemini on change detection | ~$0.25 | ~$2.00 |
| GPT-4o continuous (1 FPS, high detail) | ~$9.94 | ~$79.50 |
| Claude Sonnet continuous (1 FPS) | ~$11.95 | ~$95.60 |

Gemini Flash is ~40x cheaper than alternatives. Only viable option for always-on.

## What Edith Does With Screen Context

### Proactive (Cortana mode — must pass the Bonzi test)
- Randy is in VS Code editing `auth.ts` → spawn researcher to look up the library he's importing
- Randy is on a company's website before a meeting → spawn researcher to prep talking points
- Randy has been on Twitter for 30 min → gently suggest getting back to the deadline
- Randy is writing an email to someone in Cognee → surface relationship context

### On request
- "Take over this" → Claude computer use kicks in with full screen context
- "What was I just looking at?" → Gemini recalls recent screen history
- "Help me with this form" → Gemini reads the form, Claude fills it

### Cortana/Bonzi filter
Every proactive action must pass: **"Would this earn the interruption?"**
- Stating the obvious (you're in VS Code) → Bonzi. Don't.
- Researching the person 5 min before a meeting → Cortana. Do it silently, report if useful.

## Implementation Path
1. Screen capture module (macOS `CGDisplayStream` → raw frames)
2. Gemini Live API WebSocket client (send frames, receive context summaries)
3. Context bridge → Edith orchestrator (structured updates)
4. Proactive worker spawning (research, suggestions)
5. Computer use integration (Claude screenshot-based, on "take over")

## Alternatives Considered
- **Screenpipe** (current) — OCR snapshots, no real understanding, separate app install, blocks distribution
- **Qwen3-Omni local** — good vision but no continuous stream protocol, 1.8s latency. Could work as cheap local pre-filter.
- **OmniParser V2** (Microsoft) — local UI parsing at 0.6s. Good for hybrid: local detection → Gemini for understanding.

## Dependencies
- Gemini API key (user provides)
- macOS screen capture permissions
- Edith orchestrator running (routes context to agents)

## Status
Design complete. Not yet implemented.
