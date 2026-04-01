---
name: quarterly-review
description: "Quarterly review — strategic look at the last 3 months. Career trajectory, project health, life balance, big decisions ahead. Runs 1st of Jan/Apr/Jul/Oct."
agent: analyst
model: opus
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

# Quarterly Review

Big-picture check-in. Three months of data. The `analyst` agent runs this skill using `opus` for strategic depth.

Runs 1st of Jan/Apr/Jul/Oct.

## Step 1: Gather context

1. **Cognee** — all decisions, milestones, patterns, people from last 3 months:
   ```bash
   bash /Users/randywilson/Desktop/edith-v3/mcp/cognee-direct.sh search "quarter decisions milestones patterns"
   ```
2. **Monthly reviews** — Bash to find this quarter's monthly review docs, or `manage_docs` search; fall back to taskboard archives
3. **Taskboard archives** — `packages/agent/.state/taskboard-archive/YYYY-MM.md` for each month of the quarter
4. **Activity log** — `get_activity` with `days: 90`
5. **Calendar patterns** — meeting frequency, time allocation trends
6. **Email trends** — volume, key relationships, unresolved threads
7. **Cost analysis** — Edith running costs from `packages/agent/.state/events.jsonl` for the quarter

## Step 2: Google Doc

`manage_docs` — title: `Q[N] [YEAR] — Quarterly Review`

### Quarter Theme (1 sentence — what was this quarter about?)

### Career & Projects
- What shipped? Stalled? Abandoned?
- Side projects: Edith, Codegraph — progress and key decisions
- AI thought leadership: blog posts published, conferences, talks, CFPs
- Skills developed, certifications

### Family & Relationships
- Phoenix: quality time trend ⬆️➡️⬇️, activities done, relationship health
- Diana: milestones (driving progress?), Diana+Phoenix bonding
- Social: network growing or shrinking? Key people this quarter.

### Health & Wellbeing
- Weight loss goal progress
- Drinking reduction progress
- Exercise habits, energy trends
- ADHD management — what's working?

### Finances
- House hunt status — any progress?
- Rental portfolio goals — steps taken?
- Major expenses, income changes

### Edith Effectiveness
- Most valuable tasks Edith handled
- What was noise / overhead?
- Cost per day/week trend
- Suggestions for improvement

### Reflection
- 3 biggest wins
- 3 biggest misses
- What would you do differently?

### Next Quarter (max 3 goals)

## Step 3: Cognee

Store quarterly summary milestone, updated goals/trajectory, relationship insights, patterns:
```bash
bash /Users/randywilson/Desktop/edith-v3/mcp/cognee-direct.sh save "..."
```

## Step 4: Telegram message

**Format:**
```
📈 Q[N] [YEAR] Review

**Theme:** [one-line quarter narrative]
• **Win:** [biggest accomplishment]
• **Miss:** [biggest gap]
• **Q[N+1] focus:** [top 2-3 priorities]
• 👨‍👦 Phoenix time: [trend ⬆️➡️⬇️ + one line]

Full review → [Google Doc link]
```

**Rules:**
- Max 6 lines. Under 120 words.
- Strategic, not tactical — this is the 30,000 foot view
- Always track Phoenix relationship trend — Randy's stated priority
- Always track health goals — weight, drinking
- Honest about misses. No corporate positivity spin.
- Google Doc link is the deliverable
