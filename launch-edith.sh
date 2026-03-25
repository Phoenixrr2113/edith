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

# Check Docker is running
if ! docker info >/dev/null 2>&1; then
  echo "[launch] ERROR: Docker is not running. Start Docker Desktop first."
  exit 1
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
for i in {1..15}; do
  N8N_OK=$(curl -s -o /dev/null -w "%{http_code}" "http://localhost:$N8N_PORT/healthz" 2>/dev/null)
  if [ "$N8N_OK" = "200" ]; then break; fi
  sleep 2
done
echo "[launch] n8n: ${N8N_OK:-down}, cognee: running"

# --- Start dashboard ---
bun "$DIR/dashboard.ts" &
DASHBOARD_PID=$!
echo "[launch] Dashboard started (PID $DASHBOARD_PID) at http://localhost:$DASHBOARD_PORT"

# --- Start Edith with auto-restart on file changes ---
echo "[launch] Starting Edith..."

start_edith() {
  bun "$DIR/edith.ts" &
  EDITH_PID=$!
  echo "[launch] Edith started (PID $EDITH_PID)"
}

start_edith

# --- Cleanup on exit ---
cleanup() {
  echo "[launch] Shutting down..."
  kill $EDITH_PID 2>/dev/null
  kill $DASHBOARD_PID 2>/dev/null
  [ -n "$WATCHER_PID" ] && kill $WATCHER_PID 2>/dev/null
  rm -f "$PID_FILE"
  # Keep session-id so Edith resumes context on restart
  # (auto-recovery handles corrupted sessions)
  exit 0
}
trap cleanup SIGINT SIGTERM EXIT

# --- File watcher: restart Edith on .ts changes ---
if command -v fswatch >/dev/null 2>&1; then
  (
    fswatch -o -e "node_modules" -e ".git" -i "\\.ts$" "$DIR/edith.ts" "$DIR/mcp/" "$DIR/prompts/" | while read -r; do
      echo "[launch] File change detected, restarting Edith..."
      kill $EDITH_PID 2>/dev/null
      sleep 2
      start_edith
    done
  ) &
  WATCHER_PID=$!
  echo "[launch] File watcher active (fswatch PID $WATCHER_PID)"
else
  echo "[launch] fswatch not found — auto-restart disabled. Install: brew install fswatch"
fi

# Wait for Edith to exit (keeps shell alive so trap works)
wait $EDITH_PID
