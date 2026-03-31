# Cloud Platform Evaluation: Fly.io vs Railway

**Issues:** #43, #46, #49
**Status:** Analysis complete — recommendation: **Railway**
**Date:** 2026-03-30

---

## Context

Edith's cloud deployment needs:
- Bun daemon (`edith.ts`) — long-running, always-on, Telegram polling
- SQLite at `~/.edith/edith.db` — persistent across deploys
- WebSocket server — Tauri desktop app ↔ cloud bidirectional comms
- Cognee (Docker: LanceDB + Kuzu graph DB + ML embedding model)
- Langfuse (Docker: Postgres + Next.js)
- Single user now, potential multi-user later

---

## Comparison Matrix

| Factor | Fly.io | Railway |
|---|---|---|
| **Pricing model** | Pure pay-as-you-go (no base fee) | $5/mo Hobby (includes $5 credit) |
| **Estimated monthly cost** | ~$4–8/mo (shared-CPU 256MB–512MB) | ~$5–10/mo total |
| **Persistent volumes** | Yes — mature, well-documented, SQLite-on-volume is first-class | Yes — newer feature, partial SQLite support (readonly issues reported) |
| **Always-on process** | Yes via `min_machines_running=1`, but bugs reported (Feb 2026 autostop issue) | Yes — services run as persistent containers, no timeout ceiling |
| **WebSocket support** | Yes — native, no special config | Yes — supported, 60s keep-alive for idle connections |
| **Docker support** | Yes — Dockerfile-native, multi-app via separate `fly.toml` | Yes — Dockerfile supported; Docker Compose import is partial/beta |
| **Multi-service (Cognee + Langfuse)** | Yes — separate Fly apps, internal networking via Fly mesh | Yes — separate Railway services per project, internal networking via private DNS |
| **Deployment** | CLI (`fly deploy`) or GitHub Actions via `superfly/flyctl-actions` | Git push auto-deploy or CLI (`railway up`) |
| **Custom domain + SSL** | Yes — free SSL via Let's Encrypt | Yes — free SSL, custom domain on all plans |
| **Free tier** | No free tier (removed 2024); free trial = 2 VM hours or 7 days | No free tier; $5/mo Hobby is entry-level paid |
| **Scaling to multi-user** | Strong — horizontal scaling, multiple regions, load balancing built-in | Good — up to 42 replicas on Pro, vertical autoscaling |
| **DX / simplicity** | Steeper — `fly.toml` config, volumes need explicit mount config | Simpler — canvas UI, git push deploys, environment variables in UI |
| **SQLite maturity** | Documented first-class support (volume mount pattern well-established) | Known readonly errors reported; workarounds exist but less battle-tested |

---

## Detailed Findings

### Pricing (2026)

**Fly.io:** Pure pay-as-you-go since October 2024. No monthly subscription. Shared-CPU 1x 256MB ≈ $0.0027/hr ≈ ~$2/mo if always-on. With a persistent volume (1GB at $0.15/GB/mo) and bandwidth, realistic cost for Edith alone is ~$3–5/mo. Adding Cognee (heavier: ML model, needs 1GB+ RAM) pushes to ~$10–15/mo total across two apps. Machine reservations offer 40% discount with upfront commitment.

**Railway:** $5/mo Hobby plan includes $5 in resource credits. Compute is metered (CPU + RAM by the second). A lightweight Bun daemon (256MB RAM, minimal CPU) likely stays within the $5 credit. Cognee's heavier resource footprint would add $3–8/mo on top. Realistic total: ~$8–15/mo. Pro plan at $20/mo adds team features and higher limits.

### Persistent Storage / SQLite

**Fly.io** has the most mature SQLite-on-volume story. The pattern (mount a named volume at `/data`, point `EDITH_DB_PATH` there) is well-documented and widely used in production. Volumes survive deploys and restarts. Single-region constraint matches Edith's single-user use case perfectly.

**Railway** volumes are newer. There are active community reports of `SQLITE_READONLY` errors when mounting volumes — a significant risk for Edith's primary state store. This is addressable (workarounds exist) but adds friction during initial setup.

**Edge: Fly.io** for SQLite reliability.

### Always-On Process

Both support persistent processes (not serverless). Railway is simpler: services are always-on by default with no configuration needed. Fly.io requires explicit `min_machines_running = 1` plus `auto_stop_machines = false` — and a Feb 2026 community bug report confirms autostop can trigger even with `min_machines_running = 2`.

**Edge: Railway** for reliability and simplicity of always-on behavior.

### WebSocket Support

Both support WebSockets natively. Railway has a 60-second idle keep-alive timeout — acceptable for Tauri ↔ cloud where the desktop app will send periodic pings. Fly.io has no documented WS timeout issues.

**Edge: Tie** — both work fine for Edith's use case.

