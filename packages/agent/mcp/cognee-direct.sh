#!/bin/bash
# cognee-direct.sh — Query/save to Cognee directly, bypassing the MCP server.
# Usage:
#   cognee-direct.sh search "query text"
#   cognee-direct.sh save "text to store"

COGNEE_DIR="/Users/randywilson/Desktop/edith-v3/cognee-repo/cognee-mcp"
ACTION="$1"
TEXT="$2"

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
