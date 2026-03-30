#!/bin/bash
# Launch Edith — starts Docker services, dashboard, and the main orchestrator
DIR="$(cd "$(dirname "$0")" && pwd)"
cd "$DIR"

# Source environment
if [ -f "$DIR/.env" ]; then
  set -a
  source "$DIR/.env"
  set +a
fi

# Ensure PATH includes common tool locations
export PATH="/usr/local/bin:/opt/homebrew/bin:$HOME/.bun/bin:$PATH"

STATE_DIR="$HOME/.edith"
mkdir -p "$STATE_DIR"

# --- Check required tools ---
MISSING=""
command -v bun >/dev/null 2>&1 || MISSING="$MISSING bun"
command -v node >/dev/null 2>&1 || MISSING="$MISSING node"
command -v uv >/dev/null 2>&1 || MISSING="$MISSING uv"
if [ -n "$MISSING" ]; then
  echo "[launch] ERROR: Missing required tools:$MISSING"
  exit 1
fi
# Optional tools — warn but continue
command -v terminal-notifier >/dev/null 2>&1 || echo "[launch] NOTE: terminal-notifier not installed — desktop notifications disabled"
command -v fswatch >/dev/null 2>&1 || echo "[launch] NOTE: fswatch not installed — auto-restart on file changes disabled"

# --- Start Docker services (Langfuse + Cognee + n8n) ---
if command -v docker >/dev/null 2>&1; then
  echo "[launch] Starting Docker services..."
  docker compose -f "$DIR/docker-compose.yml" up -d 2>/dev/null
  docker compose -f "$DIR/docker-compose.langfuse.yml" up -d 2>/dev/null
else
  echo "[launch] NOTE: Docker not available — Langfuse tracing and Cognee disabled"
fi

# --- Check required env vars ---
if [ -z "$TELEGRAM_BOT_TOKEN" ]; then
  echo "[launch] ERROR: TELEGRAM_BOT_TOKEN not set in .env"
  exit 1
fi
if [ -z "$TELEGRAM_CHAT_ID" ]; then
  echo "[launch] ERROR: TELEGRAM_CHAT_ID not set in .env"
  exit 1
fi

# --- Check for already-running Edith ---
PID_FILE="$STATE_DIR/edith.pid"
if [ -f "$PID_FILE" ]; then
  OLD_PID=$(cat "$PID_FILE")
  if kill -0 "$OLD_PID" 2>/dev/null; then
    echo "[launch] Edith is already running (PID $OLD_PID)"
    echo "         Dashboard: http://localhost:${DASHBOARD_PORT:-3456}"
    echo "         To stop: kill $OLD_PID"
    exit 1
  else
    echo "[launch] Stale PID file found (PID $OLD_PID not running), cleaning up"
    rm -f "$PID_FILE"
  fi
fi

# --- Check for port conflicts ---
DASHBOARD_PORT="${DASHBOARD_PORT:-3456}"
if lsof -i ":$DASHBOARD_PORT" -sTCP:LISTEN >/dev/null 2>&1; then
  EXISTING=$(lsof -i ":$DASHBOARD_PORT" -sTCP:LISTEN -t 2>/dev/null | head -1)
  echo "[launch] Port $DASHBOARD_PORT already in use (PID $EXISTING)"
  echo "         Kill it: kill $EXISTING"
  exit 1
fi

# --- Check if n8n port is already in use ---
N8N_PORT="${N8N_PORT:-5679}"
N8N_SKIP=false
if lsof -i ":$N8N_PORT" -sTCP:LISTEN >/dev/null 2>&1; then
  # Check if it's already an n8n process we can reuse
  EXISTING_PID=$(lsof -i ":$N8N_PORT" -sTCP:LISTEN -t 2>/dev/null | head -1)
  if ps -p "$EXISTING_PID" -o command= 2>/dev/null | grep -qi "n8n"; then
    echo "[launch] n8n already running (PID $EXISTING_PID), reusing"
    N8N_SKIP=true
  else
    echo "[launch] ERROR: Port $N8N_PORT is already in use by another process (PID $EXISTING_PID)"
    echo "         Run: lsof -i :$N8N_PORT  to see what's using it"
    exit 1
  fi
fi

# --- Pre-flight ---
mkdir -p "$STATE_DIR" "$DIR/logs"

# --- Backup n8n credentials (OAuth tokens etc) ---
N8N_DB="$DIR/n8n/data/database.sqlite"
N8N_BACKUP_DIR="$STATE_DIR/backups"
mkdir -p "$N8N_BACKUP_DIR"
if [ -f "$N8N_DB" ]; then
  cp "$N8N_DB" "$N8N_BACKUP_DIR/n8n-database-$(date +%Y%m%d).sqlite"
  # Keep only last 7 backups
  ls -t "$N8N_BACKUP_DIR"/n8n-database-*.sqlite 2>/dev/null | tail -n +8 | xargs rm -f 2>/dev/null
  echo "[launch] n8n database backed up to $N8N_BACKUP_DIR"
fi

# --- Symlink n8n data dir (n8n reads from ~/.n8n by default) ---
if [ ! -L "$HOME/.n8n" ] && [ ! -d "$HOME/.n8n" ]; then
  ln -s "$DIR/n8n/data" "$HOME/.n8n"
  echo "[launch] Symlinked ~/.n8n -> n8n/data"
