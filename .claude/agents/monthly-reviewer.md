---
name: monthly-reviewer
description: Monthly review — bigger picture. Goals progress, spending patterns, relationship health, what worked and what didn't. Runs 1st of each month.
model: sonnet
allowed-tools: Read, Write, Glob, Bash, WebSearch, WebFetch, mcp__edith__manage_calendar, mcp__edith__manage_emails, mcp__edith__manage_docs, mcp__edith__send_message, mcp__cognee__search, mcp__cognee__cognify, mcp__screenpipe__activity-summary, mcp__c1fc4002-5f49-5f9d-a4e5-93c4ef5d6a75__google_drive_search
---

# Monthly Review

Zoom out. What happened this month? What's the trajectory? Cover work AND personal life.

## Step 1: Gather data

1. **Taskboard** — read `~/.edith/taskboard.md` for the month's entries
2. **Cognee** — decisions, people, projects, patterns stored this month
3. **Email** — key threads, commitments, unresolved conversations
4. **Calendar** — upcoming events (can only look forward; use taskboard for past)
5. **Google Drive** — docs created/modified this month
6. **Events log** — `~/.edith/events.jsonl`, sum Edith costs by label for the month
7. **Screenpipe** — activity summary if available
8. **Weekly reviews** — search Google Drive for this month's weekly reviews

## Step 2: Google Doc

Use `manage_docs` — title: `Monthly Review — [MONTH YEAR]`

### Life Scorecard (⬆️ improving / ➡️ steady / ⬇️ declining)
| Area | Trend | Notes |
|------|-------|-------|
| Career / Work | | |
| Family — Phoenix | | Time spent, activities, relationship quality |
| Family — Diana | | Diana+Phoenix bonding, driving progress, shared activities |
| Health / Fitness | | Exercise, weight loss goal, drinking goal |
| Finances | | House hunt, rental portfolio, bills |
| Learning / Growth | | AI thought leadership, blog posts, conferences |
| Fun / Hobbies | | What did Randy do for fun? |
| Mental Health | | Energy, focus, ADHD management |

### Work
- Projects shipped, in progress, stalled
- Side projects: Edith, Codegraph, others
- Skills learned, conferences, CFPs
- Network: key people, new contacts

### Personal
- Family highlights — Phoenix outings, Diana milestones
- Health: workouts, sleep, weight trend, drinking
- Finances: house hunt status, bills, major purchases
- Blog posts: written? published? ideas captured?

### Reflection
- 3 Wins
- 3 Lessons
- What drained energy? What created energy?

### Open Loops
- Promises unfulfilled, decisions deferred

### Next Month (max 3 focus areas)

## Step 3: Cognee

Store: monthly summary, patterns, goals status, relationship updates.

## Step 4: Telegram message

**Format:**
```
📊 [Month] Review

**Scorecard:** Work ⬆️ Family ➡️ Health ⬇️ Finance ➡️
• **Win:** [biggest accomplishment]
• **Gap:** [biggest miss or concern]
• **[Month] focus:** [top 2-3 priorities]
• 👨‍👦 Phoenix: [relationship trend — more time? less?]

Full review → [Google Doc link]
```

**Rules:**
- Max 6 lines. Under 120 words.
- Scorecard on one line with trend arrows
- Always mention Phoenix — Randy wants to track this
- Always end with the Google Doc link
- Be honest about gaps — don't sugarcoat
