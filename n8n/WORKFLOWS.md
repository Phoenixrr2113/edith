# n8n Workflows — Integration Backend

n8n serves as Edith's integration backend. Each workflow exposes a webhook endpoint that Edith's MCP tools call via `lib/n8n-client.ts`. All payloads are JSON POST to `http://localhost:5679/webhook/{name}`.

## Existing Workflows

### Calendar (`GXNFGEV89TJPf9FV`)
**Endpoint:** `POST /webhook/calendar`
**Credentials:** Google Calendar OAuth (randyrowanwilson@gmail.com)

| Action | Payload | Response |
|--------|---------|----------|
| get (default) | `{ hoursAhead: 24, includeAllDay: true }` | `{ events: [...], count: N }` |
| create | `{ action: "create", summary, start, end?, location?, description?, allDay?, calendar? }` | `{ ok: true, eventId, summary, start }` |
| update | `{ action: "update", eventId, summary?, start?, end?, location?, description?, calendar? }` | `{ ok: true, eventId }` |
| delete | `{ action: "delete", eventId, calendar? }` | `{ ok: true, eventId }` |

**Note:** Empty calendar returns HTTP 500 "No item to return" — treated as success with null data.

---

### Gmail (`BlsFzeOY3wFf1Zic`)
**Endpoint:** `POST /webhook/gmail`
**Credentials:** Gmail OAuth (randyrowanwilson@gmail.com)

| Action | Payload | Response |
|--------|---------|----------|
| get (default) | `{ hoursBack: 4, unreadOnly: true, maxResults: 10 }` | `{ emails: [...], count: N }` |
| single manage | `{ messageId, action: "archive"\|"trash"\|"markAsRead"\|"addLabel"\|"removeLabel", label? }` | `{ success: true, messageId }` |
| batch | `{ action: "batch", operations: [{ messageId, action, label? }] }` | `{ success: true, count: N }` |

---

### OwnTracks (`XnmlJqr6b8tbgtsx`)
**Endpoint:** Webhook trigger (receives GPS updates from OwnTracks app)
**Purpose:** Location tracking → writes to `~/.claude/location-latest.json`

---

## Workflows to Build

### Notify
**Endpoint:** `POST /webhook/notify`
**Purpose:** Multi-channel notifications (email, Slack, Discord)
**Called from:** `send_notification` MCP tool (channels: email, slack, discord)
**Currently:** Endpoint is called but workflow doesn't exist yet — fails silently.

| Field | Type | Required | Notes |
|-------|------|----------|-------|
| channel | `"email" \| "slack" \| "discord"` | yes | Routing key |
| text | string | yes | Message body |
| recipient | string | yes | Email address, Slack user, Discord handle |
| subject | string | no | Email subject line |

**Implementation:** Switch node on `channel` → route to Gmail Send / Slack Message / Discord Webhook.

---

### Twilio (SMS + WhatsApp)
**Endpoint:** `POST /webhook/twilio`
**Purpose:** Send SMS and WhatsApp messages
**Called from:** `send_notification` MCP tool (channels: whatsapp, sms)
**Currently:** Handled directly in `lib/twilio.ts` via Twilio REST API. Moving to n8n centralizes messaging.

| Field | Type | Required | Notes |
|-------|------|----------|-------|
| channel | `"sms" \| "whatsapp"` | yes | Routing key |
| to | string | yes | Phone number (E.164 format) |
| body | string | yes | Message text |

**Credentials needed:** Twilio Account SID + Auth Token (already in .env)

---

### Transcribe (Voice → Text)
**Endpoint:** `POST /webhook/transcribe`
**Purpose:** Convert audio files to text
**Called from:** `lib/handlers.ts` → `handleVoice()` (currently calls Groq/OpenAI directly)
**Currently:** `lib/telegram.ts` → `transcribeAudio()` uses Groq first, falls back to OpenAI Whisper.

| Field | Type | Required | Notes |
|-------|------|----------|-------|
| audioUrl | string | yes | URL or local path to audio file |
| format | string | no | Audio format (ogg, mp3, wav). Default: auto-detect |

**Response:** `{ text: "transcribed text", duration?: N }`

**Implementation:** OpenAI Whisper node (n8n has native support).

---

### Google Tasks
**Endpoint:** `POST /webhook/tasks`
**Purpose:** Create, list, update, complete tasks
**Called from:** New MCP tool (not yet created)

| Action | Payload | Response |
|--------|---------|----------|
| list | `{ taskList?: string }` | `{ tasks: [...] }` |
| create | `{ title, notes?, due?, taskList? }` | `{ id, title }` |
| update | `{ taskId, title?, notes?, due?, status? }` | `{ id, title }` |
| complete | `{ taskId }` | `{ ok: true }` |

**Credentials needed:** Google Tasks OAuth (same Google account)

---

### Google Drive
**Endpoint:** `POST /webhook/drive`
**Purpose:** Search and read Google Drive documents
**Called from:** New MCP tool or directly by agents

| Action | Payload | Response |
|--------|---------|----------|
| search | `{ query, maxResults?: 10 }` | `{ files: [{ id, name, mimeType, modifiedTime }] }` |
| read | `{ fileId }` | `{ content: "text content", name, mimeType }` |

**Credentials needed:** Google Drive OAuth (same Google account)

---

### Google Contacts
**Endpoint:** `POST /webhook/contacts`
**Purpose:** Look up and create contacts
**Called from:** New MCP tool or directly by agents

| Action | Payload | Response |
|--------|---------|----------|
| search | `{ query }` | `{ contacts: [{ name, email, phone }] }` |
| create | `{ name, email?, phone?, notes? }` | `{ id, name }` |

**Credentials needed:** Google People API OAuth (same Google account)

---

## Architecture Notes

- **Error handling:** `lib/n8n-client.ts` → `n8nPost()` handles all HTTP errors, treats "No item to return" 500s as empty success, and catches network failures.
- **Auth:** n8n manages all OAuth token refresh internally. Edith never touches OAuth tokens.
- **MCP abstraction:** MCP tools in `mcp/server.ts` are thin wrappers around `n8nPost()`. Swapping n8n for direct API calls later requires only changing the backend, not the tool interface.
- **Product transition:** When packaging Edith as a product, all n8n workflows get replaced with direct `googleapis` calls in Rust/Node. The MCP tool contracts stay identical.
