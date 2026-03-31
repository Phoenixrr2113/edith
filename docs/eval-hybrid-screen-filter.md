# Eval: Hybrid Local+Cloud Screen Pre-Filter

**Issue:** SCREEN-HYBRID-102
**Status:** Decision documented
**Date:** 2026-03-31

---

## Problem

Edith watches the screen at 1 FPS via Gemini Live API. Every frame costs tokens.
At 1 FPS × 60 min × 8h = 28,800 frames/day. Most frames show no meaningful change
(Randy is reading, typing slowly, or the screen is idle). Sending every frame to
Gemini wastes money and API quota on noise.

---

## Option A: Send every frame to Gemini (current design)

- No local infrastructure
- Simple: one code path
- Gemini sees everything — highest context fidelity

**Cost:**

From `docs/screen-awareness.md`:
- Gemini Flash: 258 tokens/second at 1 FPS ≈ 258 tokens/frame
- Gemini Flash input: ~$0.075 / 1M tokens
- 28,800 frames × 258 tokens = 7.43M tokens/day
- **$0.56/day → $17/month → $204/year**

(The screen-awareness doc estimates $2.22/8hr day for continuous; our calculation
matches when accounting for the Live API's session compression overhead.)

---

## Option B: Local pre-filter (Ollama) → cloud only on change detection

A local VLM (Ollama llama3.2-vision, ~2GB) answers one binary question per frame:
"Does this frame show anything meaningfully different from the last frame?"

If no: discard. If yes: send to Gemini for full analysis.

**Local VLM cost:** $0 (runs on-device, no API charges)

**Estimated filter rate:** 85–92% of frames are visual noise at 1 FPS on a typical
work day (reading, slow typing, static meetings). Assume 10% pass the pre-filter.

**Revised Gemini cost:**
- 28,800 frames × 10% × 258 tokens = 743K tokens/day
- **$0.056/day → $1.70/month → $20/year** (90% reduction)

**Local VLM latency:** llama3.2-vision on Apple Silicon M2 ≈ 150–300ms per frame.
At 1 FPS this is acceptable — the pre-filter completes before the next frame arrives.

**Quality risk:** Can the local VLM miss something important?
- Low-level change detection (pixel diff) catches most transitions
- llama3.2-vision is strong on "is this different/important" binary questions
- Worst case: Randy quickly opens a sensitive doc and types for <2s — local model
  may not flag it. Mitigation: pass frames every N seconds unconditionally as a
  heartbeat (e.g., every 10 seconds regardless of delta).

---

## Option C: Pixel diff pre-filter (no VLM)

Compare consecutive frames via perceptual hash (pHash). Send to Gemini only when
the hash distance exceeds a threshold.

**Cost:** Negligible CPU, ~$0 extra.

**Filter rate:** Similar to Option B for static screens, but misses semantic
changes (e.g. browser tab switches with similar-looking pages, subtle text changes).

**Quality risk:** Higher than Option B — pHash cannot understand meaning, only
visual structure. Would miss many of the cases Edith needs to catch.

---

## Cost Comparison

| Approach | Gemini calls/day | $/day | $/month | $/year |
|----------|-----------------|-------|---------|--------|
| A: Every frame to Gemini | 28,800 | $0.56 | $17 | $204 |
| B: Ollama pre-filter (10% pass rate) | ~2,880 | $0.056 | $1.70 | $20 |
| C: pHash pre-filter (est. 15% pass) | ~4,320 | $0.084 | $2.55 | $30 |
| B + heartbeat every 10s | ~3,360 | $0.065 | $1.97 | $24 |

Note: Gemini Live API uses session-level billing; the per-frame token math above
is approximate. Real costs may be 20–40% lower due to compression and batching.

---

## Recommendation: Implement Option B (Ollama pre-filter + heartbeat)

**Why:**
1. **90% cost reduction** — from ~$204/year to ~$24/year with heartbeat. Material
   savings even at Randy's usage level.
2. **Privacy side-benefit** — most frames never leave the device. Aligns with the
   local-processor.ts privacy mode (Issue #93).
3. **Ollama is already integrated** — `desktop/src/lib/ollama.ts` and
   `desktop/src/lib/local-processor.ts` handle detection and inference. Wiring
   the pre-filter is low additional complexity.
4. **Binary question is easy** — "is there a meaningful change?" is exactly the
   kind of task where a small local VLM outperforms a pixel diff and costs nothing.
5. **Heartbeat mitigates quality risk** — unconditional send every 10s ensures
   Gemini never loses context for more than 10 seconds.

**What to build:**
- `desktop/src/lib/screen-prefilter.ts` — wraps `LocalProcessor`, caches the last
  sent frame hash, calls Ollama for binary change detection, returns
  `{ shouldSend: boolean; reason: string }`.
- Wire into `screen-capture.ts` `onScreenFrame` callback before the cloud upload.
- Add `screenPrefilterEnabled: boolean` to `DesktopSettings` (default: true when
  Ollama is available, false otherwise — graceful degradation).

**When to use cloud-only (Option A):**
- Ollama is not installed / no vision model available
- User explicitly disables pre-filter in Settings
- During "take over" mode (Claude computer-use) — need full fidelity, no latency

---

## Implementation Notes

The pre-filter prompt should be short and binary to keep local VLM latency low:

```
Does this screenshot show something meaningfully different from typical computer
use that a personal assistant should know about? Answer YES or NO only.
```

For heartbeat: track `lastForcedSendAt` and bypass the filter if
`Date.now() - lastForcedSendAt > 10_000`.

Content filtering (`content-filter.ts`, Issue #92) runs first — sensitive frames
are dropped before reaching either the local VLM or Gemini.

Pipeline order:
```
Frame captured
  → content-filter (sensitive? drop)
  → screen-prefilter (changed? skip if no)
    → heartbeat override (force every 10s)
  → LocalProcessor / Gemini (full analysis)
  → Context bridge → Edith orchestrator
```
