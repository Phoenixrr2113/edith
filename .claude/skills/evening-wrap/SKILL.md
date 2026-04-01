---
name: evening-wrap
description: "End-of-day wrap-up — review today, prep tomorrow, store decisions. Runs at 4:53 PM or when Randy asks to 'wrap up the day'."
agent: communicator
model: sonnet
tools:
  - Read
  - Write
  - Edit
  - Glob
  - Grep
  - Bash
  - WebFetch
  - WebSearch
  - mcp__edith__manage_emails
  - mcp__edith__manage_calendar
  - mcp__edith__manage_docs
  - mcp__edith__send_message
  - mcp__edith__get_activity
  - mcp__screenpipe__activity-summary
---

# Evening Wrap

End-of-day wrap-up. Runs at 4:53 PM or on demand. The `communicator` agent runs this skill.

This is family time (4-8pm). Keep it tight. Only message if tomorrow needs attention tonight.

## Step 1: Review today

- **Taskboard** (`~/.edith/taskboard.md`): what did morning/midday accomplish?
- **Screenpipe**: activity summary — what did Randy actually work on today?
- **Email**: any loose ends from today? (`manage_emails`)
- **Calendar**: anything from today worth noting? (`manage_calendar`)

## Step 2: Prep tomorrow

- **Calendar**: tomorrow + next 48h
- **Meetings** → research context, find links, prep talking points for each
- **Deadlines < 48h** → advance the work now (draft, research, write)
- Save substantial prep to Google Doc via `manage_docs`

## Step 3: Family awareness

- Check tomorrow's calendar for family time / open blocks
- If weekend ahead → quick search for family activity ideas (Phoenix: parkour, STEM, science, outdoor, beach. Budget-friendly. Bradenton/Sarasota area.)
- Check weather for tomorrow/weekend (Bradenton/Sarasota FL)

## Step 4: Store knowledge

- Cognee: decisions made today, new contacts, project updates, patterns, family plans
  ```bash
  bash /Users/randywilson/Desktop/edith-v3/mcp/cognee-direct.sh save "..."
  ```
- Taskboard: write `## [ISO-timestamp] — evening-wrap` with summary and what's next

## Step 5: Telegram message

Only message if tomorrow needs attention tonight. If nothing urgent → write taskboard, stay silent.

**Format — drop any section with nothing to report:**
```
🌙 Evening · [temp]°F tomorrow

✅ TODAY
• **[What got done]** — one line summary
• **[Key outcome]** — result

🔥 TOMORROW
• [time] — [meeting/deadline] — prepped [link]
• DECIDE: **[anything needed tonight]**

👨‍👦 TOMORROW
• [family idea if weekend/open time]

Full prep → [Google Doc link]
```

**Rules:**
- Same section markers pattern as morning/midday for consistency (✅ 🔥 👨‍👦)
- Max 3-4 bullets per section. Under 100 words total.
- Max 10-12 words per bullet. Bold one anchor word per line.
- Drop entire sections with nothing — never show empty sections
- Lead with accomplishments (what got done), then what's next
- Family suggestion only if relevant (weekend coming, open evening tomorrow)
- Do NOT message "wrapping up" or "have a good evening"
