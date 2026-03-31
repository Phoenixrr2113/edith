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

# Persistent data directory
RUN mkdir -p /data

# Set working directory to agent package
WORKDIR /app/packages/agent

# Railway injects PORT
EXPOSE 8080

# Health check
HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
  CMD wget -qO- http://localhost:${PORT:-8080}/health || exit 1

CMD ["bun", "run", "edith-cloud.ts"]
