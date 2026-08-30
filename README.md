# TON Escrow Bot

A peer-to-peer escrow service for Telegram: a grammY bot plus a Telegram Mini
App that lets two parties trade TON or USDT (jettons) safely. Funds are held by
an on-chain `Escrow` contract (Tact) when deployed, while the backend keeps a
full off-chain deal ledger so the product is fully usable before any wallet or
contract exists.

## Architecture — micro-architecture (6 services + Postgres)

```
 Telegram users (chat + Mini App:8080)          Bot API
        │  HTTPS (WEBAPP_URL)                    │
        ▼                                        ▼
┌──────────────────┐      ┌──────────────────────────┐
│  frontend        │      │  backend :3000 (API-only)│
│  webapp nginx    │─────►│  grammY bot + REST API   │
│  :8080 -> :80    │ /api │  /api/*, /docs, /api/info│
│  proxies /api    │      └──────────────────────────┘
└──────────────────┘                 │
                     ┌───────────────┼──────────────────┐
                     ▼               ▼                  ▼
               ┌──────────┐    ┌──────────────┐   ┌──────────────────┐
               │ Postgres │    │ signer (W5)  │   │ Escrow.tact      │
               │  :5432   │    │ V5R1 wallet  │◄─►│ (on TON: deposit,│
               │ (deals,  │    │ microservice │   │  release/refund) │
               │ msgs,    │    │ :3001        │   └──────────────────┘
               │ trades)  │    └──────────────┘
               └──────────┘          │
                     ┌───────────────┼──────────────────┐
                     ▼               ▼                  ▼
               ┌──────────┐    ┌──────────────┐   ┌──────────────────┐
               │  ubot    │    │  utradebot   │   │  (frontend docs) │
               │ :3002    │    │  :3003       │   │  /docs + openapi │
               │ channel/ │    │  account     │   └──────────────────┘
               │ takeover │    │  sale escrow │
               └──────────┘    └──────────────┘
  escrow-net (bridge) isolates all; published: frontend :8080, backend :3000 (API)
```

