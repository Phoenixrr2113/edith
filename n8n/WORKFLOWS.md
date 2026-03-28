# n8n Workflows — Integration Backend

n8n serves as Edith's integration backend. Each workflow exposes a webhook endpoint that Edith's MCP tools call via `lib/n8n-client.ts`. All payloads are JSON POST to `http://localhost:5679/webhook/{name}`.

## Active Workflows

### Calendar (`GXNFGEV89TJPf9FV`)
**Endpoint:** `POST /webhook/calendar`
**Credentials:** Google Calendar OAuth (randyrowanwilson + phoenixrr2113)

| Action | Payload | Response |
|--------|---------|----------|
| get (default) | `{}` | `{ events: [...], count: N }` |
| create | `{ action: "create", summary, start, end?, location?, description?, calendar? }` | `{ ok: true, eventId, summary }` |
| update | `{ action: "update", eventId, summary?, start?, end?, location?, description?, calendar? }` | `{ ok: true, eventId }` |
| delete | `{ action: "delete", eventId, calendar? }` | `{ ok: true, eventId }` |

---

### Gmail (`BlsFzeOY3wFf1Zic`)
**Endpoint:** `POST /webhook/gmail`
**Credentials:** Gmail OAuth (randyrowanwilson + phoenixrr2113)

| Action | Payload | Response |
|--------|---------|----------|
| get (default) | `{}` | `{ emails: [...], count: N }` |
| single manage | `{ action, messageId, label? }` | `{ results: [...], ok: true }` |
| batch | `{ operations: [{ messageId, action, label? }] }` | `{ results: [...], ok: true }` |
| send | `{ action: "send", to, subject, message, cc?, bcc? }` | `{ results: [...], ok: true }` |
| reply | `{ action: "reply", messageId, message }` | `{ results: [...], ok: true }` |
| draft | `{ action: "draft", to?, subject, message }` | `{ results: [...], ok: true }` |

---

### Google Docs (`b0ca6220ea5140b7`)
**Endpoint:** `POST /webhook/docs`
**Credentials:** Google Drive OAuth (phoenixrr2113)

| Payload | Response |
|---------|----------|
| `{ title, content, folderId? }` | `{ ok: true, docId, docUrl, name }` |

---

### Notify (`notify-workflow-001`)
**Endpoint:** `POST /webhook/notify`
**Credentials:** Telegram API, Twilio API

Routes notifications by channel. Email is handled separately via the Gmail workflow.

| Channel | Payload | Notes |
|---------|---------|-------|
| telegram | `{ channel: "telegram", text, recipient }` | recipient = chat_id |
| whatsapp | `{ channel: "whatsapp", text, recipient, from }` | recipient = phone number (whatsapp: prefix stripped automatically) |
| sms | `{ channel: "sms", text, recipient, from }` | Requires A2P 10DLC registration (pending) |
| unknown | any other channel value | Returns `{ success: false, error: "Unknown channel: ..." }` |

**SMS note:** A2P campaign registration submitted 2026-03-28, takes 2-3 weeks for approval. SMS will work once approved.

**WhatsApp note:** Using Twilio sandbox. Requires re-joining every 72 hours by texting the join keyword to +14155238886.

---

## Handled Outside n8n

| Feature | Where | Why |
|---------|-------|-----|
| Transcription | `mcp/server.ts` → `transcribeAudio()` | Groq Whisper API via direct fetch. n8n's HTTP Request node had connectivity issues. |
| SMS/WhatsApp (MCP path) | `lib/twilio.ts` → `sendTwilio()` | MCP server handles these directly for the `send_notification` tool. Notify workflow is a secondary path. |
| Image generation | `mcp/server.ts` → Google Imagen | Direct API call via `@google/generative-ai` SDK. |

## Archived Workflows

- **OwnTracks** — Location tracking via GPS pings. Archived: `require('fs')` disallowed in n8n Code node sandbox. Location handled by geofencing in edith.ts instead.
- **Transcribe** — Voice-to-text via OpenAI Whisper. Archived: OpenAI quota exhausted + n8n HTTP Request connectivity issues. Moved to Groq Whisper in MCP server.

## Architecture Notes

- **Error handling:** `lib/n8n-client.ts` → `n8nPost()` handles HTTP errors, treats empty-result 500s as success with null data.
- **Auth:** n8n manages all OAuth token refresh internally.
- **MCP abstraction:** MCP tools are thin wrappers around `n8nPost()`. Swapping n8n for direct API calls later only changes the backend.
- **Product transition:** When packaging Edith as a product, n8n workflows get replaced with direct `googleapis` calls. MCP tool contracts stay identical.
