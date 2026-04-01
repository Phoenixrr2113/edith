#!/bin/bash
# cognee-direct.sh — Query/save to Cognee directly, bypassing the MCP server.
# Usage:
#   cognee-direct.sh search "query text"
#   cognee-direct.sh save "text to store"
#
# Local: uses Python SDK via cognee-repo/
# Cloud: uses HTTP API via COGNEE_URL env var

ACTION="$1"
TEXT="$2"

if [ -z "$ACTION" ] || [ -z "$TEXT" ]; then
  echo "Usage: $0 search|save 'text'"
  exit 1
fi

# Cloud mode: use HTTP API when COGNEE_URL is set
if [ -n "$COGNEE_URL" ]; then
  case "$ACTION" in
    search)
      curl -s -X POST "$COGNEE_URL/v1/search" \
        -H "Content-Type: application/json" \
        -d "{\"query\": \"$TEXT\", \"query_type\": \"GRAPH_COMPLETION\"}" \
        2>/dev/null
      ;;
    save)
      curl -s -X POST "$COGNEE_URL/v1/cognify" \
        -H "Content-Type: application/json" \
        -d "{\"text\": \"$TEXT\"}" \
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