- **frontend/** (`webapp/`) — **separate** nginx microservice (`nginx:alpine`, `:8080→:80`), serves static Mini App, **proxies `/api/*` → `http://backend:3000`** (micro-architecture, not same port). Telegram Web App requires `WEBAPP_URL`/`FRONTEND_URL` HTTPS in prod.
- **backend/** — **API-only** (`SERVE_STATIC=false`) grammY bot + Express REST (`:3000`), TON listener/deployer via `signer`, docs at `/api/docs`, `/docs`, `/api/openapi.json`, health `/api/info`, CORS allows `FRONTEND_URL` + `localhost:8080`.
- **signer/** — isolated W5 (V5R1) Wallet (`SIGNER_MNEMONIC` 24 words in `signer/.env`), internal `http://signer:3001`, `x-api-key`.
- **ubot/** — Telegram userbot (`teleproto@1.229.0`, QR login) for channel/group takeover (`channels.editCreator`, `channels.editAdmin`, `messages.migrateChat`), `API_ID`/`API_HASH`/`TWO_FA_PASSWORD` in `ubot/.env`, `:3002`.
- **utradebot/** — account sale escrow (`teleproto`), holds `StringSession`/`phone+code` trades, revokes seller, buyer code handoff, `auth.LogOut`, `:3003`.
- **contracts/** — `Escrow.tact`, wrappers, sandbox tests.

## Quickstart

### A. Local (npm) — micro-architecture dev (frontend separate)

1. Run a local PostgreSQL and create the database:
   ```sql
   CREATE USER escrow WITH PASSWORD 'escrow_password';
   CREATE DATABASE escrow OWNER escrow;
   ```
2. Configure and run backend (API-only, `:3000`):
   ```bash
   cd backend
   cp .env.example .env    # edit BOT_TOKEN, ADMIN_TELEGRAM_IDS, SIGNER_URL, FRONTEND_URL=http://localhost:8080, SERVE_STATIC=false (or true for single-port dev)
   npm install
   npm run build
   npm start               # API + bot on http://localhost:3000 (docs at /api/docs, /docs)
   # or: npm run dev       # ts-node
   ```
3. In another terminal, run frontend (`:8080`, proxies /api → backend):
   ```bash
   cd webapp
   npm install
   npm start               # http-server public on http://localhost:8080 (or use nginx)
   # Open Mini App at http://localhost:8080 and talk to bot (API via proxy or direct http://localhost:3000)
   ```
   For single-port dev without docker, set `SERVE_STATIC=true` and `FRONTEND_URL=http://localhost:3000` in `backend/.env`, then `http://localhost:3000` serves both.

### B. Docker Compose — micro-architecture (robust, production-ready)

```bash
# 1) Configure every service (edit each .env, chmod 600)
cp backend/.env.example backend/.env       # BOT_TOKEN, ADMIN_TELEGRAM_IDS, SIGNER_URL, FRONTEND_URL=http://localhost:8080, WEBAPP_URL, API_KEY
cp signer/.env.example signer/.env         # SIGNER_MNEMONIC (24 words), SIGNER_API_KEY, TON_NETWORK, TONCENTER_API_KEY
cp ubot/.env.example ubot/.env             # API_ID, API_HASH, TWO_FA_PASSWORD, UBOT_SESSION_STRING, ENCRYPTION_KEY, UBOT_API_KEY
cp utradebot/.env.example utradebot/.env   # UTRADE_BOT_TOKEN, API_ID, API_HASH, ENCRYPTION_KEY

# 2) Optional: set host POSTGRES_PASSWORD (defaults to escrow_password)
#    echo "POSTGRES_PASSWORD=strong_random_password" > .env

# 3) Build & run (6 services, detached, healthchecks, resource limits)
docker compose up --build -d
docker compose ps          # all 6 healthy: postgres, signer, backend, frontend, ubot, utradebot
docker compose logs -f backend   # or signer / frontend / ubot / utradebot

# Frontend (Mini App) — separate microservice, Nginx proxies /api → backend
curl http://localhost:8080/              # 200 HTML (Mini App)
curl http://localhost:8080/api/info      # 200 via proxy (same as backend)

# Backend API-only
curl http://localhost:3000/api/info      # health
curl http://localhost:3000/api/docs      # JSON docs
curl http://localhost:3000/docs          # HTML docs (also via http://localhost:8080/docs)

# Internal (expose only, uncomment ports in compose to reach from host)
# curl http://localhost:3001/health  # signer
# curl http://localhost:3002/health  # ubot
# curl http://localhost:3003/health  # utradebot
```

What the compose provides:

- **Services (6):** `postgres:5432`, `signer:3001` (W5), `backend:3000` **API-only** (`SERVE_STATIC=false`), **`frontend:80 → host 8080` (nginx, serves Mini App, proxies `/api` → `backend:3000`)**, `ubot:3002`, `utradebot:3003` on `escrow-net`.
- **Micro-architecture:** each service independently buildable/scalable, isolated code/Dockerfile, separate ports (frontend `8080`, backend `3000`, signer `3001` internal, ubot `3002`, utradebot `3003`), healthchecks, `depends_on: service_healthy` (frontend waits for backend, backend for postgres+signer).
- **Security:** each runs as non-root, `.env` never baked (`env_file` at runtime), `ENCRYPTION_KEY` + `x-api-key` between services, logs redacted, `CORS` allows `FRONTEND_URL`/`WEBAPP_URL`/`localhost:8080`.
- **Persistence:** volumes `pgdata`, `ubot_sessions`, `utrade_sessions` (600 perms).
- **Ops:** `restart: unless-stopped`, `deploy.resources.limits`, `logging: json-file` (`10m`/`3`), `HEALTHCHECK` per Dockerfile.
- For TLS: put **frontend** + **backend** behind Caddy/nginx with `WEBAPP_URL=https://your-domain` + `FRONTEND_URL` same — Telegram requires HTTPS.

## Environment

All variables are documented per-service:

- [`backend/.env.example`](backend/.env.example) — `BOT_TOKEN`, `ADMIN_TELEGRAM_IDS`, `DATABASE_URL`, `SIGNER_URL`, `SIGNER_API_KEY`, `API_KEY`, `WEBAPP_URL`, TON settings.
- [`signer/.env.example`](signer/.env.example) — `SIGNER_MNEMONIC` (24 words, **never in backend**), `SIGNER_API_KEY`, `TON_NETWORK`, `TONCENTER_API_KEY`.
- [`ubot/.env.example`](ubot/.env.example) — `API_ID`, `API_HASH`, `UBOT_SESSION_STRING`, `TWO_FA_PASSWORD`, `ENCRYPTION_KEY`, `UBOT_API_KEY`.
- [`utradebot/.env.example`](utradebot/.env.example) — `UTRADE_BOT_TOKEN`, `API_ID`, `API_HASH`, `ENCRYPTION_KEY`, `DATABASE_URL`.

Minimum for off-chain: `BOT_TOKEN`, `ADMIN_TELEGRAM_IDS`, `DATABASE_URL` (backend) + `SIGNER_MNEMONIC` in `signer` if you need on-chain. For production add `API_KEY`/`SIGNER_API_KEY`/`UBOT_API_KEY`/`UTRADE_API_KEY` (32+ chars each), `WEBAPP_URL`, `POSTGRES_PASSWORD`, and `ENCRYPTION_KEY` (64 hex).

## Webapp / Mini App hosting — micro-architecture

- **Frontend microservice** `webapp/` (`nginx:alpine`, `Dockerfile`, `nginx.conf`) serves `public/` on `:80` → host `:8080`, proxies `/api/*`, `/tonconnect-manifest.json`, `/docs` → `http://backend:3000`. Backend is **API-only** (`SERVE_STATIC=false`).
- Telegram **requires a public HTTPS URL** for Mini Apps. In prod, put **frontend** behind TLS (Caddy/nginx/LB) and set `WEBAPP_URL=https://your-domain` + `FRONTEND_URL` same — the bot menu button ("Open App") only appears when `WEBAPP_URL` is set. Backend `CORS` allows `FRONTEND_URL`.
- Deal cards deep-link into the app as `${WEBAPP_URL}?deal=<id>` and one-time join links as `${WEBAPP_URL}?deal=<id>&join=<token>`.
- `webapp/public` is **not** copied into the backend image anymore (see `backend/Dockerfile`); for single-port dev set `SERVE_STATIC=true`.

## Status & roadmap

| Status | Item |
|--------|------|
| ✅ | Bot commands and admin flows |
| ✅ | Deal lifecycle tracked off-chain (create → deposit → confirm → release/refund) |
| ✅ | Telegram Mini App UI |
| ✅ | One-time join links + per-deal chat |
| ✅ | W5 signer microservice (`signer/`) — isolated `SIGNER_MNEMONIC` (24 words) |
| ⚠️ | Compile the Tact contract and deploy it (see [contracts/README.md](contracts/README.md)) |
| ⚠️ | Set `REQUIRE_ONCHAIN=true` once deployed to enforce on-chain mode |
| ⚠️ | Fund the W5 deployer wallet (`SIGNER_MNEMONIC` in `signer/.env`, V5R1) with TON for gas |
| ❌ | Jetton master verification pending (`USDT_JETTON_ADDRESS` not yet validated on-chain) |

## Security notes

- **Rotate any credential that has ever been committed** (BOT_TOKEN included).
  Treat everything in git history as compromised.
- Never commit a real `.env`; it is git-ignored.
- API auth (see `backend/src/auth/`): mutating routes require a Telegram
  identity — the Mini App's `x-init-data` is HMAC-verified server-side against
  `BOT_TOKEN` — or an `x-api-key` for server-to-server callers. Admin-only
  routes (`notify`, `withdraw`, `refund`, notifications history) additionally
  require the caller to be in `ADMIN_TELEGRAM_IDS`. A dev fallback trusting
  `x-telegram-user-id` activates only when both `BOT_TOKEN` and `API_KEY`
  are unset — never in production.
- Request bodies are capped at 256 KB. In-memory rate limits are active:
  deal creation 10/min, join 20/min, chat posts 60/min, bot notifications
  5/min per IP+route.
