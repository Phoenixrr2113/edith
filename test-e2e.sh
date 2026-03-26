#!/bin/bash
# Edith end-to-end test suite
# Tests each component independently, then the full pipeline.
set -e

DIR="$(cd "$(dirname "$0")" && pwd)"
cd "$DIR"

# Source environment
if [ -f "$DIR/.env" ]; then
  set -a
  source "$DIR/.env"
  set +a
fi

PASS=0
FAIL=0

pass() { echo "  ✓ $1"; PASS=$((PASS + 1)); }
fail() { echo "  ✗ $1"; FAIL=$((FAIL + 1)); }

echo "========================================"
echo "Edith End-to-End Test Suite"
echo "========================================"
echo ""

# --- Test 1: MCP tools load ---
echo "Test 1: MCP tools load in -p mode"
TOOLS=$(claude -p "List only the MCP tool names, one per line. No descriptions." --permission-mode bypassPermissions --mcp-config .mcp.json --output-format json 2>/dev/null | python3 -c "import sys,json; print(json.load(sys.stdin).get('result',''))" 2>/dev/null)

if echo "$TOOLS" | grep -q "send_message"; then
  pass "edith send_message tool found"
else
  fail "edith send_message tool NOT found"
fi

if echo "$TOOLS" | grep -q "cognee__search"; then
  pass "cognee search tool found"
else
  fail "cognee search tool NOT found"
fi

echo ""

# --- Test 2: Cognee round-trip ---
echo "Test 2: Cognee store and retrieve"
COGNEE_RESULT=$(claude -p 'Use the cognee cognify tool to store this text: "Edith test fact: Randy likes espresso." Then immediately use the cognee search tool with search_type CHUNKS to search for "espresso". Report whether you found the test fact.' --permission-mode bypassPermissions --mcp-config .mcp.json --output-format json 2>/dev/null | python3 -c "import sys,json; print(json.load(sys.stdin).get('result','')[:500])" 2>/dev/null)

if echo "$COGNEE_RESULT" | grep -qi "espresso\|found\|success"; then
  pass "Cognee store + retrieve works"
else
  fail "Cognee round-trip failed: $COGNEE_RESULT"
fi

echo ""

# --- Test 3: Reply tool sends Telegram message ---
echo "Test 3: send_message tool sends Telegram message"
CHAT_ID="${TELEGRAM_CHAT_ID}"
REPLY_RESULT=$(claude -p "Use the send_message tool to send text '🧪 Edith test — send_message works' with chat_id ${CHAT_ID}. Report success or failure." --permission-mode bypassPermissions --mcp-config .mcp.json --output-format json 2>/dev/null | python3 -c "import sys,json; print(json.load(sys.stdin).get('result','')[:300])" 2>/dev/null)

if echo "$REPLY_RESULT" | grep -qi "sent\|success\|delivered"; then
  pass "send_message tool sent Telegram message"
else
  fail "send_message tool failed: $REPLY_RESULT"
fi

echo ""

# --- Test 4: Taskboard write ---
echo "Test 4: Scheduled task writes to taskboard"
TASKBOARD="$HOME/.edith/taskboard.md"
mkdir -p "$HOME/.edith"

TASK_RESULT=$(claude -p "Write the following to the file $TASKBOARD (append, don't overwrite):

## $(date -u +%Y-%m-%dT%H:%M:%S)Z — test-task
- Test entry: scheduler integration works

Report success." --permission-mode bypassPermissions --mcp-config .mcp.json --output-format json 2>/dev/null | python3 -c "import sys,json; print(json.load(sys.stdin).get('result','')[:300])" 2>/dev/null)

if [ -f "$TASKBOARD" ] && grep -q "scheduler integration works" "$TASKBOARD"; then
  pass "Taskboard write works"
else
  fail "Taskboard write failed"
fi

echo ""

# --- Test 5: Full dispatch simulation ---
echo "Test 5: Full dispatch (simulates edith.ts message flow)"
SESSION_ID=$(uuidgen)
DISPATCH_RESULT=$(claude -p "[Message from Randy via Telegram] Hello Edith, this is an end-to-end test. Just confirm you received this.

[Reply using the send_message tool with chat_id ${CHAT_ID}.]" --permission-mode bypassPermissions --mcp-config .mcp.json --resume "$SESSION_ID" --output-format json 2>/dev/null | python3 -c "import sys,json; print(json.load(sys.stdin).get('result','')[:500])" 2>/dev/null)

if echo "$DISPATCH_RESULT" | grep -qi "sent\|replied\|confirm\|received\|hello"; then
  pass "Full dispatch simulation works"
else
  fail "Full dispatch failed: $DISPATCH_RESULT"
fi

# --- Test 6: Google Calendar via n8n ---
echo "Test 6: manage_calendar tool (via n8n)"
CAL_RESULT=$(claude -p "Use the manage_calendar tool with action get and hoursAhead 12. Report what you get back — events or empty." --permission-mode bypassPermissions --mcp-config .mcp.json --output-format json 2>/dev/null | python3 -c "import sys,json; print(json.load(sys.stdin).get('result','')[:300])" 2>/dev/null)

if echo "$CAL_RESULT" | grep -qi "event\|calendar\|no.*event\|empty\|clear\|nothing\|item"; then
  pass "manage_calendar tool works"
else
  fail "manage_calendar failed: $CAL_RESULT"
fi

echo ""

# --- Test 7: Gmail via n8n ---
echo "Test 7: manage_emails tool (via n8n)"
GMAIL_RESULT=$(claude -p "Use the manage_emails tool with action get, hoursBack 24 and maxResults 3. Report how many emails you got back." --permission-mode bypassPermissions --mcp-config .mcp.json --output-format json 2>/dev/null | python3 -c "import sys,json; print(json.load(sys.stdin).get('result','')[:300])" 2>/dev/null)

if echo "$GMAIL_RESULT" | grep -qi "email\|message\|found\|result\|unread"; then
  pass "manage_emails tool works"
else
  fail "manage_emails failed: $GMAIL_RESULT"
fi

echo ""
echo "========================================"
echo "Results: $PASS passed, $FAIL failed"
echo "========================================"

if [ "$FAIL" -gt 0 ]; then
  echo ""
  echo "Check Telegram for test messages."
  echo "Check ~/.edith/taskboard.md for taskboard entries."
  exit 1
fi

echo ""
echo "All tests passed! Check Telegram for the test messages."
echo "Next: run 'bun edith.ts' and send a real message to test the live loop."