### Docker / Multi-Service (Cognee + Langfuse)

Both support running Cognee and Langfuse as separate services. Neither natively runs `docker-compose` as a single unit in production.

**Fly.io:** Deploy each as a separate app (`edith-cognee`, `edith-langfuse`). Internal networking via `.fly.dev` internal DNS. Well-established pattern.

**Railway:** Deploy each as a separate service within the same Railway project. Internal networking via Railway's private DNS (`cognee.railway.internal`). Docker Compose import is partial/beta — manual service creation is the production path. Canvas UI makes multi-service wiring visual and straightforward.

**Edge: Slight Railway advantage** for operational simplicity (one project dashboard, shared env vars, visual service graph).

### Deployment Simplicity

Railway wins here clearly. Git push → auto-deploy is the default. Environment variables are managed via the Railway dashboard (no CLI secrets commands needed). Railway's canvas UI gives a visual graph of all services with logs inline.

Fly.io requires CLI-first workflow: `fly secrets set` for each env var, `fly.toml` hand-editing for volume mounts, `fly deploy` to ship. The GitHub Actions path works but requires more initial setup.

**Edge: Railway.**

---

## Recommendation: Railway

**Switch the Phase 2 plan from Fly.io to Railway.** Reasons:

1. **Always-on is simpler and more reliable.** Railway services are persistent by default — no `min_machines_running` bugs to fight.
2. **Multi-service DX is better.** Cognee + Langfuse + Edith all in one Railway project canvas, shared private networking, one dashboard.
3. **Git push deploys.** Less friction than Fly's CLI-first workflow.
4. **Cost is comparable.** ~$8–15/mo for the full stack on both platforms.
5. **SQLite on Railway is workable** — readonly issues are known and fixable — but this is the one area where Fly.io is stronger. Mitigate by testing volume mount thoroughly before committing.

**When to reconsider Fly.io:**
- If Railway's SQLite volume readonly errors prove persistent and blocking
- If multi-region deployment becomes a requirement (Fly.io is significantly stronger here)
- If cost optimization becomes critical (Fly.io's pay-per-second model can be cheaper at very low usage)

---

## Revised Phase 2 Deployment Plan (Railway)

| Service | Railway Config |
|---|---|
| `edith` (Bun daemon) | Railway service, Dockerfile, volume at `/root/.edith` |
| `cognee` | Railway service, Dockerfile from `cognee-repo/`, volume at `/app/cognee_data` |
| `langfuse` | Railway service, Docker image `langfuse/langfuse`, Postgres add-on |

**Env vars:** Set in Railway dashboard per service. Internal URLs via `${{cognee.RAILWAY_PRIVATE_DOMAIN}}`.

**CI/CD:** Railway auto-deploys on push to `main`. No GitHub Actions workflow needed unless you want to gate on CI first (doable via Railway's deploy hooks or a simple `railway up` in GitHub Actions after tests pass).

---

## Impact on Open Issues

Issues #43 (Fly.io setup), #46 (Cognee on Fly.io), and #49 (CI/CD) are all currently written for Fly.io. See updated issue descriptions below — the core work is the same, just retargeted to Railway.

- **#43:** Create `railway.toml` / `Dockerfile` instead of `fly.toml`. Use Railway dashboard to set secrets. Configure volume mount at `/root/.edith` for SQLite.
- **#46:** Deploy Cognee as Railway service in same project. Set `COGNEE_URL` to Railway private domain. Volume at `/app/cognee_data` for LanceDB + Kuzu.
- **#49:** Railway auto-deploys on `main` push natively. Optional: add GitHub Actions step to run `railway up` gated on CI passing, for explicit control.

---

## Sources

- [Fly.io Pricing](https://fly.io/pricing/)
- [Fly.io Resource Pricing Docs](https://fly.io/docs/about/pricing/)
- [Fly.io SQLite Guide](https://fly.io/docs/rails/advanced-guides/sqlite3/)
- [Fly.io Autostop/Autostart Docs](https://fly.io/docs/launch/autostop-autostart/)
- [Railway Pricing Plans](https://docs.railway.com/pricing/plans)
- [Railway Pricing Page](https://railway.com/pricing)
- [Railway vs Fly.io (Railway Docs)](https://docs.railway.com/platform/compare-to-fly)
- [Railway Dockerfiles](https://docs.railway.com/builds/dockerfiles)
- [Railway WebSocket Help](https://station.railway.com/questions/websockets-1bda16bd)
- [Railway SQLite Readonly Issue](https://station.railway.com/questions/sqlite-readonly-attempt-to-write-a-read-2e6e370a)
- [Fly.io vs Railway 2026 - The Software Scout](https://thesoftwarescout.com/fly-io-vs-railway-2026-which-developer-platform-should-you-deploy-on/)