elif [ -L "$HOME/.n8n" ]; then
  echo "[launch] ~/.n8n symlink already exists"
else
  echo "[launch] WARNING: ~/.n8n exists as a directory, not a symlink. n8n may use wrong data."
fi

# --- Start n8n as child process ---
echo "[launch] Starting n8n..."
N8N_PORT=5679 GENERIC_TIMEZONE="${TZ:-America/New_York}" npx n8n start > "$STATE_DIR/n8n.log" 2>&1 &
N8N_PID=$!
echo "[launch] n8n started (PID $N8N_PID)"

# Wait for n8n to be healthy
N8N_OK="down"
for i in {1..30}; do
  curl -s -o /dev/null --max-time 2 "http://localhost:$N8N_PORT/healthz" 2>/dev/null && N8N_OK="up" && break
  sleep 2
done
echo "[launch] n8n: $N8N_OK"
[ "$N8N_OK" = "down" ] && echo "[launch] WARNING: n8n not healthy — calendar/email may not work"

# Cognee starts automatically via MCP stdio when Agent SDK launches — no separate process needed

# --- Start Screenpipe if not running ---
if command -v screenpipe >/dev/null 2>&1; then
  if ! curl -s -o /dev/null "http://localhost:3030/health" 2>/dev/null; then
    echo "[launch] Starting Screenpipe..."
    screenpipe &>/dev/null &
    sleep 2
    if curl -s -o /dev/null "http://localhost:3030/health" 2>/dev/null; then
      echo "[launch] Screenpipe started"
    else
      echo "[launch] Screenpipe failed to start (permissions may be needed)"
    fi
  else
    echo "[launch] Screenpipe already running"
  fi
else
  echo "[launch] Screenpipe not installed — screen context unavailable"
fi

# --- Start dashboard ---
bun "$DIR/dashboard.ts" &
DASHBOARD_PID=$!
echo "[launch] Dashboard started (PID $DASHBOARD_PID) at http://localhost:$DASHBOARD_PORT"

# --- Start Edith with auto-restart on file changes ---
echo "[launch] Starting Edith..."

# Use a PID file for cross-process communication (fswatch runs in subshell)
EDITH_PIDFILE="$STATE_DIR/edith-launch.pid"

LOG_FILE="$STATE_DIR/edith.log"

start_edith() {
  EDITH_LOG_FILE="$LOG_FILE" bun "$DIR/edith.ts" &
  EDITH_PID=$!
  echo "$EDITH_PID" > "$EDITH_PIDFILE"
  echo "[launch] Edith started (PID $EDITH_PID)"
  echo "[launch] Logs: tail -f $LOG_FILE"
}

start_edith

# --- Cleanup on exit ---
cleanup() {
  echo "[launch] Shutting down..."
  # Read current PID from file (may have changed via file watcher restart)
  if [ -f "$EDITH_PIDFILE" ]; then
    kill "$(cat "$EDITH_PIDFILE")" 2>/dev/null
    rm -f "$EDITH_PIDFILE"
  fi
  kill $DASHBOARD_PID 2>/dev/null
  [ -n "$N8N_PID" ] && kill $N8N_PID 2>/dev/null
  [ -n "$TAIL_PID" ] && kill $TAIL_PID 2>/dev/null
  [ -n "$WATCHER_PID" ] && kill $WATCHER_PID 2>/dev/null
  rm -f "$PID_FILE"
  exit 0
}
trap cleanup SIGINT SIGTERM EXIT

# --- File watcher: restart Edith on .ts/md changes ---
if command -v fswatch >/dev/null 2>&1; then
  (
    fswatch -o -e "node_modules" -e ".git" -e "logs" -i "\\.ts$" -i "\\.md$" \
      "$DIR/edith.ts" "$DIR/lib/" "$DIR/mcp/" "$DIR/prompts/" | while read -r; do
      echo "[launch] File change detected, restarting Edith..."
      [ -f "$EDITH_PIDFILE" ] && kill "$(cat "$EDITH_PIDFILE")" 2>/dev/null
      sleep 2
      EDITH_LOG_FILE="$LOG_FILE" bun "$DIR/edith.ts" &
      echo "$!" > "$EDITH_PIDFILE"
      echo "[launch] Edith restarted (PID $!)"
    done
  ) &
  WATCHER_PID=$!
  echo "[launch] File watcher active (fswatch PID $WATCHER_PID)"
else
  echo "[launch] fswatch not found — auto-restart disabled. Install: brew install fswatch"
fi

# Keep shell alive — poll PID file since fswatch restarts spawn in a subshell
# (wait only works on direct children, not subshell children)
while true; do
  if [ -f "$EDITH_PIDFILE" ]; then
    CURRENT_PID=$(cat "$EDITH_PIDFILE" 2>/dev/null)
    if [ -n "$CURRENT_PID" ] && ! kill -0 "$CURRENT_PID" 2>/dev/null; then
      echo "[launch] Edith process $CURRENT_PID exited unexpectedly"
      break
    fi
  fi
  sleep 5
done
