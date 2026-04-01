# ── Single-stage build ────────────────────────────────────────────────────────
# Use Debian-based Bun image (not Alpine) for Claude Code native binary compat
FROM oven/bun:1-debian

WORKDIR /app

# Install Node.js (required by Claude Code) and curl (for healthcheck)
RUN apt-get update && \
    apt-get install -y --no-install-recommends curl ca-certificates && \
    curl -fsSL https://deb.nodesource.com/setup_22.x | bash - && \
    apt-get install -y --no-install-recommends nodejs && \
    rm -rf /var/lib/apt/lists/*

# Install Claude Code globally
RUN npm install -g @anthropic-ai/claude-code@latest

# Copy workspace manifests
COPY package.json bun.lock ./
COPY packages/agent/package.json ./packages/agent/
COPY packages/desktop/package.json ./packages/desktop/

# Install all deps (workspace mode)
RUN bun install --ignore-scripts

# Copy agent source (desktop excluded via .dockerignore)
COPY packages/agent/ ./packages/agent/

# Persistent state directory (Railway volume mount or ephemeral)
RUN mkdir -p /data/.state
ENV EDITH_STATE_DIR=/data/.state

# Set working directory to agent package
WORKDIR /app/packages/agent

# Railway injects PORT
EXPOSE 8080

# Health check
HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
  CMD curl -sf http://localhost:${PORT:-8080}/health || exit 1

# Railway injects env vars directly — no .env file needed.
CMD ["bun", "edith.ts"]
