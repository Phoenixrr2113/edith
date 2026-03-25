/**
 * Edith Dashboard — lightweight status monitor.
 * Serves a single-page HTML dashboard at http://localhost:3456
 * Reads state from ~/.edith/ files and pings services for health.
 */
import { existsSync, readFileSync } from "fs";
import { join } from "path";

const PORT = Number(process.env.DASHBOARD_PORT ?? 3456);
const STATE_DIR = join(process.env.HOME ?? "~", ".edith");
const N8N_URL = process.env.N8N_URL ?? "http://localhost:5679";
const COGNEE_URL = process.env.COGNEE_URL ?? "http://localhost:8001";

function readJsonFile(path: string): any {
  if (!existsSync(path)) return null;
  try { return JSON.parse(readFileSync(path, "utf-8")); } catch { return null; }
}

function readTextFile(path: string): string {
  if (!existsSync(path)) return "";
  try { return readFileSync(path, "utf-8"); } catch { return ""; }
}

function readEventsFile(limit: number = 100): any[] {
  const path = join(STATE_DIR, "events.jsonl");
  if (!existsSync(path)) return [];
  try {
    const lines = readFileSync(path, "utf-8").split("\n").filter(Boolean);
    return lines.slice(-limit).reverse().map((l) => {
      try { return JSON.parse(l); } catch { return null; }
    }).filter(Boolean);
  } catch { return []; }
}

async function checkHealth(url: string, timeout = 3000): Promise<boolean> {
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeout);
    const res = await fetch(url, { signal: controller.signal });
    clearTimeout(timer);
    return res.ok;
  } catch { return false; }
}

function isEdithAlive(): boolean {
  const pidFile = join(STATE_DIR, "edith.pid");
  if (!existsSync(pidFile)) return false;
  try {
    const pid = Number(readFileSync(pidFile, "utf-8").trim());
    process.kill(pid, 0); // Signal 0 = check if alive
    return true;
  } catch { return false; }
}

async function getStatus() {
  const [n8nOk, cogneeOk] = await Promise.all([
    checkHealth(`${N8N_URL}/healthz`),
    // Cognee SSE endpoint streams forever; just check if it accepts connections
    checkHealth(`${COGNEE_URL}/sse`, 2000).catch(() => false).then(async () => {
      try {
        const c = new AbortController();
        setTimeout(() => c.abort(), 2000);
        await fetch(`${COGNEE_URL}/sse`, { signal: c.signal });
        return true;
      } catch (e: any) {
        // AbortError means it connected (SSE stream started) — that's healthy
        return e?.name === "AbortError";
      }
    }),
  ]);

  return {
    edith: isEdithAlive(),
    n8n: n8nOk,
    cognee: cogneeOk,
    sessionId: readTextFile(join(STATE_DIR, "session-id")).trim() || null,
    activeProcesses: readJsonFile(join(STATE_DIR, "active-processes.json")) ?? [],
    schedule: readJsonFile(join(STATE_DIR, "schedule.json")) ?? [],
    scheduleState: readJsonFile(join(STATE_DIR, "schedule-state.json")) ?? {},
  };
}

function getStats(events: any[]) {
  const now = Date.now();
  const today = events.filter((e) => now - new Date(e.ts).getTime() < 24 * 60 * 60 * 1000);
  return {
    messagesReceived: today.filter((e) => e.type === "message_received").length,
    messagesSent: today.filter((e) => e.type === "message_sent").length,
    dispatches: today.filter((e) => e.type === "dispatch_end").length,
    errors: today.filter((e) => e.type === "dispatch_error").length,
    tasksFired: today.filter((e) => e.type === "schedule_fire").length,
    avgDispatchMs: (() => {
      const durations = today.filter((e) => e.type === "dispatch_end" && e.durationMs).map((e) => e.durationMs);
      return durations.length > 0 ? Math.round(durations.reduce((a: number, b: number) => a + b, 0) / durations.length) : 0;
    })(),
  };
}

