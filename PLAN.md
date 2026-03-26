# Edith Refactoring Plan

## Phase 1: Quick Wins (small, low risk)

- [x] **1. Eliminate `state.ts` re-exports** — all modules import config from `config.ts` directly, state functions from `state.ts`
- [x] **2. Remove duplicate constants** — `BACKOFF_SCHEDULE`, `INBOX_MAX_AGE`, `PROMPTS_DIR`, `SCHEDULE_FILE` each defined in two places
- [x] **3. Unify `loadSchedule()`** — merged default-seeding into `storage.ts`, scheduler uses it
- [x] **4. Use `storage.ts:loadJson/saveJson` everywhere** — replaced hand-rolled JSON in `scheduler.ts`, `proactive.ts`, `state.ts`, `dispatch.ts`
- [x] **5. Deduplicate screen-context gathering** — `buildProactiveBrief` now calls `gatherScreenContext(180, true)`
- [x] **6. Fix `require("fs")` in dashboard** — added `openSync/readSync/closeSync` to top-level import
- [x] **7. Extract `fmtErr()` utility** — new `lib/util.ts`, replaced all 20+ occurrences
- [x] **8. Move `briefTypeMap`** — exported `BRIEF_TYPE_MAP` from `lib/briefs.ts`, used in both `edith.ts` and `scheduler.ts`

## Phase 2: Structural Extractions (medium, high impact)

- [x] **9. Extract message handlers from `edith.ts:poll()`** → `lib/handlers.ts` — location, voice, photo, text handlers
- [x] **10. Extract scheduler tick body** → `lib/tick.ts` — signals, triggers, inbox processing
- [x] **11. Break up `dispatchToClaude`** — extracted `buildSdkOptions()` and `processMessageStream()` as private helpers
- [x] **12. Extract dashboard HTML** to `dashboard.html` — 366 lines out of template literal
- [x] **13. Extract dashboard route handlers** into a route map instead of 12-branch if/else chain
- [x] **14. ~~Extract `send_notification` channel dispatch~~** — N/A, consolidated into unified `send_notification` MCP tool
- [x] **15. ~~Extract `generate_image`~~** — N/A, small enough to stay inline after tool consolidation
- [x] **16. Deduplicate POST handler boilerplate** in dashboard — extracted `handlePost(req, handler)` wrapper

## Phase 3: Larger Structural (do when needed)

- [ ] **17. Split MCP tool registrations** into `mcp/tools/telegram.ts`, `mcp/tools/schedule.ts`, etc.
- [ ] **18. Extract dashboard data-access functions** (`getStatus`, `getStats`, `readEventsFile`, etc.) to `lib/` for reuse
- [ ] **19. Extract SSE log streaming** into a self-contained `LogStreamer` class
- [ ] **20. Break up `getStatus()`** — separate health checks (async/slow) from file reads (sync/fast)

## Future Work (from previous plan)

- Email send via n8n + approval flow
- Slack two-way integration
- WhatsApp inbound via Twilio
- Cost tracking charts on dashboard
- Reminder/location management UI on dashboard
- Native tray app (Electrobun, when mature)
