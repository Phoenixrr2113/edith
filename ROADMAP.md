# Edith v3 — Roadmap

Features to adapt from Life-Guardian and the original Edith (edith v1).

## From Edith v1 (Desktop/edith)

### Done
- [x] Typing indicator during dispatch
- [x] Voice note transcription (Groq Whisper)
- [x] Error recovery with exponential backoff
- [x] Message prefix (🤖 EDITH)
- [x] Geofencing + location transitions
- [x] Reminders (time + location)
- [x] Session continuity (--resume)
- [x] Proactive behavior (explore projects, study calendar)
- [x] Preference learning protocol
- [x] Knowledge graph (Cognee, replacing Graphiti)

### TODO
- [ ] **SMS relay** — Two-bot architecture. Detect messages from SMS relay bot ID and tag as source: "sms". Edith v1 used `TELEGRAM_SMS_BOT_ID` env var.
- [ ] **Pause/resume via Telegram** — Randy says "pause for 2 hours" or "wake up". Write signal file, check at poll loop start. Auto-resume after duration.
- [ ] **Idle timeout** — Kill dispatch if Claude hangs for 5+ minutes with no output. Edith v1 checked every 5s and killed after 300s idle.
- [ ] **Session control commands** — "fresh start" (clear session-id), "status" (report uptime + recent activity). Detect via keyword matching in incoming messages.
- [ ] **Journal system** — Daily ops log (what was done, what's pending). Currently the taskboard serves this role, but a proper daily journal in `~/.edith/journal/YYYY-MM-DD.md` would give better continuity.
- [ ] **Message injection** — If Edith is mid-dispatch and a new message arrives, inject it into the running session via stdin instead of queuing. Not possible with `-p` mode — would need streaming input.
- [x] **Caffeinate** — Prevent macOS sleep while Edith is running. Uses `caffeinate -dis` (display + idle + system sleep prevention).

## From Life-Guardian (Desktop/life-guardian)

### TODO — High Priority
- [ ] **Escalation logic** — If a reminder/message isn't acknowledged within 30 min, resend. After 60 min, send SMS via Twilio. After 2 hours, final urgent SMS. Track escalation level per intervention.
- [ ] **Intervention history database** — Log every message sent to Randy with: timestamp, category, urgency, acknowledged, acknowledgedAt, escalationLevel. Query before sending new messages to avoid nagging.
- [ ] **ADHD-aware detection patterns** — Randy has ADHD. Detect:
  - No food signals for 4+ hours during meal windows (11am-2pm, 5pm-8pm)
  - 3+ hours continuous activity without break
  - Upcoming obligation + user appears unaware (deep in code, meeting in 15 min)
  - Rapid context switching (distraction detection)
- [ ] **Tool-enriched decisions** — Give Claude access to intervention history + user preferences before deciding whether to message Randy. Prevents duplicate interventions.

### TODO — Medium Priority
- [ ] **Household relationship tracking** — Track partner (Diana) communication patterns. Detect silence threshold (4+ hours during evening). Suggest check-ins at configured times. Config-driven with consent.
- [ ] **Acknowledgment tracking** — Know if Randy saw/acted on a message. Methods: Telegram read receipts (limited), follow-up message detection, activity-based (app switch after reminder).
- [ ] **Activity context via Screenpipe** — OCR + audio transcription from screen recording. Detect current app, window title, active content. Requires Screenpipe running locally.
- [ ] **Configurable notification tone** — warm/direct/playful per-context. Currently hardcoded in system prompt.
- [ ] **Quiet hours** — No proactive messages during configured hours (e.g., 9 PM - 7 AM). Urgent items still break through.

### TODO — Lower Priority
- [ ] **Multi-channel notifications** — ntfy.sh for push, Discord webhook, SMS as escalation tier. Currently Telegram-only.
- [ ] **Model fallback routing** — If primary model fails/rate-limits, fall back to cheaper model. Track failures per provider with circuit breaker pattern.
- [ ] **Key topic auto-detection** — Lightweight pattern matching on activity: food-related, meeting-activity, focused-work, taking-break. Feed into decision context.
- [ ] **Pre-wake context** — Before dispatching to Claude, gather calendar + email + recent activity into a structured context object. Currently done ad-hoc in prompts.

## Architecture Improvements

- [ ] **Merge n8n workflows into repo** — Export workflow JSONs, auto-import on `docker compose up`. Currently workflows live only in n8n's SQLite DB.
- [ ] **SQLite for state** — Replace file-based state (reminders.json, locations.json, schedule.json) with SQLite. Better for queries, atomic writes, and intervention tracking.
- [ ] **Prompt engineering pass** — All prompts in `prompts/` are too vague. Need concrete examples, expected output formats, and decision criteria for each.
- [ ] **Dashboard improvements** — Show message content in feed, add cost tracking chart, add error details panel, add config editor.
- [ ] **Rename project directory** — `edith-v3` → `edith` (when ready to fully commit to the name).
