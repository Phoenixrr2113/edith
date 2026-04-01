# ── Single-stage build (simpler, avoids workspace symlink issues) ──────────────
FROM oven/bun:1

WORKDIR /app

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
  CMD wget -qO- http://localhost:${PORT:-8080}/health || exit 1

# Run edith.ts directly (not via package.json "start" script which uses --env-file for local dev).
# Railway injects env vars directly — no .env file needed.
CMD ["bun", "edith.ts"]
