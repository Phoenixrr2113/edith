/**
 * Edith Dashboard — status monitor with live logs, task triggers, and transcript viewer.
 * Serves at http://localhost:3456
 */
import { existsSync, readFileSync, writeFileSync, readdirSync, statSync, mkdirSync } from "fs";
import { join, basename } from "path";
import { homedir } from "os";

const PORT = Number(process.env.DASHBOARD_PORT ?? 3456);
const STATE_DIR = join(process.env.HOME ?? homedir(), ".edith");
const TRIGGERS_DIR = join(STATE_DIR, "triggers");
const TRANSCRIPTS_DIR = join(STATE_DIR, "transcripts");
const N8N_URL = process.env.N8N_URL ?? "http://localhost:5679";
const COGNEE_URL = process.env.COGNEE_URL ?? "http://localhost:8001";

// Ensure triggers dir exists
if (!existsSync(TRIGGERS_DIR)) mkdirSync(TRIGGERS_DIR, { recursive: true });

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
    process.kill(pid, 0);
    return true;
  } catch { return false; }
}

async function getStatus() {
  const [n8nOk, cogneeOk, screenpipeOk] = await Promise.all([
    checkHealth(`${N8N_URL}/healthz`),
    (async () => {
      const c = new AbortController();
      const timeoutId = setTimeout(() => c.abort(), 2000);
      try {
        await fetch(`${COGNEE_URL}/sse`, { signal: c.signal });
        return true;
      } catch (e: any) {
        return e?.name === "AbortError";
      } finally {
        clearTimeout(timeoutId);
      }
    })(),
    checkHealth("http://localhost:3030/health"),
  ]);

  const proactiveState = readJsonFile(join(STATE_DIR, "proactive-state.json"));

  return {
    edith: isEdithAlive(),
    n8n: n8nOk,
    cognee: cogneeOk,
    screenpipe: screenpipeOk,
    sessionId: readTextFile(join(STATE_DIR, "session-id")).trim() || null,
    activeProcesses: readJsonFile(join(STATE_DIR, "active-processes.json")) ?? [],
    schedule: readJsonFile(join(STATE_DIR, "schedule.json")) ?? [],
    scheduleState: readJsonFile(join(STATE_DIR, "schedule-state.json")) ?? {},
    proactive: {
      interventions: (proactiveState?.interventions ?? []).filter(
        (i: any) => Date.now() - new Date(i.timestamp).getTime() < 24 * 60 * 60 * 1000
      ),
      lastCheck: proactiveState?.lastCheck ?? null,
    },
    reminders: readJsonFile(join(STATE_DIR, "reminders.json")) ?? [],
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
    costUsd: (() => {
      const costs = today.filter((e) => e.type === "cost" && e.usd).map((e) => e.usd as number);
      return costs.length > 0 ? costs.reduce((a, b) => a + b, 0) : 0;
    })(),
  };
}

function listTranscripts(limit = 20): { name: string; size: number; modified: string }[] {
  if (!existsSync(TRANSCRIPTS_DIR)) return [];
  try {
    return readdirSync(TRANSCRIPTS_DIR)
      .filter((f) => f.endsWith(".jsonl"))
      .map((f) => {
        const fp = join(TRANSCRIPTS_DIR, f);
        const st = statSync(fp);
        return { name: f, size: st.size, modified: st.mtime.toISOString() };
      })
      .sort((a, b) => b.modified.localeCompare(a.modified))
      .slice(0, limit);
  } catch { return []; }
}

function readTranscript(name: string): any[] {
  const safeName = basename(name);
  const fp = join(TRANSCRIPTS_DIR, safeName);
  if (!existsSync(fp)) return [];
  try {
    return readFileSync(fp, "utf-8").split("\n").filter(Boolean).map((l) => {
      try { return JSON.parse(l); } catch { return null; }
    }).filter(Boolean);
  } catch { return []; }
}

// --- SSE log streaming ---
let logFileSize = 0;
const LOG_FILE = join(STATE_DIR, "edith.log");

