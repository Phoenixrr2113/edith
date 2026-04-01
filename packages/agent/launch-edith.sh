#!/bin/bash
# Launch Edith — starts services, dashboard, and the main orchestrator (LOCAL only)
# For cloud/Railway deployment use edith-cloud.ts via Dockerfile instead.
DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_ROOT="$(cd "$DIR/../.." && pwd)"
cd "$DIR"

if [ -n "$RAILWAY_ENVIRONMENT" ] || [ "$CLOUD_MODE" = "true" ]; then
  echo "[launch] ERROR: This script is for local use only. Cloud uses edith-cloud.ts."
  exit 1
fi

# Source environment from repo root
if [ -f "$REPO_ROOT/.env" ]; then
  set -a
  source "$REPO_ROOT/.env"
  set +a
fi

# Ensure PATH includes common tool locations
export PATH="/usr/local/bin:/opt/homebrew/bin:$HOME/.bun/bin:$PATH"

STATE_DIR="$HOME/.edith"
mkdir -p "$STATE_DIR"

# =============================================================================
# LAYER 1: Atomic lock — prevent duplicate launches
# mkdir is atomic on POSIX; only one caller succeeds.
# =============================================================================
LOCK_DIR="$STATE_DIR/edith-launch.lock"

if ! mkdir "$LOCK_DIR" 2>/dev/null; then
  LOCK_PID=$(cat "$LOCK_DIR/pid" 2>/dev/null)
  if [ -n "$LOCK_PID" ] && kill -0 "$LOCK_PID" 2>/dev/null; then
    echo "[launch] Already running (PID $LOCK_PID) — exiting cleanly"
    exit 0  # exit 0 so launchd KeepAlive(SuccessfulExit:false) does NOT restart
  else
    echo "[launch] Stale lock found (PID $LOCK_PID not running) — removing"
    rm -rf "$LOCK_DIR"
    mkdir "$LOCK_DIR" 2>/dev/null || { echo "[launch] Lock race — exiting"; exit 0; }
  fi
fi
echo $$ > "$LOCK_DIR/pid"

# Clean up lock on ANY exit
release_lock() {
  rm -rf "$LOCK_DIR"
}
trap release_lock EXIT

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
# fswatch no longer needed — bun --watch handles auto-restart

# --- Start Docker services (Cognee) ---
if command -v docker >/dev/null 2>&1; then
  echo "[launch] Starting Docker services..."
  docker compose -f "$REPO_ROOT/docker-compose.yml" up -d 2>/dev/null
else
  echo "[launch] NOTE: Docker not available — Cognee disabled"
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

# --- Check for already-running Edith (PID file fallback) ---
PID_FILE="$STATE_DIR/edith.pid"
if [ -f "$PID_FILE" ]; then
  OLD_PID=$(cat "$PID_FILE")
  if kill -0 "$OLD_PID" 2>/dev/null; then
    echo "[launch] Edith is already running (PID $OLD_PID)"
    exit 0
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

# --- Pre-flight ---
mkdir -p "$STATE_DIR" "$REPO_ROOT/logs"

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

# --- Cleanup on exit ---
cleanup() {
  echo "[launch] Shutting down..."
  # Kill Edith process group
  if [ -f "$STATE_DIR/edith-launch.pid" ]; then
    kill "$(cat "$STATE_DIR/edith-launch.pid")" 2>/dev/null
    rm -f "$STATE_DIR/edith-launch.pid"
  fi
  kill $DASHBOARD_PID 2>/dev/null
  rm -f "$PID_FILE"
  exit 0
}
trap 'cleanup; release_lock' SIGINT SIGTERM

# --- Start Edith with bun --watch (auto-restarts on imported file changes) ---
echo "[launch] Starting Edith with --watch..."
LOG_FILE="$STATE_DIR/edith.log"
EDITH_PIDFILE="$STATE_DIR/edith-launch.pid"

EDITH_LOG_FILE="$LOG_FILE" bun --watch --no-clear-screen "$DIR/edith.ts" &
EDITH_PID=$!
echo "$EDITH_PID" > "$EDITH_PIDFILE"
echo "[launch] Edith started (PID $EDITH_PID) — bun --watch handles restarts"
echo "[launch] Logs: tail -f $LOG_FILE"

# Wait for the main Edith process. If it exits cleanly (0), we exit cleanly too
# (launchd won't restart on exit 0). If it crashes, we exit non-zero (launchd restarts).
while true; do
  if [ -f "$EDITH_PIDFILE" ]; then
    CURRENT_PID=$(cat "$EDITH_PIDFILE" 2>/dev/null)
    if [ -n "$CURRENT_PID" ] && ! kill -0 "$CURRENT_PID" 2>/dev/null; then
      wait "$CURRENT_PID" 2>/dev/null
      EXIT_CODE=$?
      if [ "$EXIT_CODE" -eq 0 ]; then
        echo "[launch] Edith stopped cleanly (exit 0) — staying stopped"
        cleanup
      else
        echo "[launch] Edith crashed (exit $EXIT_CODE) — letting launchd restart"
        break
      fi
    fi
  fi
  sleep 5
done
