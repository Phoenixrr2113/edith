#!/bin/bash
set -e

echo "Edith Setup"
echo "=========="
echo ""

# --- Check prerequisites ---
check_cmd() {
  if ! command -v "$1" &>/dev/null; then
    echo "  x $1 is required but not installed."
    echo "    Install: $2"
    exit 1
  fi
  echo "  ok $1 found"
}

check_cmd "claude" "npm install -g @anthropic-ai/claude-code"
check_cmd "bun" "curl -fsSL https://bun.sh/install | bash"
check_cmd "docker" "https://docs.docker.com/get-docker/"

echo ""

# --- Collect config ---
if [ -z "$TELEGRAM_BOT_TOKEN" ]; then
  echo "Create a Telegram bot:"
  echo "  1. Open https://t.me/BotFather"
  echo "  2. Send /newbot"
  echo "  3. Copy the token"
  echo ""
  read -p "Telegram Bot Token: " TELEGRAM_BOT_TOKEN
fi

if [ -z "$TELEGRAM_CHAT_ID" ]; then
  read -p "Telegram Chat ID: " TELEGRAM_CHAT_ID
fi

if [ -z "$OPENROUTER_API_KEY" ]; then
  read -p "OpenRouter API Key: " OPENROUTER_API_KEY
fi

# --- Optional keys ---
echo ""
echo "Optional integrations (press Enter to skip):"
read -p "  Google AI API Key (for image generation): " GOOGLE_GENERATIVE_AI_API_KEY
read -p "  Groq API Key (for voice transcription): " GROQ_API_KEY
read -p "  Telegram SMS Bot ID (for SMS relay): " TELEGRAM_SMS_BOT_ID
read -p "  Telegram User ID (your personal user ID): " TELEGRAM_USER_ID

# --- Write .env ---
cat > .env <<EOF
TELEGRAM_BOT_TOKEN=$TELEGRAM_BOT_TOKEN
TELEGRAM_CHAT_ID=$TELEGRAM_CHAT_ID
OPENROUTER_API_KEY=$OPENROUTER_API_KEY
COGNEE_URL=http://localhost:8001
N8N_URL=http://localhost:5679
GOOGLE_GENERATIVE_AI_API_KEY=$GOOGLE_GENERATIVE_AI_API_KEY
GROQ_API_KEY=$GROQ_API_KEY
TELEGRAM_SMS_BOT_ID=$TELEGRAM_SMS_BOT_ID
TELEGRAM_USER_ID=$TELEGRAM_USER_ID
EOF
echo "  ok .env written"

# --- Start Docker services ---
echo ""
echo "Starting Docker services (Cognee + n8n)..."
docker compose up -d
echo "  ok Cognee at http://localhost:8001, n8n at http://localhost:5679"

# --- Install MCP server deps ---
echo ""
echo "Installing MCP server dependencies..."
cd channel && bun install && cd ..
echo "  ok MCP server ready"

# --- Create directories ---
mkdir -p logs ~/.edith

# --- Install launchd plist ---
echo ""
PLIST_SRC="$(pwd)/com.edith.claude.plist"
PLIST_DEST="$HOME/Library/LaunchAgents/com.edith.claude.plist"

sed -i '' "s|/Users/randywilson/Desktop/edith-v3|$(pwd)|g" com.edith.claude.plist

read -p "Install launchd service (auto-start on boot)? [y/N] " INSTALL_LAUNCHD
if [[ "$INSTALL_LAUNCHD" =~ ^[Yy]$ ]]; then
  cp "$PLIST_SRC" "$PLIST_DEST"
  launchctl load "$PLIST_DEST"
  echo "  ok launchd service installed"
else
  echo "  Skipped. Run manually: ./launch-edith.sh"
fi

echo ""
echo "Edith is ready!"
echo ""
echo "  Run:        ./launch-edith.sh"
echo "  Dashboard:  http://localhost:3456"
echo "  n8n:        http://localhost:5679"
echo "  Test:       bash test-e2e.sh"
echo "  Logs:       tail -f logs/edith.log"