const DASHBOARD_HTML = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Edith Dashboard</title>
<style>
  * { margin: 0; padding: 0; box-sizing: border-box; }
  body { font-family: -apple-system, BlinkMacSystemFont, 'SF Mono', monospace; background: #0a0a0a; color: #e0e0e0; padding: 20px; }
  h1 { font-size: 1.4em; margin-bottom: 16px; color: #fff; }
  h2 { font-size: 1em; margin-bottom: 8px; color: #888; text-transform: uppercase; letter-spacing: 1px; }
  .grid { display: grid; grid-template-columns: 1fr 1fr; gap: 16px; margin-bottom: 16px; }
  .card { background: #151515; border: 1px solid #222; border-radius: 8px; padding: 16px; }
  .card.full { grid-column: 1 / -1; }
  .status-row { display: flex; justify-content: space-between; align-items: center; padding: 6px 0; border-bottom: 1px solid #1a1a1a; }
  .status-row:last-child { border-bottom: none; }
  .dot { width: 8px; height: 8px; border-radius: 50%; display: inline-block; margin-right: 8px; }
  .dot.green { background: #22c55e; box-shadow: 0 0 6px #22c55e55; }
  .dot.red { background: #ef4444; box-shadow: 0 0 6px #ef444455; }
  .dot.yellow { background: #eab308; box-shadow: 0 0 6px #eab30855; }
  .stat { text-align: center; }
  .stat .value { font-size: 2em; font-weight: bold; color: #fff; }
  .stat .label { font-size: 0.75em; color: #666; }
  .stats-grid { display: grid; grid-template-columns: repeat(6, 1fr); gap: 12px; }
  table { width: 100%; border-collapse: collapse; font-size: 0.85em; }
  th { text-align: left; color: #666; font-weight: normal; padding: 4px 8px; border-bottom: 1px solid #222; }
  td { padding: 4px 8px; border-bottom: 1px solid #1a1a1a; }
  .type { padding: 2px 6px; border-radius: 3px; font-size: 0.8em; }
  .type-message_received { background: #1e3a5f; color: #60a5fa; }
  .type-message_sent { background: #1a3f2e; color: #4ade80; }
  .type-dispatch_start { background: #3f3f1a; color: #facc15; }
  .type-dispatch_end { background: #1a3f2e; color: #4ade80; }
  .type-dispatch_error { background: #3f1a1a; color: #f87171; }
  .type-schedule_fire { background: #2e1a3f; color: #c084fc; }
  .type-startup { background: #1a2e3f; color: #38bdf8; }
  .error-row td { color: #f87171; }
  .process-row { display: flex; justify-content: space-between; padding: 6px 0; border-bottom: 1px solid #1a1a1a; font-size: 0.85em; }
  .ago { color: #666; font-size: 0.85em; }
  .refresh { color: #444; font-size: 0.75em; float: right; }
  pre { font-size: 0.8em; color: #aaa; white-space: pre-wrap; max-height: 200px; overflow-y: auto; }
</style>
</head>
<body>
<h1>Edith Dashboard <span class="refresh" id="refresh">updating...</span></h1>

<div class="grid">
  <div class="card">
    <h2>System Health</h2>
    <div id="health"></div>
  </div>
  <div class="card">
    <h2>Active Processes</h2>
    <div id="processes"></div>
  </div>
</div>

<div class="card" style="margin-bottom:16px">
  <h2>Today's Stats</h2>
  <div class="stats-grid" id="stats"></div>
</div>

<div class="grid">
  <div class="card full">
    <h2>Event Feed</h2>
    <div id="events" style="max-height:400px;overflow-y:auto"></div>
  </div>
</div>

<div class="grid">
  <div class="card">
    <h2>Schedule</h2>
    <div id="schedule"></div>
  </div>
  <div class="card">
    <h2>Taskboard</h2>
    <pre id="taskboard"></pre>
  </div>
</div>

<script>
function ago(ts) {
  const s = Math.floor((Date.now() - new Date(ts).getTime()) / 1000);
  if (s < 60) return s + 's ago';
  if (s < 3600) return Math.floor(s/60) + 'm ago';
  if (s < 86400) return Math.floor(s/3600) + 'h ago';
  return Math.floor(s/86400) + 'd ago';
}

function dot(ok) {
  return '<span class="dot ' + (ok ? 'green' : 'red') + '"></span>';
}

async function refresh() {
  try {
    const [statusRes, eventsRes, taskboardRes] = await Promise.all([
      fetch('/api/status').then(r => r.json()),
      fetch('/api/events?limit=50').then(r => r.json()),
      fetch('/api/taskboard').then(r => r.text()),
    ]);

    const status = statusRes;
    const events = eventsRes.events;
    const stats = eventsRes.stats;

    // Health
    document.getElementById('health').innerHTML = [
      ['Edith', status.edith],
      ['n8n', status.n8n],
      ['Cognee', status.cognee],
    ].map(([name, ok]) =>
      '<div class="status-row">' + dot(ok) + name + '</div>'
    ).join('');

    // Active processes
    const procs = status.activeProcesses;
    document.getElementById('processes').innerHTML = procs.length === 0
      ? '<div style="color:#666;padding:8px 0">No active processes</div>'
      : procs.map(p =>
          '<div class="process-row"><span>PID ' + p.pid + ' — ' + p.label + '</span><span class="ago">' + ago(p.startedAt) + '</span></div>'
        ).join('');

    // Stats
    document.getElementById('stats').innerHTML = [
      [stats.messagesReceived, 'Received'],
      [stats.messagesSent, 'Sent'],
      [stats.dispatches, 'Dispatches'],
      [stats.errors, 'Errors'],
      [stats.tasksFired, 'Tasks'],
      [stats.avgDispatchMs ? (stats.avgDispatchMs/1000).toFixed(1) + 's' : '—', 'Avg Time'],
    ].map(([v, l]) =>
      '<div class="stat"><div class="value">' + v + '</div><div class="label">' + l + '</div></div>'
    ).join('');

    // Events
    document.getElementById('events').innerHTML = '<table><tr><th>Time</th><th>Type</th><th>Details</th></tr>' +
      events.map(e => {
        const cls = e.type === 'dispatch_error' ? ' class="error-row"' : '';
        const detail = e.label || e.text || e.task || e.error || e.prompt || '';
        return '<tr' + cls + '><td class="ago">' + ago(e.ts) + '</td><td><span class="type type-' + e.type + '">' + e.type + '</span></td><td>' + (typeof detail === 'string' ? detail.slice(0,80) : '') + '</td></tr>';
      }).join('') + '</table>';

    // Schedule
    const sched = status.schedule;
    const lastFired = status.scheduleState.lastFired || {};
    document.getElementById('schedule').innerHTML = sched.map(t => {
      const time = t.intervalMinutes ? 'every ' + t.intervalMinutes + 'min' : (t.hour ?? 0) + ':' + String(t.minute ?? 0).padStart(2, '0');
      const last = lastFired[t.name] ? ago(lastFired[t.name]) : 'never';
      return '<div class="status-row"><span>' + t.name + ' <span class="ago">(' + time + ')</span></span><span class="ago">last: ' + last + '</span></div>';
    }).join('');

    // Taskboard
    document.getElementById('taskboard').textContent = taskboardRes || '(empty)';

    document.getElementById('refresh').textContent = 'updated ' + new Date().toLocaleTimeString();
  } catch (err) {
    document.getElementById('refresh').textContent = 'error: ' + err.message;
  }
}

refresh();
setInterval(refresh, 5000);
</script>
</body>
</html>`;

const server = Bun.serve({
  port: PORT,
  async fetch(req) {
    const url = new URL(req.url);

    if (url.pathname === "/" || url.pathname === "/index.html") {
      return new Response(DASHBOARD_HTML, { headers: { "Content-Type": "text/html" } });
    }

    if (url.pathname === "/api/status") {
      const status = await getStatus();
      return Response.json(status);
    }

    if (url.pathname === "/api/events") {
      const limit = Number(url.searchParams.get("limit") ?? 100);
      const events = readEventsFile(limit);
      const stats = getStats(events);
      return Response.json({ events, stats });
    }

    if (url.pathname === "/api/taskboard") {
      const content = readTextFile(join(STATE_DIR, "taskboard.md"));
      return new Response(content, { headers: { "Content-Type": "text/plain" } });
    }

    if (url.pathname === "/api/schedule") {
      return Response.json({
        schedule: readJsonFile(join(STATE_DIR, "schedule.json")) ?? [],
        state: readJsonFile(join(STATE_DIR, "schedule-state.json")) ?? {},
      });
    }

    return new Response("Not found", { status: 404 });
  },
});

console.log(`[dashboard] Edith Dashboard running at http://localhost:${PORT}`);
