---
name: run-poet-local
description: Use when launching, starting, running, restarting, or smoke-testing the POET app locally (FastAPI backend + Next.js frontend + Postgres), or when the dev servers report "up" but the app misbehaves, returns 404s, or hits a port conflict on 8000/3000/5433.
---

# Run POET locally

## Overview

POET is a three-tier stack: **Postgres** (Docker, `:5433`) → **FastAPI backend** (`:8000`) → **Next.js frontend** (`:3000`). `./run-local.sh` orchestrates all three. State lives in `./.run/` (logs + pidfiles). API keys live in `backend/.env`.

**Prerequisite:** Docker Desktop must be running (the user starts it). The script auto-detects `docker` vs `docker.exe` under WSL.

## Quick reference

| Command | What it does |
|---|---|
| `./run-local.sh start` | Bring up Postgres → venv → migrations + seed → backend → frontend (default) |
| `./run-local.sh stop` | Stop frontend, backend, and the Postgres container |
| `./run-local.sh status` | Show whether each piece is running (reads `.run/*.pid`) |
| `./run-local.sh logs` | Tail `.run/backend.log` and `.run/frontend.log` |
| `./run-local.sh clean` | Stop everything **and drop the Postgres volume (wipes data)** |

After start: Frontend http://localhost:3000 · Backend http://localhost:8000 · Postgres `localhost:5433` (user/pass/db: `poet`).

## Always verify — `run-local.sh` gives false positives

The script's readiness check only asks "is *something* listening on the port?" If another app already holds `:8000` or `:3000`, it prints **"Backend up" / "Frontend up" and the real server silently died.** Never trust the green output alone. Verify the processes are genuinely POET:

```bash
# Backend must be POET, not whatever else grabbed :8000. /health does NOT exist
# (run-local's banner is stale) — routes live under /api/v2; use the OpenAPI doc.
curl -s http://localhost:8000/openapi.json | python3 -c "import sys,json;d=json.load(sys.stdin);print(d['info']['title'],len(d['paths']),'routes')"
# Expect: POET API 53 routes   (a Werkzeug "404 Not Found" HTML page = a Flask app stole the port)

grep -i "address already in use" .run/backend.log   # any hit = bind failed, server is dead

# End-to-end through the DB:
curl -s http://localhost:8000/api/v2/projects   # expect JSON {"items":[...]}
```

If keys are blank in `backend/.env` (`ANTHROPIC_API_KEY` / `OPENAI_API_KEY`), the app launches fine but AI flows (claims, conflicts, process generation, chat) fail.

## Port conflict on :8000 or :3000 — run the backend on another port

When another project holds `:8000` (e.g. an unrelated `python3 app.py`), point POET's frontend at a free backend port instead of fighting over 8000:

```bash
# 1. Repoint the frontend (NEXT_PUBLIC_API_URL is read by src/lib/api.ts).
#    .env.local: NEXT_PUBLIC_API_URL=http://localhost:8001

# 2. Start the backend on the free port, mirroring run-local's env setup.
setsid bash -c '
  source backend/.venv/bin/activate
  cd backend; set -a; source .env; set +a
  exec uvicorn main:app --host 0.0.0.0 --port 8001 --reload
' > .run/backend.log 2>&1 < /dev/null &

# 3. Restart the frontend (see gotcha below — it MUST be a fresh process).
```

CORS is `allow_origins=["*"]`, so the backend port can change freely.

## Critical gotchas

- **`NEXT_PUBLIC_*` is baked in at dev-server start, not hot-reloaded.** Editing `.env.local` does nothing until you fully restart `next dev`. The value is inlined into the JS chunks as `(…, "http://localhost:8001") || "http://localhost:8000"` — the trailing `8000` is just the dead `||` fallback in `api.ts:62`, not a stale build.
- **Killing `npm` does NOT kill `next dev`.** `npm run dev` forks `next dev`, which forks `next-server`. Kill the npm pid and `next dev` re-parents to `/init` and keeps holding `:3000`, so your "restart" can't bind and dies. To truly restart the frontend, kill the pid actually bound to the port:
  ```bash
  kill $(ss -ltnp | grep ':3000' | grep -oP 'pid=\K[0-9]+')   # repeat until :3000 is free
  rm -rf .next/dev                                             # drop stale compiled chunks
  ```
- **Pidfiles go stale after manual restarts.** `setsid`-launched processes don't match the pid in `.run/*.pid`, so `status` lies. Re-sync it: `ss -ltnp | grep ':3000' | grep -oP 'pid=\K[0-9]+' > .run/frontend.pid`.
- **Postgres data** is the canonical `processengineering_poet-pgdata` volume. `./run-local.sh clean` (or `compose down -v`) wipes it — never run it casually.
- **Migrations:** start runs `alembic upgrade head` automatically. After adding a migration, a hot-reloading backend 500s until the dev DB is upgraded.

## Drive it, don't just launch it

Confirm the frontend actually renders against the live backend, not just that ports are open:

```bash
curl -sL http://localhost:3000/ -o /dev/null -w '%{http_code} %{url_effective}\n'  # 200 .../projects
```

A landing on `/projects` returning 200 plus the `/api/v2/projects` JSON above proves the full chain (frontend → backend → DB) works.
