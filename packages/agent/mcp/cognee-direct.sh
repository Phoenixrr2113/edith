#!/bin/bash
# cognee-direct.sh — Query/save to Cognee directly, bypassing the MCP server.
# Usage:
#   cognee-direct.sh search "query text"
#   cognee-direct.sh save "text to store"
#
# Local: uses Python SDK via cognee-repo/
# Cloud: uses HTTP API via COGNEE_URL env var (requires auth)

ACTION="$1"
TEXT="$2"

if [ -z "$ACTION" ] || [ -z "$TEXT" ]; then
  echo "Usage: $0 search|save 'text'"
  exit 1
fi

# Cloud mode: use HTTP API when COGNEE_URL is set
if [ -n "$COGNEE_URL" ]; then
  COGNEE_EMAIL="${COGNEE_EMAIL:-edith@edith.dev}"
  COGNEE_PASSWORD="${COGNEE_PASSWORD:-edith-service-2026}"

  # Get auth token (register if needed, then login)
  TOKEN=$(curl -s -X POST "$COGNEE_URL/api/v1/auth/login" \
    -H "Content-Type: application/x-www-form-urlencoded" \
    -d "username=$COGNEE_EMAIL&password=$COGNEE_PASSWORD" 2>/dev/null \
    | python3 -c "import json,sys; print(json.load(sys.stdin).get('access_token',''))" 2>/dev/null)

  if [ -z "$TOKEN" ]; then
    # Try registering first, then login
    curl -s -X POST "$COGNEE_URL/api/v1/auth/register" \
      -H "Content-Type: application/json" \
      -d "{\"email\": \"$COGNEE_EMAIL\", \"password\": \"$COGNEE_PASSWORD\"}" >/dev/null 2>&1

    TOKEN=$(curl -s -X POST "$COGNEE_URL/api/v1/auth/login" \
      -H "Content-Type: application/x-www-form-urlencoded" \
      -d "username=$COGNEE_EMAIL&password=$COGNEE_PASSWORD" 2>/dev/null \
      | python3 -c "import json,sys; print(json.load(sys.stdin).get('access_token',''))" 2>/dev/null)
  fi

  if [ -z "$TOKEN" ]; then
    echo "Error: Failed to authenticate with Cognee at $COGNEE_URL"
    exit 1
  fi

  AUTH="Authorization: Bearer $TOKEN"

  case "$ACTION" in
    search)
      curl -s -X POST "$COGNEE_URL/api/v1/search" \
        -H "Content-Type: application/json" \
        -H "$AUTH" \
        -d "{\"query\": \"$TEXT\", \"query_type\": \"GRAPH_COMPLETION\"}" \
        2>/dev/null
      ;;
    save)
      # Create a temp file with the text content, upload via /add, then cognify
      DATASET="edith-memory"
      TMPFILE=$(mktemp /tmp/cognee-add-XXXXXX.txt)
      echo "$TEXT" > "$TMPFILE"

      curl -s -X POST "$COGNEE_URL/api/v1/add" \
        -H "$AUTH" \
        -F "data=@$TMPFILE" \
        -F "datasetName=$DATASET" \
        2>/dev/null

      rm -f "$TMPFILE"

      curl -s -X POST "$COGNEE_URL/api/v1/cognify" \
        -H "Content-Type: application/json" \
        -H "$AUTH" \
        -d "{\"datasets\": [\"$DATASET\"]}" \
        2>/dev/null

      echo "Saved."
      ;;
    *)
      echo "Usage: $0 search|save 'text'"
      exit 1
      ;;
  esac
  exit 0
fi

# Local mode: use Python SDK
COGNEE_DIR="${COGNEE_DIR:-$(dirname "$0")/../../cognee-repo/cognee-mcp}"

case "$ACTION" in
  search)
    cd "$COGNEE_DIR" && uv run python -c "
import asyncio, cognee, sys
from cognee.modules.search.types.SearchType import SearchType

async def main():
    results = await cognee.search('''$TEXT''', query_type=SearchType.GRAPH_COMPLETION)
    if results:
        for r in results:
            print(r)
    else:
        print('No results found.')

asyncio.run(main())
" 2>/dev/null
    ;;
  save)
    cd "$COGNEE_DIR" && uv run python -c "
import asyncio, cognee

async def main():
    await cognee.add(['''$TEXT'''])
    await cognee.cognify()
    print('Saved.')

asyncio.run(main())
" 2>/dev/null
    ;;
  *)
    echo "Usage: $0 search|save 'text'"
    exit 1
    ;;
esac
