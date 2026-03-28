# Edith Data Sources — Capabilities & Limitations

What Edith can access, how far back, and what's missing.

## Working Sources

### Gmail (n8n workflow)
- **Endpoint:** `POST /webhook/gmail`
- **Time range:** Relative only — `hoursBack: 1-48` from now
- **Max results:** 20 per call
- **Filters:** `unreadOnly` toggle, inbox label
- **Can do:** Get recent emails, archive, trash, mark read, add/remove labels, batch operations
- **Cannot do:** Search by date range, search by sender/subject/content, get sent mail explicitly, paginate beyond 20
- **Workaround for reviews:** Daily briefs scan email every morning and write summaries to taskboard. Taskboard entries become the "email diary" for weekly/monthly reviews.

### Google Calendar (n8n workflow)
- **Endpoint:** `POST /webhook/calendar`
- **Time range:** Forward only — `hoursAhead: 1-168` (max 7 days)
- **Can do:** Get upcoming events, create/update/delete events, include all-day events
- **Cannot do:** Query past events, search by date range, query by attendee/title
- **Gap for reviews:** Monthly/quarterly reviews can't inventory past meetings. Need either a `hoursBehind` parameter added to the n8n workflow, or rely on daily brief taskboard entries as the historical record.

### Cognee (MCP stdio)
- **Transport:** MCP stdio (local, no Docker)
- **Status:** Config fixed (kuzu graph DB), needs verification after restart
- **Can do:** Store facts/entities/relationships, semantic search, cognify text into graph
- **What should be stored:** People, decisions, project milestones, preferences, patterns, meeting outcomes, contacts
- **How far back:** Indefinite — everything stored persists
- **Gap:** Was broken (networkx/kuzu mismatch). Fixed but may need re-cognify of existing knowledge. No data from before March 28.

### Screenpipe (local MCP)
- **Endpoint:** MCP tools (`activity-summary`, `search-content`, etc.)
- **Time range:** Live only — last N minutes. No historical queries by date.
- **Can do:** App usage, OCR text from screen, audio transcription, continuous activity detection
- **Cannot do:** Query by date range, store historical summaries, search past sessions
- **Gap for reviews:** Can only capture current session activity. Weekly/monthly reviews can't see "what apps did I use this week." Workaround: daily briefs capture Screenpipe summaries to taskboard.

### Google Drive (MCP — read only)
- **Tools:** `google_drive_search`, `google_drive_fetch`
- **Can do:** Search files by name/content/date, read file contents (Docs, Sheets, etc.)
- **Cannot do:** Create files, write/update files, share files
- **How far back:** Entire Drive history
- **Gap:** Cannot create Google Docs for review output. Need n8n workflow.

### Events Log (`~/.edith/events.jsonl`)
- **Content:** Every dispatch, cost, error, schedule fire, location update — timestamped JSONL
- **Can do:** Cost analysis by label, error rate tracking, dispatch count, reliability metrics
- **How far back:** Since Edith started (March 28, 2026). Grows daily.
- **Useful for reviews:** Monthly cost breakdown, task frequency, error trends

### Taskboard (`~/.edith/taskboard.md`)
- **Content:** Timestamped entries from every agent run — findings, actions taken, open loops
- **Rotated:** Every 24 hours (old entries pruned)
- **Useful for reviews:** Acts as the daily diary. Each morning/midday/evening brief writes what it found and did. Reviews should read the taskboard for the period.
- **Gap:** Rotated daily — weekly/monthly reviews can't read old taskboard entries. Need to preserve taskboard history or write daily summaries elsewhere.

### Prep Files (`~/Desktop/edith-prep/`)
- **Content:** Meeting prep, review docs, CFP drafts, research notes
- **Created by:** Morning brief and review agents
- **Problem:** Local file path — not accessible from phone. Reviews should create Google Docs instead.

### Telegram Message History
- **Not directly queryable** — Edith sends messages but can't search her own sent history
- **Workaround:** Taskboard entries and events log capture what was sent

### Location (`~/.edith/locations.json`, `~/.claude/location-latest.json`)
- **Can do:** Current GPS coordinates, saved locations (home, school, Diana's work), geofence triggers
- **Useful for reviews:** Could track "days at home vs out" if location events are logged

## Infrastructure Gaps (blocking better reviews)

### 1. Google Docs Creation (BLOCKER)
**Problem:** Reviews produce local file paths that are useless on mobile.
**Solution:** n8n workflow at `POST /webhook/docs` that creates a Google Doc and returns a shareable URL.
**Required fields:** `title`, `content` (markdown), `folderId` (optional)
**Returns:** `{ docId, docUrl }`
**Priority:** HIGH — blocks all review improvements

### 2. Historical Calendar
**Problem:** Can only look forward (next 7 days), not back.
**Solution:** Add `hoursBehind` parameter to calendar n8n workflow, or add a separate `GET /webhook/calendar-history` endpoint.
**Needed for:** Monthly reviews (inventory past meetings), quarterly reviews (meeting patterns)
**Priority:** MEDIUM — workaround exists (daily briefs capture calendar to taskboard)

### 3. Gmail Date Range Search
**Problem:** Can only query relative time (`hoursBack: 1-48`), not absolute date ranges.
**Solution:** Add `after`/`before` date parameters to Gmail n8n workflow.
**Needed for:** Monthly reviews (email volume analysis, key threads)
**Priority:** LOW — daily brief taskboard entries serve as email diary

### 4. Taskboard History
**Problem:** Taskboard rotates every 24 hours. Weekly/monthly reviews can't read old entries.
**Solution options:**
- Archive taskboard entries to a monthly file before rotation
- Write daily summaries to Cognee (once working)
- Write daily summaries to a Google Doc (once creation workflow exists)
**Priority:** MEDIUM — without this, reviews rely only on what's still in the taskboard

### 5. Screenpipe Historical Queries
**Problem:** Can only see current session activity, not past days.
**Solution:** None available from Screenpipe. Would need to cache daily summaries.
**Workaround:** Daily proactive-check captures Screenpipe snapshots to taskboard (when it works).
**Priority:** LOW — nice to have for activity trends

## Data Flow for Reviews

```
Daily (morning/midday/evening briefs):
  Gmail (48h) + Calendar (24h) + Screenpipe (3h) + Cognee
  → Taskboard entry (what happened, what was done)
  → Prep files (meeting notes, research)

Weekly (Sunday 5 PM):
  This week's taskboard entries + Calendar (next 7d) + Gmail (48h)
  + Cognee (people, decisions) + Events log (costs)
  → Google Doc (weekly review) + Telegram summary

Monthly (1st of month):
  Past month's weekly reviews + Taskboard entries + Events log (full month)
  + Cognee (all stored knowledge) + Google Drive (docs modified)
  + Calendar history (if available)
  → Google Doc (monthly review) + Telegram summary

Quarterly (1st of quarter):
  Past 3 monthly reviews + Events log (3 months) + Cognee
  + Google Drive + Prep files
  → Google Doc (quarterly review) + Telegram summary
```

Each level builds on the one below it. Daily briefs are the foundation — they capture the raw data that reviews aggregate.
