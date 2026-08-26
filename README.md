# TON Escrow Bot

A peer-to-peer escrow service for Telegram: a grammY bot plus a Telegram Mini
App that lets two parties trade TON or USDT (jettons) safely. Funds are held by
an on-chain `Escrow` contract (Tact) when deployed, while the backend keeps a
full off-chain deal ledger so the product is fully usable before any wallet or
contract exists.

## Architecture

```
 Telegram users (chat + Mini App)
        │  Bot API / HTTPS
        ▼
┌──────────────────┐      ┌─────────────────────┐
│  grammY bot      │◄────►│  Express API :3000  │◄── webapp/ served at /
│  (/newdeal, ...) │      │  REST + static host │
└──────────────────┘      └─────────────────────┘
                                   │
                    ┌──────────────┼──────────────────┐
                    ▼              ▼                  ▼
              ┌──────────┐   ┌──────────────┐   ┌──────────────────┐
              │ Postgres │   │ blockchain   │   │ Escrow.tact      │
              │ (deals,  │   │ listener +   │◄─►│ (on TON: deposit,│
              │ msgs,    │   │ deployer     │   │  release/refund) │
              │ links)   │   │ wallet       │   └──────────────────┘
              └──────────┘   └──────────────┘
```

- **backend/** — TypeScript: bot commands, REST API (`src/index.ts`), deal
  ledger in Postgres (`src/db/schema.sql`), TON client/listener/deployer.
- **contracts/** — `Escrow.tact` smart contract, wrappers and sandbox tests.
- **webapp/** — static Mini App (plain HTML/JS) served by the backend at `/`.

## Quickstart

### A. Local (npm)

1. Run a local PostgreSQL and create the database:
   ```sql
   CREATE USER escrow WITH PASSWORD 'escrow_password';
   CREATE DATABASE escrow OWNER escrow;
   ```
2. Configure environment:
   ```bash
   cd backend
   cp .env.example .env    # then edit BOT_TOKEN, ADMIN_TELEGRAM_IDS, ...
   npm install
   npm run build
   npm start               # serves API + Mini App on PORT (default 3000)
   # or: npm run dev       # ts-node, no build step
   ```
3. Open the Mini App at `http://localhost:3000` and talk to the bot.

### B. Docker Compose

```bash
cp backend/.env.example backend/.env   # edit it first
docker compose up --build
```

Postgres starts with health checks; the backend waits for it, listens on
**host port 3000** and persists data in the `pgdata` volume. Redis was removed
— nothing in the codebase uses it.

## Environment

All variables are documented in [`backend/.env.example`](backend/.env.example)
(names match `backend/src/config.ts` exactly). Minimum for a working off-chain
instance: `BOT_TOKEN`, `ADMIN_TELEGRAM_IDS`, `DATABASE_URL`. For production add
`API_KEY` (32+ random chars), `WEBAPP_URL`, and the TON settings.

## Webapp / Mini App hosting

- Telegram **requires a public HTTPS URL** for Mini Apps. Serve the app behind
  TLS (Caddy/nginx/LB) and set `WEBAPP_URL=https://your-domain` — the bot menu
  button ("Open App") only appears when `WEBAPP_URL` is set.
- Deal cards deep-link into the app as `${WEBAPP_URL}?deal=<id>` and one-time
  join links as `${WEBAPP_URL}?deal=<id>&join=<token>`.
- The same static files are also served by the API itself at `/`, which is
  what the Docker image ships.

## Status & roadmap

| Status | Item |
|--------|------|
| ✅ | Bot commands and admin flows |
| ✅ | Deal lifecycle tracked off-chain (create → deposit → confirm → release/refund) |
| ✅ | Telegram Mini App UI |
| ✅ | One-time join links + per-deal chat |
| ⚠️ | Compile the Tact contract and deploy it (see [contracts/README.md](contracts/README.md)) |
| ⚠️ | Set `REQUIRE_ONCHAIN=true` once deployed to enforce on-chain mode |
| ⚠️ | Fund the deployer wallet (`MNEMONIC`) with TON for gas |
| ❌ | On-chain release/refund send path is stubbed until the wallet is configured |
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
