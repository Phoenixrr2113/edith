---
name: monthly-review
description: "Monthly review — goals progress, spending patterns, relationship health, what worked and what didn't. Runs 1st of each month."
agent: analyst
model: sonnet
tools:
  - Read
  - Write
  - Glob
  - Bash
  - WebSearch
  - WebFetch
  - mcp__edith__manage_calendar
  - mcp__edith__manage_emails
  - mcp__edith__manage_docs
  - mcp__edith__send_message
  - mcp__edith__get_activity
  - mcp__screenpipe__activity-summary
---

# Monthly Review

Bigger picture. What happened this month? What's the trajectory? The `analyst` agent runs this skill.

Cover work AND personal life. Zoom out.

## Step 1: Gather data

1. **Taskboard (current)** — `packages/agent/.state/taskboard.md`
2. **Taskboard (archive)** — `packages/agent/.state/taskboard-archive/YYYY-MM.md` for this month
3. **Activity log** — `get_activity` with `days: 30`
4. **Cognee** — all decisions, people, projects, patterns this month:
   ```bash
   bash /Users/randywilson/Desktop/edith-v3/mcp/cognee-direct.sh search "month decisions projects patterns"
   ```
5. **Email** — key threads, commitments, unresolved conversations
6. **Calendar** — upcoming events (forward only; use taskboard/activity for past)
7. **Events log** — `packages/agent/.state/events.jsonl`: sum Edith costs by label for the month
8. **Screenpipe** — activity summary if available; fall back to activity log
9. **Weekly reviews** — use `manage_docs` search or Bash to find this month's weekly review docs

## Step 2: Google Doc

`manage_docs` — title: `Monthly Review — [MONTH YEAR]`

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
- Blog posts: written, published, ideas captured

### Reflection
- 3 Wins
- 3 Lessons
- What drained energy? What created energy?

### Open Loops
- Promises unfulfilled, decisions deferred

### Next Month (max 3 focus areas)

## Step 3: Cognee

Store monthly summary, patterns, goals status, relationship updates:
```bash
bash /Users/randywilson/Desktop/edith-v3/mcp/cognee-direct.sh save "..."
```

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
