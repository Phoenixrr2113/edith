Query `~/.edith/costs.db` (SQLite) for today's cost entries. Use `lib/db.ts` functions via a quick Bash script:

```bash
bun -e "
import { getCostsByDate, getTotalCostToday } from '/Users/randywilson/Desktop/edith-v3/lib/db.ts';
const rows = getCostsByDate();
const total = getTotalCostToday();
const byLabel = {};
for (const r of rows) {
  if (!byLabel[r.label]) byLabel[r.label] = { count: 0, usd: 0, turns: 0 };
  byLabel[r.label].count++;
  byLabel[r.label].usd += r.usd;
  byLabel[r.label].turns += r.turns;
}
console.log('Total today: \$' + total.toFixed(4));
console.log('Dispatches:', rows.length);
if (rows.length) console.log('Avg/dispatch: \$' + (total / rows.length).toFixed(4));
console.log('\nBreakdown:');
for (const [label, s] of Object.entries(byLabel)) {
  console.log(' ', label + ':', s.count + 'x', '\$' + s.usd.toFixed(4), s.turns + ' turns');
}
"
```

Report:
- Total cost today (USD)
- Per-task breakdown (label, count, cost, turns)
- Number of dispatches
- Average cost per dispatch

Fall back to `grep '"cost"' ~/.edith/events.jsonl | grep "$(date +%Y-%m-%d)"` if SQLite query fails.
