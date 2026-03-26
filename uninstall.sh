#!/bin/bash
# Uninstall Edith LaunchAgent
set -e

PLIST_DST="$HOME/Library/LaunchAgents/com.edith.agent.plist"

if launchctl print "gui/$(id -u)/com.edith.agent" &>/dev/null; then
  launchctl bootout "gui/$(id -u)/com.edith.agent"
  echo "Edith LaunchAgent stopped."
else
  echo "Edith LaunchAgent not loaded."
fi

if [ -f "$PLIST_DST" ]; then
  rm "$PLIST_DST"
  echo "Removed $PLIST_DST"
fi

echo "✅ Edith uninstalled. Manual launch: ./launch-edith.sh"
