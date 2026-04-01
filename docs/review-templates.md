# Review Templates — Output Specs

Every review produces TWO things:
1. **Telegram summary** — 5-8 lines, bold key info, link to full doc
2. **Google Doc** — full review, accessible from any device (requires Google Docs n8n workflow)

---

## Weekly Review (Sunday 5 PM)

### Telegram Summary
```
📋 *Week in Review — Mar 24-28*

**Work:** Shipped Edith v4 orchestrator, 5 commits. DeveloperWeek CFP deadline passed — unsubmitted.
**Personal:** Beach Saturday with Phoenix. Progressive quote still open ($148/mo).
**Next week:** Calendar clear Mon-Wed. Thursday dentist at 2pm. KCDC CFP deadline Friday.

[Full review → link]
```

### Google Doc Structure
```
Week of March 24-28, 2026

## This Week — What Happened
### Work
- Projects: what shipped, what advanced, what stalled
- Meetings: who I met with, key outcomes
- Email highlights: important threads, commitments made
- Job search: applications, interviews, responses

### Personal
- Family: what we did, Phoenix milestones, quality time
- Health: workouts (target vs actual), sleep, energy
- Home: maintenance, projects, issues
- Finances: bills paid, spending notes, decisions pending

## Open Loops
- Things promised but not delivered
- Emails awaiting response
- Decisions deferred

## Next Week Preview
- Calendar events (Mon-Sun)
- Deadlines approaching
- Prep needed
- Meal planning / family plans

## Wins
- 1-3 things that went well

## What Needs Attention
- 1-3 things that need action this week
```

### Data Sources
- Calendar: next 7 days forward (n8n)
- Email: last 48h + any flagged from daily briefs (n8n)
- Taskboard: all entries from this week
- Cognee: people, projects, decisions
- Events log: cost summary, dispatch count
- Activity log: `packages/agent/.state/activity-YYYY-MM-DD.md` — primary history source for the week
- Screenpipe: week activity (optional enhancement, if available)

---

## Monthly Review (1st of month, 9:30 AM)

### Telegram Summary
```
📊 *March 2026 — Monthly Review*

**Scorecard:** Work ⬆️ Family ➡️ Health ⬇️ Finances ➡️
**Win:** Edith shipped from zero to production in 4 days
**Gap:** No gym all month. DeveloperWeek CFP missed.
**April focus:** Fix Cognee, submit KCDC CFP, start house hunt in earnest

[Full review → link]
```

### Google Doc Structure
```
Monthly Review — March 2026

## Life Scorecard (rate each 0-2: off track / ok / strong)

| Area | Score | Notes |
|------|-------|-------|
| Career / Work | | |
| Family / Diana + Phoenix | | |
| Health / Fitness | | |
| Finances | | |
| Relationships / Social | | |
| Home | | |
| Fun / Hobbies | | |
| Learning / Growth | | |
| Mental Health / Energy | | |

## Work
### Projects & Shipping
- What shipped this month (commits, PRs, features, launches)
- What's in progress
- What stalled or got abandoned

### Career
- Job search: applications sent, interviews, offers, market signals
- Compensation: any changes, freelance income, side project revenue
- Skills: new tech learned, depth gained
- Conference talks: CFPs submitted, talks given, upcoming deadlines
- Network: new contacts, mentors engaged, communities active in

### Edith (meta)
- Cost this month (total + breakdown by task)
- Reliability (success rate, timeouts, errors)
- Features shipped
- What worked well / what was noise

## Personal
### Family
- Quality time with Diana and Phoenix
- Family outings, milestones, memories
- School events, activities for Phoenix
- Relationship health — anything to address?

### Health & Fitness
- Workouts: target vs actual (number, type)
- Sleep patterns
- Energy levels (trend: up/down/stable)
- Diet / nutrition notes
- Doctor/dentist visits

### Finances
- Bills paid / due
- Insurance decisions (Progressive, etc.)
- Major purchases
- Savings rate
- Budget vs actual
- Subscriptions audit

### Home
- Maintenance done / needed
- House hunt status (if active)
- Projects completed / in progress

### Fun & Hobbies
- What did I do for fun?
- Beach trips, outings, games, movies
- Hobbies pursued
- Books read / in progress

### Learning
- Courses, tutorials, certifications
- Books read
- Skills practiced

## Reflection
### 3 Wins
1.
2.
3.

### 3 Lessons
1.
2.
3.

### What drained energy? What created energy? (Sahil Bloom audit)

## Open Loops
- Promises unfulfilled
- Decisions deferred
- Emails/threads unresolved

## Next Month Preview
- Calendar events (major ones)
- Deadlines approaching
- Goals to focus on (max 3)
```

