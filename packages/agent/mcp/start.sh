#!/bin/bash
# Load env vars and start the MCP tool server
DIR="$(cd "$(dirname "$0")/.." && pwd)"
if [ -f "$DIR/.env" ]; then
  set -a
  source "$DIR/.env"
  set +a
fi
exec bun "$DIR/mcp/server.ts"
