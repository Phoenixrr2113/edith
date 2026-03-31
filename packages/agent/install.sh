#!/bin/bash
# Install Edith as a macOS LaunchAgent (auto-starts on login)
set -e

DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_ROOT="$(cd "$DIR/../.." && pwd)"
PLIST_SRC="$DIR/com.edith.agent.plist"
PLIST_DST="$HOME/Library/LaunchAgents/com.edith.agent.plist"
STATE_DIR="$HOME/.edith"

if [ ! -f "$PLIST_SRC" ]; then
  echo "Error: plist source not found at $PLIST_SRC" >&2
  exit 1
fi

mkdir -p "$STATE_DIR"

# Check if already loaded
if launchctl print "gui/$(id -u)/com.edith.agent" &>/dev/null; then
  echo "Edith is already installed. Uninstall first: ./uninstall.sh"
  exit 1
fi

# Install plist with path substitution for portability
sed -e "s|/Users/randywilson/Desktop/edith-v3|$REPO_ROOT|g" \
    -e "s|/Users/randywilson|$HOME|g" \
    "$PLIST_SRC" > "$PLIST_DST"
echo "Installed plist to $PLIST_DST"

# Bootstrap (load) the agent
launchctl bootstrap "gui/$(id -u)" "$PLIST_DST"
echo "Edith LaunchAgent loaded."

# Verify
sleep 2
if launchctl print "gui/$(id -u)/com.edith.agent" &>/dev/null; then
  echo "✅ Edith is running. Dashboard: http://localhost:${DASHBOARD_PORT:-3456}"
  echo "   Logs: tail -f $STATE_DIR/launchd-stdout.log"
  echo "   Stop: ./uninstall.sh"
else
  echo "❌ Failed to start. Check: tail -f $STATE_DIR/launchd-stderr.log"
  exit 1
fi
