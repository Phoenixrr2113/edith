# Edith v4 → v5: OS-Level Agent Plan

## What's Done (v4)

- Agent SDK integration (query, streamInput, session continuity, circuit breaker)
- agntk sub-agents (researcher/analyst/coder/drafter via OpenRouter)
- Prompt system rewrite (identity, reasoning, rules, skills)
- 16 MCP tools (messaging, reminders, locations, calendar, email, image gen, sub-agents)
- Dashboard with live logs, task triggers, transcript viewer
- Geofencing + location/time reminders
- Pre-wake context gathering (calendar, email before session)
- Brief types (boot, morning, midday, evening, message, location, scheduled)
- Dead-letter queue, signal files, transcript logging
- Groq Whisper transcription with OpenAI fallback
- Architecture diagrams (7 views, verified against codebase)

---

## Phase 5: Always-On OS Agent

### 5.1 LaunchAgent — Auto-Start on Login

Make Edith start when the Mac starts. No terminal needed.

**Implementation:**
- Create `~/Library/LaunchAgents/com.edith.agent.plist`
- Points to `launch-edith.sh` (already handles PID, Docker, dashboard)
- `KeepAlive: true` for crash recovery
- `ThrottleInterval: 10` to prevent restart loops
- `StandardOutPath` / `StandardErrorPath` → `~/.edith/launchd-stdout.log`
- `launch-edith.sh` sources `.env` for API keys (LaunchAgents don't inherit shell env)
- Install script: `launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/com.edith.agent.plist`
- Uninstall: `launchctl bootout gui/$(id -u)/com.edith.agent`

**Tasks:**
- [ ] Create plist file with proper env handling
- [ ] Update `launch-edith.sh` to `source .env` explicitly
- [ ] Add `install.sh` / `uninstall.sh` helper scripts
- [ ] Test: reboot → verify Edith starts, dashboard accessible, Telegram working

### 5.2 Screenpipe Integration — See Everything

Screenpipe captures screen OCR + audio transcription locally. Edith reads it to understand what Randy is doing in real-time.

**Architecture:**
```
screenpipe (localhost:3030) — always running, captures screen + audio
  ↓ HTTP API
lib/screenpipe.ts — client that queries screenpipe
  ↓
Edith scheduler (every 2-5 min) — fetches context, decides if proactive action needed
  ↓
dispatchToClaude() — with screen context injected into brief
```

**Screenpipe API:**
- `GET /health` — status check
- `GET /search?content_type=ocr&start_time=X&limit=50` — screen OCR frames
- `GET /search?content_type=audio&start_time=X&limit=20` — audio transcripts
- Returns: `{ data: [{ type: 'OCR'|'Audio', content: { text, app_name, window_name, timestamp } }] }`

**Implementation:**
- [ ] Install screenpipe: `brew install screenpipe` or `curl -fsSL get.screenpi.pe/cli | sh`
- [ ] Grant macOS permissions: Screen Recording + Microphone
- [ ] Create `lib/screenpipe.ts` — HTTP client with methods:
  - `isAvailable()` — health check
  - `getScreenContext(minutes)` — OCR frames grouped by app
  - `getAudioContext(minutes)` — audio transcripts
  - `getFullContext(minutes)` — combined summary
- [ ] Add `screenpipe-context` brief type in `lib/briefs.ts`
- [ ] Add scheduler task: `screen-check` every 2-5 min
  - Fetch last 10-15 min of screen + audio
  - Summarize what Randy is doing (app, content, duration)
  - Pass to Claude with proactive prompt: "Based on what Randy is doing, should you help?"
  - Only message if genuinely useful (not noise)
- [ ] Add `SCREENPIPE_URL` to `.env` and `lib/config.ts`
- [ ] Add screenpipe startup to `launch-edith.sh`

**Proactive triggers to detect:**
- Hyperfocus on one app for 2+ hours → suggest break
- Meeting in <15 min + no prep visible → offer prep
- Email draft open for a while → offer to help draft
- Research rabbit hole → offer to summarize findings
- Calendar conflict visible → alert
- Stuck on error in terminal/IDE → offer debugging help

### 5.3 Popup Windows — Visual Presence

Edith needs to show things on screen, not just Telegram.

**Tier 1 — Immediate (osascript, zero deps):**
- [ ] Create `lib/notify.ts` with:
  - `showNotification(title, body)` — macOS Notification Center toast
  - `showDialog(title, body, buttons)` — modal dialog with button choices
  - `showAlert(message)` — simple alert
- [ ] Add `show_notification` MCP tool (distinct from Telegram `send_notification`)
- [ ] Add `show_dialog` MCP tool — returns which button was clicked

```typescript
// Notification (non-blocking toast)
await Bun.spawn(["osascript", "-e",
  `display notification "${body}" with title "${title}"`]);

// Dialog (modal, returns button clicked)
const result = await Bun.spawn(["osascript", "-e",
  `display dialog "${body}" buttons {"Cancel","OK"} default button "OK" with title "${title}"`]);
```

**Tier 2 — Rich UI (local web server + browser):**
- [ ] Add dashboard routes for popup content:
  - `GET /popup/:type` — renders a focused popup page (approval, review, info)
- [ ] `showRichPopup(type, data)` — opens `localhost:3456/popup/:type` in a small browser window
- [ ] Use for: email approval flows, meeting prep display, multi-option decisions

```typescript
// Open a sized browser window
await Bun.spawn(["open", "-a", "Google Chrome", "--args",
  `--app=http://localhost:3456/popup/approval?id=${id}`,
  "--window-size=600,400"]);
