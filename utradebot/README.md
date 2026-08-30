# utradebot — Telegram Account Sale Escrow

Facilitates sale of Telegram userbot accounts with secure session handoff:

1.  **Seller** runs `/sell`, sends **StringSession** (preferred, stronger) or `phone:+...` + code. Bot logs into the empty account, validates, and **removes seller from session** (`account.getAuthorizations` → `auth.resetAuthorizations` / per-hash `resetAuthorization`, keeping only current hash). Stores session **encrypted** (AES-256-GCM, `ENCRYPTION_KEY`).
2.  Buyer transfers fee **outside bot** (TON/USDT per seller; other payments out of scope).
3.  Seller confirms receipt (`✅ Payment received` button). Bot sends **phone number** to buyer.
4.  **Buyer** (now bound via `/buy <id>` or `/setbuyer`) receives notification to send **login code**. Upon receiving code (5-6 digits), bot verifies via `auth.signIn` (handling 2FA `2fa:password` if needed) — buyer logs in, **utradebot logs out** (`auth.logOut` on held session). Session row retained encrypted but now **revoked/invalid** (`getAuthorizations` returns 0 for old hash).

## Dual ingest

- **StringSession** (recommended): `client.session.save()` → paste full string. No SMS interception, single-step, encrypted at rest.
- **Phone + code + 2FA**: `phone:+123...` → bot `auth.sendCode` → you send `12345` → if `SESSION_PASSWORD_NEEDED`, send `2fa:yourpassword`.

## Setup

```bash
cp .env.example .env # set UTRADE_BOT_TOKEN, API_ID, API_HASH, DATABASE_URL, ENCRYPTION_KEY (64 hex)
npm install
npm run build
npm start           # or npm run dev
```

## Bot UX

- Seller: `/sell` → send session/phone → `/setbuyer <id> <buyerId>` (optional early bind) → after external payment, press `✅ Payment received` → phone shared.
- Buyer: `/buy <tradeId>` → binds, receives phone → send login code → `2fa:...` if needed → completes.
- Both: `/mytrades`, `/setphone <id> <phone>`, `/help`, `/start`.

## DB

Shared Postgres, tables `utrade_trades` (id, seller, buyer, phone, `session_encrypted`, status, `phoneCodeHash`, `expires_at`) + `utrade_events` + `ensureTables()` at boot. Statuses: `PENDING_SESSION → SELLER_REMOVED → AWAITING_PAYMENT → PHONE_SHARED → AWAITING_CODE → AWAITING_BUYER_LOGIN → COMPLETED|FAILED|CANCELLED` (auto-expire 24h).

## Security

- Sessions **always encrypted** (`ENCRYPTION_KEY` 32-byte hex). Plain stored only if key missing (warn).
- Phone masked in logs (`+12****`).
- **Revoked after completion:** `auth.logOut` invalidates held hash; DB row retained encrypted but `checkAuthorization` will fail even if decrypted and reused.
- Rate limited via grammy + in-memory per-user step tracking.
- Never log `code`/`password`/`session`.

## API

- `GET /health` (open) — docker healthcheck
- `GET /api/trades/:id` (requires `x-api-key: $UTRADE_API_KEY` if set)

## Docker

Service `utradebot` in root `docker-compose.yml` (`expose: 3003`, `depends_on: postgres`, volume `utrade_sessions`).

## Notes

- TON/USDT payments are escrowed via main backend (`escrow-bot`) — utradebot only handles account handoff, not fee custody.
- Empty account check: warns if >20 dialogs.
