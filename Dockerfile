# ── Stage 1: dependencies ────────────────────────────────────────────────────
FROM oven/bun:1 AS deps

WORKDIR /app

# Copy all workspace manifests for layer caching
COPY package.json bun.lock ./
COPY packages/agent/package.json ./packages/agent/
# desktop package.json needed for workspace integrity (source excluded via .dockerignore)
COPY packages/desktop/package.json ./packages/desktop/

RUN bun install --production --ignore-scripts

# ── Stage 2: runtime ─────────────────────────────────────────────────────────
FROM oven/bun:1 AS runtime

WORKDIR /app

# Copy installed dependencies from deps stage (monorepo — all deps in root node_modules)
COPY --from=deps /app/node_modules ./node_modules

# Copy agent source only (desktop/ excluded via .dockerignore)
COPY packages/agent/ ./packages/agent/
COPY package.json bun.lock ./

# Persistent data volume mount point
RUN mkdir -p /data

# Set working directory to agent package
WORKDIR /app/packages/agent

# Railway injects PORT; expose it for documentation
EXPOSE 8080

# Health check via the HTTP endpoint started in cloud mode
HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
  CMD wget -qO- http://localhost:${PORT:-8080}/health || exit 1

# Cloud entrypoint — RAILWAY_ENVIRONMENT is set automatically by Railway
CMD ["bun", "run", "edith-cloud.ts"]