```

**Tier 3 — Native Tray App (future, Electrobun):**
- Menu bar icon showing Edith status (thinking, idle, alert)
- Quick-reply text field without opening Telegram
- Popup cards for proactive suggestions
- ~14MB binary, uses system WebKit, Bun-native
- Evaluate when Electrobun matures further

### 5.4 Proactive Intelligence Loop

The core behavior change: Edith watches, thinks, and acts without being asked.

**Architecture:**
```
Every 2-5 min:
  1. Fetch screenpipe context (screen + audio)
  2. Check calendar proximity
  3. Check email inbox
  4. Build "observation brief" with all context
  5. Ask Claude: "Should you do something?"
  6. If yes → act (notification, prep work, message, popup)
  7. If no → stay silent
```

**Guardrails:**
- Max 2 proactive interventions per hour (prevent notification fatigue)
- Cooldown per category (don't repeat same type within 60 min)
- Quiet hours: 10pm-8am (no proactive, still responds to messages)
- Never interrupt if Randy is in a meeting (detect via calendar + screenpipe)
- Confidence threshold: only act if >80% sure it's helpful
- All proactive actions logged for Randy to review/tune

**Tasks:**
- [ ] Create `lib/proactive.ts` — intervention tracker (cooldowns, limits, history)
- [ ] Add `proactive-check` scheduled task (every 3 min)
- [ ] Create `proactive` brief type — includes screenpipe context + calendar + recent actions
- [ ] Add `proactive_history` MCP tool — so Claude can check what it already suggested
- [ ] Add proactive config to `~/.edith/config.json`:
  - `maxPerHour`, `cooldownMinutes`, `quietHours`, `enabledCategories`
  - `confidenceThreshold`

---

## Phase 6: Infrastructure & Integrations

### 6.1 Email Send via n8n
- [ ] Create Gmail Send workflow in n8n
- [ ] Draft → save to file → popup approval → send on confirm
- [ ] Add `send_email` MCP tool

### 6.2 Slack Integration
- [ ] Add Slack node to n8n Notify workflow
- [ ] OAuth setup for workspace
- [ ] Two-way: receive DMs, send messages

### 6.3 WhatsApp Inbound
- [ ] Twilio webhook → n8n → Edith message queue
- [ ] Two-way WhatsApp communication

### 6.4 Cost Tracking Dashboard
- [ ] Parse `events.jsonl` for cost entries
- [ ] Daily/weekly chart on dashboard
- [ ] Budget alerts via notification

### 6.5 Reminder/Location Management UI
- [ ] Dashboard page: list, add, edit, delete reminders
- [ ] Dashboard page: list, add, edit, delete locations
- [ ] Map view for geofence visualization

---

## Priority Order

| Phase | Effort | Impact | Priority |
|-------|--------|--------|----------|
| 5.1 LaunchAgent | 1-2 hours | Always-on without terminal | **Do first** |
| 5.3 Tier 1 Popups | 2-3 hours | Visual presence on desktop | **Do second** |
| 5.2 Screenpipe | 1 day | Sees what you're doing | **Do third** |
| 5.4 Proactive Loop | 1-2 days | Acts without being asked | **Core feature** |
| 6.1 Email Send | 2-3 hours | Complete email workflow | As needed |
| 6.4 Cost Dashboard | 2-3 hours | Visibility into spend | Nice to have |
| 5.3 Tier 2 Rich UI | 1 day | Better approval flows | Nice to have |
| 6.2-6.3 Slack/WhatsApp | 1 day each | More channels | As needed |
| 6.5 Management UI | 1-2 days | Dashboard polish | Low priority |
| 5.3 Tier 3 Tray App | 2-3 days | Native desktop presence | Future |

---

## Vision

Edith becomes an OS-level agent that:
1. **Starts with your Mac** — no terminal, no manual launch
2. **Sees your screen** — knows what you're working on via screenpipe
3. **Hears your meetings** — audio transcription for context
4. **Acts proactively** — preps meetings, flags issues, suggests help
5. **Shows up visually** — notifications, dialogs, popup windows
6. **Responds instantly** — Telegram for mobile, desktop UI for local
7. **Does the work** — doesn't just suggest, actually does things (drafts, research, file ops)

The goal: Randy never has to ask Edith for help — she's already working on it.
