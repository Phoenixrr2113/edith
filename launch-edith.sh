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
command -v docker >/dev/null 2>&1 || MISSING="$MISSING docker"
if [ -n "$MISSING" ]; then
  echo "[launch] ERROR: Missing required tools:$MISSING"
  exit 1
fi
# Optional tools — warn but continue
command -v terminal-notifier >/dev/null 2>&1 || echo "[launch] NOTE: terminal-notifier not installed — desktop notifications disabled"
command -v fswatch >/dev/null 2>&1 || echo "[launch] NOTE: fswatch not installed — auto-restart on file changes disabled"

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
  # Check if it's an n8n container we can reuse
  EXISTING_CONTAINER=$(docker ps --filter "publish=$N8N_PORT" --format "{{.Names}}" 2>/dev/null)
  if echo "$EXISTING_CONTAINER" | grep -qi "n8n"; then
    echo "[launch] n8n already running (container $EXISTING_CONTAINER), reusing"
    N8N_SKIP=true
  else
    echo "[launch] ERROR: Port $N8N_PORT is already in use by another process"
    echo "         Run: lsof -i :$N8N_PORT  to see what's using it"
    echo "         Either free the port or set N8N_PORT to a different value"
    exit 1
  fi
fi

# --- Pre-flight ---
mkdir -p "$STATE_DIR" "$DIR/logs"

# Start Docker Desktop if not running (macOS)
if ! docker info >/dev/null 2>&1; then
  echo "[launch] Docker not running, starting Docker Desktop..."
  open -a "Docker" 2>/dev/null
  # Wait up to 60s for Docker to be ready
  for i in {1..30}; do
    if docker info >/dev/null 2>&1; then break; fi
    sleep 2
  done
  if ! docker info >/dev/null 2>&1; then
    echo "[launch] ERROR: Docker failed to start after 60s. Start Docker Desktop manually."
    exit 1
  fi
  echo "[launch] Docker Desktop started"
fi

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

# --- Start Docker services (Cognee + n8n) ---
echo "[launch] Starting Docker services..."
if [ "$N8N_SKIP" = true ]; then
  docker compose up -d cognee 2>&1 | grep -v "^$"
else
  docker compose up -d 2>&1 | grep -v "^$"
fi

# Wait for services to be healthy
echo "[launch] Waiting for services..."
N8N_OK="down"
COGNEE_OK="down"
for i in {1..30}; do
  [ "$N8N_OK" = "down" ] && curl -s -o /dev/null -w "" "http://localhost:$N8N_PORT/healthz" 2>/dev/null && N8N_OK="up"
  if [ "$COGNEE_OK" = "down" ]; then curl -s -o /dev/null --max-time 2 "http://localhost:8001/sse" 2>/dev/null; RC=$?; [ $RC -eq 0 ] || [ $RC -eq 28 ] && COGNEE_OK="up"; fi
  if [ "$N8N_OK" = "up" ] && [ "$COGNEE_OK" = "up" ]; then break; fi
  sleep 2
done
echo "[launch] n8n: $N8N_OK, cognee: $COGNEE_OK"
[ "$N8N_OK" = "down" ] && echo "[launch] WARNING: n8n not healthy — calendar/email may not work"
[ "$COGNEE_OK" = "down" ] && echo "[launch] WARNING: Cognee not healthy — knowledge graph unavailable"

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
