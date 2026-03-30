#!/bin/bash
# cognee-wrapper.sh — Ensures only one cognee-mcp instance accesses Kuzu DB.
# Kills any stale cognee-mcp Python processes from prior edith.ts dispatches
# before starting a fresh instance.

PIDFILE="/tmp/cognee-mcp-edith.pid"
COGNEE_DIR="/Users/randywilson/Desktop/edith-v3/cognee-repo/cognee-mcp"

# Kill previous instance if PID file exists
if [ -f "$PIDFILE" ]; then
  OLD_PID=$(cat "$PIDFILE" 2>/dev/null)
  if [ -n "$OLD_PID" ] && kill -0 "$OLD_PID" 2>/dev/null; then
    echo "[cognee-wrapper] Killing stale cognee-mcp (PID $OLD_PID)" >&2
    kill "$OLD_PID" 2>/dev/null
    # Wait up to 5 seconds for graceful shutdown
    for i in $(seq 1 10); do
      kill -0 "$OLD_PID" 2>/dev/null || break
      sleep 0.5
    done
    # Force kill if still alive
    kill -0 "$OLD_PID" 2>/dev/null && kill -9 "$OLD_PID" 2>/dev/null
  fi
  rm -f "$PIDFILE"
fi

# Clean up PID file on exit
cleanup() {
  rm -f "$PIDFILE"
}
trap cleanup EXIT INT TERM

# Start cognee-mcp and record PID
cd "$COGNEE_DIR"
uv run cognee-mcp &
COGNEE_PID=$!
echo "$COGNEE_PID" > "$PIDFILE"

# Wait for the process (stdio MCP needs to stay in foreground)
wait "$COGNEE_PID"
