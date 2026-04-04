---
name: weekend-brief
description: "Weekend morning brief — family activities, local events, weather, beach conditions. Use on Saturday/Sunday mornings instead of the work-focused morning brief."
agent: communicator
model: sonnet
tools:
  - Bash
  - Read
  - Write
  - Glob
  - WebSearch
  - WebFetch
  - mcp__edith__manage_calendar
  - mcp__edith__manage_docs
  - mcp__edith__send_message
  - mcp__edith__manage_emails
  - mcp__edith__list_reminders
---

# Weekend Brief

Weekend morning brief. Runs Saturday/Sunday mornings instead of morning-brief. The `communicator` agent runs this skill.

It's the weekend. Randy is with Diana and Phoenix (tween, 10-13). Family time is the priority.

## Step 1: Gather context

- **CodeGraph**: recall Phoenix interests, family plans, recent activities, health goals
  - `knowledge({ action: "recall", text: "Phoenix family weekend activities", semantic: true })`
- **Calendar**: today + tomorrow — any family plans, birthday parties, appointments? (`manage_calendar`)
- **Reminders**: anything due today/tomorrow? (`list_reminders`)
- **Email**: scan lightly — only flag genuinely urgent items (legal, financial, health). Don't draft replies.
- **Weather**: Bradenton/Sarasota FL, today + tomorrow. Beach-worthy? Pool weather?

## Step 2: Research activities

**Always check these sources:**
- **Macaroni Kid** (macaronikid.com) — search Bradenton/Sarasota for family events this weekend
- **Visit Sarasota / Visit Bradenton** event calendars
- Google: "[current date] things to do with kids Bradenton Sarasota"
- Facebook local groups: "Bradenton events this weekend" / "Sarasota family events"

**Phoenix's interests (tween boy, very active):**
- Parkour / ninja warrior gyms — open sessions or drop-in
- Indoor skydiving deals or events
- STEM / science events, maker spaces, robotics
- Skateparks, BMX, rock climbing
- Free or cheap options first

**Family activities:**
- Local events: festivals, markets, shows, food trucks
- Beach conditions: Anna Maria Island, Siesta Key, Lido Beach — surf, tide, wind
- Outdoor: kayaking, bike trails, state parks, nature preserves (Robinson Preserve, Myakka)
- Rainy day backup: museums, bowling, escape rooms, movies

**Health-conscious options:**
- Active outings: hiking, biking, swimming, 5K parkruns
- Randy and Diana are working on weight loss — suggest active over sedentary

**Budget:** Free and cheap is the priority. Always include at least one free option.

**Diana + Phoenix bonding:** Randy wants them to have a better relationship. Always suggest at least one thing they could do together.

## Step 3: Create Google Doc

`manage_docs` — title: `Weekend Guide — [Month Day-Day, Year]`

Include:
- Weather breakdown (today + tomorrow, beach forecast)
- Top 5-8 activity ideas: what, where, cost, link, why it's good
- Diana + Phoenix bonding idea
- Calendar commitments
- Meal ideas / restaurant suggestions (healthy, affordable)

## Step 4: Telegram message

**Format:**
```
☀️ Weekend

• **[Weather]** — beach day? park day? indoor day?
• 👨‍👦 **[Best Phoenix activity]** — [detail] (free/$X)
• 💑 **Diana + Phoenix** — [bonding activity]
• 🏖️ **Beach:** [conditions] at [which beach]
• 🎯 [One event/festival happening this weekend]

Full guide → [Google Doc link]
```

**Rules:**
- Keep it fun and light. Family time, not a work standup.
- Under 150 words. Max 5 bullets.
- Bold one anchor word per line
- Always include at least one free activity
- Always include beach conditions (this is Florida)
- Only mention work if something truly can't wait until Monday
- The Google Doc has all details — Telegram is just the highlight reel

## Step 5: Taskboard + CodeGraph

- Taskboard: write `## [ISO-timestamp] — weekend-brief`
- **CodeGraph**: store activities suggested, new local spots discovered
  - `knowledge({ action: "store", text: "...", extract: true })`
