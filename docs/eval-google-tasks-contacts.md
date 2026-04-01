# Eval: Google Tasks + Google Contacts

**Issue:** INFRA-GAPI-057
**Date:** 2026-03-30
**Status:** Complete — decision documented below

---

## What Exists Today

### Task/Reminder Management
Edith has a native reminder system (`mcp/tools/location.ts`) with:
- `save_reminder` — time-based (`fireAt`) or location-based reminders
- `list_reminders` / `mark_reminder_fired` — stored in `packages/agent/.state/reminders.json`
- `add_scheduled_task` / `remove_scheduled_task` — recurring agent tasks

Edith does NOT currently read or write Google Tasks. There is no `lib/gtasks.ts` or equivalent.

### Contact Management
Edith has no contact lookup. When an email arrives or a meeting is prepped, sender identity and contact enrichment (photo, job title, phone) come from:
- Cognee memory (manually stored: "Chris Tennant — mortgage broker")
- Gmail email headers (name + address)
- Web research at brief time

There is no `lib/gcontacts.ts` or People API integration.

### Integration Backend
All Google API calls route through n8n webhooks (`lib/n8n-client.ts` → `n8nPost()`). n8n holds and auto-refreshes OAuth tokens. Calendar, Gmail, and Docs workflows are active. Tasks and Contacts workflows do not exist yet.

---

## Google Tasks — Evaluation

### API Capabilities
- `tasks.list` — list task lists + tasks within them
- `tasks.insert` — create a task
- `tasks.patch` — update/complete a task

### Would Randy Use This?
The issue spec itself flags uncertainty: "Randy may not use Google Tasks — he uses reminders/calendar instead." This aligns with the codebase: Edith's reminder system (`save_reminder` with `fireAt`) already handles time-based tasks natively. The morning brief already surfaces calendar events and deadlines.

Google Tasks adds value only if:
1. Randy actively maintains tasks in Google Tasks, OR
2. Edith needs to create tasks that sync to Randy's phone outside of Edith

The current architecture stores reminders locally in `packages/agent/.state/reminders.json`. These don't sync to Google Tasks or any mobile app. If Randy checks Google Tasks on his phone, Edith-created reminders are invisible there.

### Verdict: DEFER

**Reason:** No evidence Randy uses Google Tasks. Native reminders cover the use case for Edith-internal tracking. Adding Google Tasks integration without confirmed usage adds integration surface with no return. Revisit if Randy asks Edith to manage tasks that need to appear in his Google Tasks list on mobile.

**If implemented later:** Add as an n8n workflow (`POST /webhook/tasks`) with actions `list`, `create`, `complete`. Build `lib/gtasks.ts` as a thin wrapper. Blocked by INFRA-OAUTH-054 (OAuth token storage) for the direct-API path.

---

## Google Contacts (People API) — Evaluation

### API Capabilities
- `people.searchContacts` — fuzzy search by name or email
- `people.get` — fetch contact by resource name (photo, job title, phones, emails, notes)
- `people/me/connections` — list all contacts

### Where This Adds Value in Edith

**1. Email triage** (`email-triager.md`)
Currently: email headers give name + address. Who is "David Chen at Lakeview Partners"? The triager has no context. With People API: look up "david@lakeviewpartners.com" → job title, notes, relationship history from Randy's Google Contacts.

**2. Morning brief meeting prep** (`morning-briefer.md`)
Step 2 says: "Meeting with someone → search emails, look them up, research the company." Currently this means a web search. A People API call first would surface phone, job title, photo, and any notes Randy has saved — much faster and more personal than a cold web search.

**3. Cognee sync**
When a new contact is found via People API, the enriched record (name, company, role, email) can be stored in Cognee as permanent memory. This is better than storing only what Edith happens to parse from emails.

### Cost and Complexity
- People API is free (no quota cost for personal use within Google's generous free tier)
- Auth: same Google OAuth as Gmail/Calendar — n8n can add it to the existing credential
- Implementation: one n8n workflow or a direct `googleapis` call
- No new OAuth scope beyond what's already in play for Gmail

### Verdict: IMPLEMENT

**Reason:** High-value, low-cost. Contact enrichment directly improves morning brief quality and email triage. The API is already effectively "free" given the existing Google OAuth setup. This is additive — it doesn't replace anything, it fills a real gap.

**Recommended scope:**
```typescript
// lib/gcontacts.ts
searchContacts(query: string): Promise<Contact[]>
// Contact: { name, email, phone?, jobTitle?, company?, photoUrl? }
```

Add as an n8n workflow (`POST /webhook/contacts`) with action `search`. Wire into:
- `morning-briefer.md` Step 2: call before web search for meeting attendees
- `email-triager.md` Step 3: enrich new contacts before storing to Cognee

**Blocked by:** INFRA-OAUTH-054 (OAuth token storage) for direct `googleapis` path. Can be done sooner via n8n since n8n already manages Google OAuth — just add a new n8n workflow using the existing Google credential.

---

## Summary

| API | Implement? | Reason |
|-----|-----------|--------|
| Google Tasks | No (defer) | No evidence of usage; native reminders cover the need |
| Google Contacts / People API | Yes | Enriches meeting prep and email triage; free, low complexity |

## Next Step

For Contacts: create an n8n workflow using the existing Google Calendar OAuth credential (add People API scope). Expose as `POST /webhook/contacts` with `{ query }` payload. Then build `lib/gcontacts.ts` as a thin n8n wrapper and update morning-briefer + email-triager agents to call it.

Does not require INFRA-OAUTH-054 to be complete — n8n handles the OAuth refresh already.
