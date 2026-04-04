---
name: email-triage
description: "Email triage — scan inbox, archive noise, draft replies for actionable emails, flag decisions. Use when Edith needs to process a batch of emails or Randy asks to 'check email'."
agent: communicator
model: sonnet
tools:
  - Bash
  - mcp__edith__manage_emails
  - mcp__edith__send_message
  - WebSearch
  - WebFetch
  - Read
  - Write
---

# Email Triage

Process a batch of emails: archive noise, draft replies, flag decisions. The `communicator` agent runs this skill.

## Step 1: Scan inbox

`manage_emails` (get, unreadOnly: false, maxResults: 50)

## Step 2: Triage each email

- **Archive immediately**: newsletters, promos, automated notifications, marketing, social media alerts
- **Draft reply**: real people, project updates, meeting-related, requests — draft but do NOT send
- **Flag for Randy**: decisions needed, approvals, financial, legal, sensitive topics

For people you don't recognize → search CodeGraph for context:
- `knowledge({ action: "recall", text: "[person name]", semantic: true })`

## Step 3: CodeGraph

Store new contacts, relationships, project context, commitments made:
- `knowledge({ action: "store", text: "...", extract: true })`

## Step 4: Telegram message (only if actionable)

**Format:**
```
✉️ Email triage

• DECIDE: **[person]** re: [topic] — [one-line context]
• REPLY: **[person]** — drafted, need your OK
• [N] archived, [N] need attention

[Google Doc link if drafts created]
```

**Rules:**
- Only message if Randy needs to decide, reply, or know something
- If just archiving noise → stay silent
- Max 4 bullets. Under 80 words.
- Bold the person's name — that's the anchor
- DECIDE/REPLY prefixes for scannability