### Data Sources
- Calendar: next 7 days + any stored monthly events from daily briefs
- Email: recent 48h + aggregated from daily brief taskboard entries throughout the month
- Taskboard: all entries from this month (daily briefs captured email/calendar each day)
- Cognee: people, projects, decisions, patterns stored throughout the month
- Events log: full month of cost data, dispatch counts, error rates
- Activity log: `packages/agent/.state/activity-YYYY-MM-DD.md` — primary history source for the month
- Screenpipe: recent activity (optional enhancement, if available)
- Prep files: any reviews/prep created this month
- Google Drive: docs created/modified this month

---

## Quarterly Review (1st of Jan/Apr/Jul/Oct, 10 AM)

### Telegram Summary
```
📈 *Q1 2026 — Quarterly Review*

**Theme:** The Build Quarter — Edith went from zero to production
**Win:** Shipped a working AI assistant in 4 days
**Miss:** Health and social life took a backseat
**Q2 focus:** Fix infrastructure, submit CFPs, restart gym routine

[Full review → link]
```

### Google Doc Structure
```
Quarterly Review — Q1 2026 (Jan-Mar)

## Quarter Theme
One sentence: what defined this quarter?

## OKR Scorecard (if OKRs were set)
| Objective | Key Results | Score (0.0-1.0) |
|-----------|------------|-----------------|
| | | |

## Life Scorecard — Quarter Trend
| Area | Jan | Feb | Mar | Trend |
|------|-----|-----|-----|-------|
| Career | | | | ⬆️/➡️/⬇️ |
| Family | | | | |
| Health | | | | |
| Finances | | | | |
| Social | | | | |
| Growth | | | | |

## Work — Quarter in Review
### Biggest Wins (top 3)
### Biggest Misses (top 3)
### Projects: shipped, in progress, abandoned
### Career trajectory: where was I in Jan vs now?
### Skills gained
### Network: key relationships built or deepened
### Conference / speaking / writing

## Personal — Quarter in Review
### Family highlights and lowlights
### Health trend
### Financial trajectory
### Home / living situation
### What brought joy this quarter?

## Energy Audit (Sahil Bloom)
| Energy Creators | Energy Drainers |
|----------------|-----------------|
| | |

## Stop / Start / Continue
| Stop | Start | Continue |
|------|-------|----------|
| | | |

## Big Decisions Review
- What major decisions did I make?
- Were they right?
- What would I do differently?

## Values Alignment
Am I living the life I want? What's the gap between stated values and actual behavior?

## Next Quarter
### Top 3 Objectives (mix personal + professional)
1.
2.
3.

### Key Dates & Deadlines
### What needs to change?
```

### Data Sources
- Monthly reviews from the quarter (Google Docs)
- Calendar: next 7 days + aggregated from monthly reviews
- Cognee: all stored knowledge from the quarter
- Events log: 3 months of cost data
- Prep files: all reviews/artifacts created
- Google Drive: quarterly search for modified docs

---

## Daily Briefs (Reference)

### Morning Brief (weekday)
Already working well. No template change needed. Just add Google Doc link for detailed prep.

### Weekend Brief (Sat/Sun)
Already specced in weekend-briefer agent. Add:
- Weather for the day and tomorrow
- Local events search (Bradenton/Sarasota area)
- Beach conditions (water temp, surf, tide)
- Kid-friendly activity suggestions
- Any family calendar events

---

## Infrastructure Needed

### Google Docs Creation (n8n workflow)
**Required for all reviews.** Endpoint: `POST /webhook/docs`

| Field | Type | Notes |
|-------|------|-------|
| title | string | Doc title |
| content | string | Markdown content (converted to Doc formatting) |
| folderId | string | Google Drive folder ID (optional) |

**Response:** `{ docId, docUrl }` — the URL goes in the Telegram summary.

### Historical Calendar (n8n workflow enhancement)
Current calendar only looks forward. Need backward queries for reviews.
Enhancement to existing calendar workflow: add `hoursBehind` parameter.

### Gmail Search Enhancement
Current Gmail only does `hoursBack`. Need ability to search by date range and content for monthly aggregation.
Alternative: rely on daily brief taskboard entries as the "email diary" — each morning brief already scans and summarizes email.
