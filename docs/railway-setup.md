# Railway Cloud Deployment Guide

## Overview

Edith runs two services on Railway:
1. **edith** — Bun daemon (Telegram polling, scheduler, Agent SDK dispatch)
2. **cognee** — Python FastAPI (knowledge graph, vector search)

Both services live in the same Railway project and communicate via private DNS.

## Prerequisites

- Railway project: https://railway.com/project/eacd6b9d-d005-468a-8c4c-3140463db77f
- Neon Postgres database (for structured state)
- GitHub repo connected to Railway for auto-deploy

## Service 1: Edith Backend

### Deploy source
- **Source:** GitHub repo, auto-deploy on push to main
- **Dockerfile:** `Dockerfile` (root of repo)
- **Build command:** handled by Dockerfile (bun install)
- **Start command:** handled by Dockerfile CMD (`bun run edith.ts`)

### Environment variables (set in Railway dashboard)

Copy from your local `.env` — these are required:

```
# Telegram
TELEGRAM_BOT_TOKEN=<your bot token>
TELEGRAM_CHAT_ID=<your chat id>
TELEGRAM_USER_ID=<your user id>

# Database (Neon Postgres — replaces local SQLite)
DATABASE_URL=postgres://<user>:<pass>@<host>.neon.tech/<db>?sslmode=require

# Google OAuth
GOOGLE_CLIENT_ID=<...>
GOOGLE_CLIENT_SECRET=<...>
GOOGLE_REFRESH_TOKEN=<...>

# Cognee (points to the Cognee service via Railway private DNS)
COGNEE_URL=http://${{cognee.RAILWAY_PRIVATE_DOMAIN}}:8001

# Cloud mode (auto-set by Railway, but explicit doesn't hurt)
CLOUD_MODE=true

# Enable Telegram polling in cloud (disabled by default — enable for cloud-only mode)
CLOUD_TELEGRAM_POLLING=true

# BetterStack (optional but recommended)
BETTERSTACK_SOURCE_TOKEN=<...>

# OpenRouter (for LLM calls via Agent SDK)
OPENROUTER_API_KEY=<...>

# Groq (for voice transcription)
GROQ_API_KEY=<...>
```

### Health check
- **Path:** `/health`
- **Timeout:** 60s
- **Restart policy:** ON_FAILURE, max 5 retries

### Volume (optional)
If not using Neon Postgres (i.e., SQLite in cloud):
- Mount at `/data`
- `EDITH_STATE_DIR=/data/.state` (already set in Dockerfile)

With Neon Postgres, no volume is needed — all structured state goes to Postgres.
Events.jsonl, taskboard, and transcripts are ephemeral in cloud mode (acceptable for now).

## Service 2: Cognee

### Deploy source
- **Source:** `cognee-repo/` directory or Cognee's Docker image
- **Dockerfile:** `cognee-repo/Dockerfile` (or use `topoteretes/cognee:latest`)
- **Port:** 8001

### Environment variables

```
# LLM for embeddings and processing
LLM_API_KEY=<OpenAI or compatible API key>
LLM_MODEL=gpt-4o-mini

# Database
DB_PROVIDER=postgres
DB_HOST=${{Postgres.PGHOST}}
DB_PORT=${{Postgres.PGPORT}}
DB_NAME=${{Postgres.PGDATABASE}}
DB_USER=${{Postgres.PGUSER}}
DB_PASSWORD=${{Postgres.PGPASSWORD}}

# Vector store
VECTOR_DB_PROVIDER=pgvector
VECTOR_DB_URL=${{Postgres.DATABASE_URL}}
```

### Volume
- Mount at `/app/cognee_data` — persists LanceDB/Kuzu data across deploys
- Required if using file-based vector store (LanceDB)
- Not needed if using pgvector (Postgres handles it)

### Health check
- **Path:** `/health`

## Service 3: Postgres (via Neon)

Use Neon's serverless Postgres instead of Railway's Postgres plugin:
- Create a database at https://neon.tech
- Copy the connection string to `DATABASE_URL` in the Edith service env vars
- The `EdithDB` abstraction in `lib/db.ts` auto-detects `DATABASE_URL` and switches from SQLite to Postgres

## CI/CD

### Option A: Railway auto-deploy (simplest)
Railway auto-deploys on push to main. No GitHub Actions needed.
**Downside:** deploys even if CI fails.

### Option B: CI-gated deploy (recommended)
1. Disable auto-deploy in Railway dashboard for the edith service
2. Add `RAILWAY_TOKEN` to GitHub repo secrets (generate in Railway dashboard → Account → Tokens)
3. `.github/workflows/deploy.yml` runs lint + typecheck + tests, then `railway deploy` only on success

### Getting RAILWAY_TOKEN
1. Go to Railway dashboard → Account Settings → Tokens
2. Create a new token with deploy permissions
3. Add to GitHub: repo Settings → Secrets → Actions → `RAILWAY_TOKEN`

## Verifying deployment

```bash
# Health check
curl https://<your-app>.up.railway.app/health

# Check logs
npx @railway/cli logs --service edith

# Or in Railway dashboard → Service → Logs
```

## Architecture

```
┌─────────────────────────────────────────────┐
│              Railway Project                 │
│                                              │
│  ┌──────────┐    private DNS    ┌──────────┐ │
│  │  edith   │ ◄──────────────► │  cognee  │ │
│  │ (Bun)    │                   │ (Python) │ │
│  └────┬─────┘                   └──────────┘ │
│       │                                      │
└───────┼──────────────────────────────────────┘
        │
   ┌────▼─────┐     ┌──────────────┐
   │   Neon   │     │  BetterStack │
   │ Postgres │     │   (logs)     │
   └──────────┘     └──────────────┘
```