function getNewLogLines(): string[] {
  if (!existsSync(LOG_FILE)) return [];
  try {
    const st = statSync(LOG_FILE);
    if (st.size <= logFileSize) {
      if (st.size < logFileSize) logFileSize = 0; // file was rotated
      return [];
    }
    const { openSync, readSync, closeSync } = require("fs");
    const fd = openSync(LOG_FILE, "r");
    const bytesToRead = st.size - logFileSize;
    const buf = Buffer.alloc(bytesToRead);
    readSync(fd, buf, 0, bytesToRead, logFileSize);
    closeSync(fd);
    logFileSize = st.size;
    return buf.toString("utf-8").split("\n").filter(Boolean);
  } catch { return []; }
}

// Initialize log file position to end
try { if (existsSync(LOG_FILE)) logFileSize = statSync(LOG_FILE).size; } catch {}

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
  .grid-3 { display: grid; grid-template-columns: 1fr 1fr 1fr; gap: 16px; margin-bottom: 16px; }
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
  .stats-grid { display: grid; grid-template-columns: repeat(7, 1fr); gap: 12px; }
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
  .btn { background: #1a1a2e; border: 1px solid #333; color: #60a5fa; padding: 6px 12px; border-radius: 4px; cursor: pointer; font-family: inherit; font-size: 0.85em; transition: all 0.15s; }
  .btn:hover { background: #1e3a5f; border-color: #60a5fa; }
  .btn:active { transform: scale(0.97); }
  .btn.firing { background: #3f3f1a; color: #facc15; border-color: #facc15; }
  .btn-row { display: flex; gap: 8px; flex-wrap: wrap; }
  .log-stream { background: #0d0d0d; border: 1px solid #1a1a1a; border-radius: 4px; padding: 8px; font-family: 'SF Mono', monospace; font-size: 0.78em; line-height: 1.5; max-height: 300px; overflow-y: auto; color: #888; }
  .log-stream .log-error { color: #f87171; }
  .log-stream .log-warn { color: #facc15; }
  .log-stream .log-info { color: #60a5fa; }
  .transcript-list { max-height: 200px; overflow-y: auto; }
  .transcript-item { display: flex; justify-content: space-between; padding: 4px 0; border-bottom: 1px solid #1a1a1a; cursor: pointer; font-size: 0.85em; }
  .transcript-item:hover { color: #60a5fa; }
  .transcript-viewer { display: none; max-height: 400px; overflow-y: auto; background: #0d0d0d; border: 1px solid #1a1a1a; border-radius: 4px; padding: 8px; font-size: 0.78em; }
  .transcript-msg { padding: 4px 0; border-bottom: 1px solid #111; }
  .transcript-msg.assistant { color: #4ade80; }
  .transcript-msg.user { color: #60a5fa; }
  .transcript-msg.result { color: #c084fc; }
  .transcript-msg.tool { color: #facc15; }
  .tabs { display: flex; gap: 0; margin-bottom: 0; }
  .tab { padding: 8px 16px; cursor: pointer; border: 1px solid #222; border-bottom: none; border-radius: 8px 8px 0 0; background: #0a0a0a; color: #666; font-size: 0.85em; }
  .tab.active { background: #151515; color: #fff; border-color: #222; }
  .tab-content { display: none; }
  .tab-content.active { display: block; }
  .msg-bar { display: flex; gap: 8px; margin-bottom: 16px; }
  .msg-bar input { flex: 1; background: #151515; border: 1px solid #333; border-radius: 6px; padding: 10px 14px; color: #e0e0e0; font-family: inherit; font-size: 0.9em; outline: none; }
  .msg-bar input:focus { border-color: #60a5fa; }
  .msg-bar input::placeholder { color: #555; }
  .msg-bar button { white-space: nowrap; }
  .toggle-btn { position: relative; width: 44px; height: 24px; border-radius: 12px; border: none; cursor: pointer; transition: background 0.2s; }
  .toggle-btn.on { background: #22c55e; }
  .toggle-btn.off { background: #444; }
  .toggle-btn::after { content: ''; position: absolute; top: 3px; left: 3px; width: 18px; height: 18px; border-radius: 50%; background: #fff; transition: transform 0.2s; }
  .toggle-btn.on::after { transform: translateX(20px); }
  .intervention-item { display: flex; justify-content: space-between; padding: 5px 0; border-bottom: 1px solid #1a1a1a; font-size: 0.83em; }
  .intervention-cat { color: #c084fc; font-weight: 500; }
  .reminder-item { display: flex; justify-content: space-between; align-items: center; padding: 6px 0; border-bottom: 1px solid #1a1a1a; font-size: 0.85em; }
  .reminder-due { color: #facc15; font-size: 0.8em; }
  .reminder-fired { color: #666; text-decoration: line-through; }
</style>
</head>
<body>
<h1>Edith Dashboard <span class="refresh" id="refresh">updating...</span></h1>

<div class="msg-bar">
  <input type="text" id="msg-input" placeholder="Message Edith..." onkeydown="if(event.key==='Enter')sendMsg()">
  <button class="btn" onclick="sendMsg()">Send</button>
</div>

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

<div class="grid" style="margin-bottom:16px">
  <div class="card">
    <h2 style="display:flex;justify-content:space-between;align-items:center">
      Proactive
      <button class="toggle-btn on" id="proactive-toggle" onclick="toggleProactive()"></button>
    </h2>
    <div id="proactive-interventions" style="max-height:180px;overflow-y:auto;margin-top:8px"></div>
  </div>
  <div class="card">
    <h2>Reminders</h2>
    <div id="reminders" style="max-height:180px;overflow-y:auto"></div>
  </div>
</div>

<div class="card" style="margin-bottom:16px">
  <h2>Task Triggers</h2>
  <div class="btn-row" id="triggers"></div>
</div>

<div class="card" style="margin-bottom:16px">
  <div class="tabs">
    <div class="tab active" onclick="switchTab('events', this)">Event Feed</div>
    <div class="tab" onclick="switchTab('logs', this)">Live Logs</div>
    <div class="tab" onclick="switchTab('transcripts', this)">Transcripts</div>
  </div>
  <div id="tab-events" class="tab-content active" style="max-height:400px;overflow-y:auto"></div>
  <div id="tab-logs" class="tab-content">
    <div class="log-stream" id="log-stream"></div>
  </div>
  <div id="tab-transcripts" class="tab-content">
    <div class="transcript-list" id="transcript-list"></div>
    <div class="transcript-viewer" id="transcript-viewer"></div>
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
function dot(ok) { return '<span class="dot ' + (ok ? 'green' : 'red') + '"></span>'; }
function esc(s) { return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;').replace(/'/g,'&#39;'); }

// --- Tabs ---
function switchTab(name, el) {
  document.querySelectorAll('.tab').forEach(t => t.classList.remove('active'));
  document.querySelectorAll('.tab-content').forEach(t => t.classList.remove('active'));
  document.querySelector('.tab-content#tab-' + name).classList.add('active');
  el.classList.add('active');
  if (name === 'logs' && !logStreamStarted) startLogStream();
  if (name === 'transcripts') loadTranscripts();
}

// --- Send message ---
async function sendMsg() {
  const input = document.getElementById('msg-input');
  const text = input.value.trim();
  if (!text) return;
  input.value = '';
  input.disabled = true;
  try {
    await fetch('/api/message', { method: 'POST', headers: {'Content-Type':'application/json'}, body: JSON.stringify({text}) });
  } catch {}
  input.disabled = false;
  input.focus();
}

// --- Proactive toggle ---
async function toggleProactive() {
  try {
    const res = await fetch('/api/proactive/toggle', { method: 'POST' });
    const data = await res.json();
    const btn = document.getElementById('proactive-toggle');
    btn.className = 'toggle-btn ' + (data.enabled ? 'on' : 'off');
  } catch {}
}

// --- Task Triggers ---
async function triggerTask(name, btn) {
  btn.classList.add('firing');
  btn.textContent = 'firing...';
  try {
    const res = await fetch('/api/trigger', { method: 'POST', headers: {'Content-Type':'application/json'}, body: JSON.stringify({task: name}) });
    const data = await res.json();
    btn.textContent = data.ok ? 'triggered!' : 'failed';
  } catch { btn.textContent = 'error'; }
  setTimeout(() => { btn.classList.remove('firing'); btn.textContent = name; }, 2000);
}

// --- Log Stream (SSE) ---
let logStreamStarted = false;
function startLogStream() {
  logStreamStarted = true;
  const el = document.getElementById('log-stream');
  const source = new EventSource('/api/logs/stream');
  source.onmessage = function(e) {
    const line = e.data;
    const div = document.createElement('div');
    if (line.includes('Error') || line.includes('error') || line.includes('❌')) div.className = 'log-error';
    else if (line.includes('warn') || line.includes('⚠')) div.className = 'log-warn';
    else if (line.includes('✅') || line.includes('done')) div.className = 'log-info';
    div.textContent = line;
    el.appendChild(div);
    // Keep last 500 lines
    while (el.childNodes.length > 500) el.removeChild(el.firstChild);
    el.scrollTop = el.scrollHeight;
  };
  source.onerror = function() {
    const div = document.createElement('div');
    div.className = 'log-error';
    div.textContent = '[stream disconnected, retrying...]';
    el.appendChild(div);
  };
}

// --- Transcripts ---
async function loadTranscripts() {
  const res = await fetch('/api/transcripts');
  const list = await res.json();
  const el = document.getElementById('transcript-list');
  el.innerHTML = list.map(t =>
    '<div class="transcript-item" onclick="viewTranscript(\\'' + esc(t.name) + '\\')">' +
    '<span>' + esc(t.name.replace('.jsonl','')) + '</span>' +
    '<span class="ago">' + (t.size/1024).toFixed(1) + 'KB — ' + ago(t.modified) + '</span></div>'
  ).join('') || '<div style="color:#666;padding:8px">No transcripts yet</div>';
}

async function viewTranscript(name) {
  const viewer = document.getElementById('transcript-viewer');
  viewer.style.display = 'block';
  viewer.innerHTML = '<div style="color:#666">Loading...</div>';
  const res = await fetch('/api/transcripts/' + encodeURIComponent(name));
  const messages = await res.json();
  viewer.innerHTML = messages.map(m => {
    const cls = m.type || 'unknown';
    let content = '';
    if (m.type === 'assistant' && m.text) content = m.text;
    else if (m.type === 'user') content = m.message || m.text || '';
    else if (m.type === 'result') content = 'Cost: $' + (m.cost || 0).toFixed(4) + ' | Turns: ' + (m.turns || 0);
    else if (m.type === 'tool_use') content = m.tool + '(' + (m.input || '').slice(0,80) + ')';
    else content = JSON.stringify(m).slice(0,120);
    return '<div class="transcript-msg ' + cls + '">[' + cls + '] ' + esc(content) + '</div>';
  }).join('') || '<div style="color:#666">Empty transcript</div>';
  viewer.scrollTop = 0;
}

// --- Main refresh ---
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
      ['Screenpipe', status.screenpipe],
    ].map(([name, ok]) => '<div class="status-row">' + dot(ok) + name + '</div>').join('');

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
      [stats.avgDispatchMs ? (stats.avgDispatchMs/1000).toFixed(1) + 's' : '\u2014', 'Avg Time'],
      [stats.costUsd > 0 ? '$' + stats.costUsd.toFixed(2) : '$0', 'Cost Today'],
    ].map(([v, l]) =>
      '<div class="stat"><div class="value">' + v + '</div><div class="label">' + l + '</div></div>'
    ).join('');

    // Task triggers
    const sched = status.schedule;
    document.getElementById('triggers').innerHTML = sched.map(t =>
      '<button class="btn" onclick="triggerTask(\\'' + esc(t.name) + '\\', this)">' + esc(t.name) + '</button>'
    ).join('');

    // Events
    document.getElementById('tab-events').innerHTML = '<table><tr><th>Time</th><th>Type</th><th>Details</th></tr>' +
      events.map(e => {
        const cls = e.type === 'dispatch_error' ? ' class="error-row"' : '';
        const detail = e.label || e.text || e.task || e.error || e.prompt || '';
        return '<tr' + cls + '><td class="ago">' + ago(e.ts) + '</td><td><span class="type type-' + e.type + '">' + esc(e.type) + '</span></td><td>' + esc(typeof detail === 'string' ? detail.slice(0,80) : '') + '</td></tr>';
      }).join('') + '</table>';

    // Schedule
    const lastFired = status.scheduleState.lastFired || {};
    document.getElementById('schedule').innerHTML = sched.map(t => {
      const time = t.intervalMinutes ? 'every ' + t.intervalMinutes + 'min' : (t.hour ?? 0) + ':' + String(t.minute ?? 0).padStart(2, '0');
      const last = lastFired[t.name] ? ago(lastFired[t.name]) : 'never';
      return '<div class="status-row"><span>' + t.name + ' <span class="ago">(' + time + ')</span></span><span class="ago">last: ' + last + '</span></div>';
    }).join('');

    // Proactive
    const proToggle = document.getElementById('proactive-toggle');
    fetch('/api/proactive/config').then(r=>r.json()).then(cfg => {
      proToggle.className = 'toggle-btn ' + (cfg.enabled !== false ? 'on' : 'off');
    }).catch(()=>{});
    const interventions = status.proactive?.interventions || [];
    document.getElementById('proactive-interventions').innerHTML = interventions.length === 0
      ? '<div style="color:#666;padding:4px 0">No interventions today</div>'
      : interventions.slice(0, 20).map(i =>
          '<div class="intervention-item"><span><span class="intervention-cat">' + esc(i.category) + '</span> ' + esc(i.message) + '</span><span class="ago">' + ago(i.timestamp) + '</span></div>'
        ).join('');

    // Reminders
    const reminders = status.reminders || [];
    const activeReminders = reminders.filter(r => !r.fired);
    const firedReminders = reminders.filter(r => r.fired).slice(0, 5);
    document.getElementById('reminders').innerHTML = (activeReminders.length === 0 && firedReminders.length === 0)
      ? '<div style="color:#666;padding:4px 0">No reminders</div>'
      : activeReminders.map(r =>
          '<div class="reminder-item"><span>' + esc(r.text || r.message || '') + '</span><span class="reminder-due">' + (r.due ? ago(r.due) : '') + '</span></div>'
        ).join('') +
        firedReminders.map(r =>
          '<div class="reminder-item reminder-fired"><span>' + esc(r.text || r.message || '') + '</span><span class="ago">done</span></div>'
        ).join('');

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

// --- Server ---
const sseClients = new Set<ReadableStreamDefaultController>();

// Poll log file for new lines and push to SSE clients
setInterval(() => {
  const lines = getNewLogLines();
  if (lines.length === 0 || sseClients.size === 0) return;
  for (const line of lines) {
    // SSE requires each line prefixed with "data: "; escape internal newlines
    const data = line.split("\n").map((l) => `data: ${l}`).join("\n") + "\n\n";
    for (const controller of sseClients) {
      try { controller.enqueue(data); } catch { sseClients.delete(controller); }
    }
  }
}, 1000);

const server = Bun.serve({
  port: PORT,
  hostname: "127.0.0.1",
  async fetch(req) {
    const url = new URL(req.url);

    if (url.pathname === "/" || url.pathname === "/index.html") {
      return new Response(DASHBOARD_HTML, { headers: { "Content-Type": "text/html" } });
    }

    if (url.pathname === "/api/status") {
      return Response.json(await getStatus());
    }

    if (url.pathname === "/api/events") {
      const limit = Number(url.searchParams.get("limit") ?? 100);
      const events = readEventsFile(limit);
      return Response.json({ events, stats: getStats(events) });
    }

    if (url.pathname === "/api/taskboard") {
      return new Response(readTextFile(join(STATE_DIR, "taskboard.md")), { headers: { "Content-Type": "text/plain" } });
    }

    if (url.pathname === "/api/schedule") {
      return Response.json({
        schedule: readJsonFile(join(STATE_DIR, "schedule.json")) ?? [],
        state: readJsonFile(join(STATE_DIR, "schedule-state.json")) ?? {},
      });
    }

    // --- Task trigger ---
    if (url.pathname === "/api/trigger" && req.method === "POST") {
      try {
        const { task } = await req.json() as { task: string };
        if (!task) return Response.json({ ok: false, error: "missing task" }, { status: 400 });
        // Sanitize: prevent path traversal
        const safeName = basename(task);
        if (!safeName || safeName === "." || safeName === "..") return Response.json({ ok: false, error: "invalid task" }, { status: 400 });
        // Write trigger file — edith.ts will pick it up
        writeFileSync(join(TRIGGERS_DIR, safeName), new Date().toISOString(), "utf-8");
        return Response.json({ ok: true, task });
      } catch (err) {
        return Response.json({ ok: false, error: String(err) }, { status: 500 });
      }
    }

    // --- SSE log stream ---
    if (url.pathname === "/api/logs/stream") {
      let ctrl: ReadableStreamDefaultController;
      const stream = new ReadableStream({
        start(controller) {
          ctrl = controller;
          sseClients.add(controller);
          controller.enqueue("data: [connected to log stream]\n\n");
        },
        cancel() {
          sseClients.delete(ctrl);
        },
      });
      return new Response(stream, {
        headers: {
          "Content-Type": "text/event-stream",
          "Cache-Control": "no-cache",
          "Connection": "keep-alive",
        },
      });
    }

    // --- Transcripts ---
    if (url.pathname === "/api/transcripts") {
      return Response.json(listTranscripts());
    }

    if (url.pathname.startsWith("/api/transcripts/")) {
      const name = decodeURIComponent(url.pathname.slice("/api/transcripts/".length));
      return Response.json(readTranscript(name));
    }

    // --- Send message to Edith (writes to inbox for edith.ts to pick up) ---
    if (url.pathname === "/api/message" && req.method === "POST") {
      try {
        const { text } = await req.json() as { text: string };
        if (!text?.trim()) return Response.json({ ok: false, error: "empty message" }, { status: 400 });
        if (Buffer.byteLength(text, "utf-8") > 10 * 1024) return Response.json({ ok: false, error: "message too large" }, { status: 413 });
        const inboxDir = join(STATE_DIR, "inbox");
        mkdirSync(inboxDir, { recursive: true });
        const filename = `dashboard-${Date.now()}.json`;
        writeFileSync(join(inboxDir, filename), JSON.stringify({
          source: "dashboard",
          text: text.trim(),
          ts: new Date().toISOString(),
        }), "utf-8");
        return Response.json({ ok: true });
      } catch (err) {
        return Response.json({ ok: false, error: String(err) }, { status: 500 });
      }
    }

    // --- Proactive toggle ---
    if (url.pathname === "/api/proactive/toggle" && req.method === "POST") {
      try {
        const stateFile = join(STATE_DIR, "proactive-config.json");
        const config = readJsonFile(stateFile) ?? { enabled: true };
        config.enabled = !config.enabled;
        writeFileSync(stateFile, JSON.stringify(config, null, 2), "utf-8");
        return Response.json({ ok: true, enabled: config.enabled });
      } catch (err) {
        return Response.json({ ok: false, error: String(err) }, { status: 500 });
      }
    }

    // --- Proactive config ---
    if (url.pathname === "/api/proactive/config") {
      const config = readJsonFile(join(STATE_DIR, "proactive-config.json")) ?? { enabled: true };
      return Response.json(config);
    }

    // --- Reminders list ---
    if (url.pathname === "/api/reminders") {
      return Response.json(readJsonFile(join(STATE_DIR, "reminders.json")) ?? []);
    }

    return new Response("Not found", { status: 404 });
  },
});

console.log(`[dashboard] Edith Dashboard running at http://localhost:${PORT}`);
