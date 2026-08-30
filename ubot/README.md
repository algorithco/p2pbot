# ubot — Telegram Userbot for Channel/Group Takeover

Robust GramJS (`telegram` `^2.22`) userbot that can promote admins and transfer ownership for channels and groups.

## Features

- **Channel takeover:** `promoteToAdmin` (`channels.editAdmin`), `transferChannelOwnership` (`channels.editCreator` with 2FA SRP), `takeover` (promote+transfer).
- **Group takeover:** handles basic `Chat` → auto-migrate to supergroup (`messages.migrateChat`), then same channel logic; `promoteGroupAdmin`, `transferGroupOwnership`.
- Robust: `FloodWait` auto-sleep, encrypted `StringSession` at rest (AES-256-GCM via `ENCRYPTION_KEY`), auto-reconnect, health endpoint.
- Internal HTTP API (port `3002`) secured via `UBOT_API_KEY` (`x-api-key`).

## Setup

```bash
cp .env.example .env  # set API_ID, API_HASH (my.telegram.org), TWO_FA_PASSWORD, ENCRYPTION_KEY
npm install
npm run login         # interactive: phone → code → 2FA → prints StringSession (encrypted)
# Paste UBOT_SESSION_STRING (encrypted) into .env
npm run build
npm start             # or npm run dev
```

## API

All `/channel` and `/group` routes require `x-api-key: $UBOT_API_KEY` if set. `GET /health` is open (docker healthcheck).

```bash
# health
curl http://localhost:3002/health

# channel info
curl -H "x-api-key: $UBOT_API_KEY" http://localhost:3002/channel/@mychannel
curl -H "x-api-key: $UBOT_API_KEY" http://localhost:3002/channel/@mychannel/admins

# promote
curl -X POST -H "x-api-key: $UBOT_API_KEY" -H "Content-Type: application/json" \
  -d '{"userId":"123456","rights":{"banUsers":true},"rank":"Admin"}' \
  http://localhost:3002/channel/@mychannel/promote

# transfer ownership (needs 2FA)
curl -X POST -H "x-api-key: $UBOT_API_KEY" -H "Content-Type: application/json" \
  -d '{"newOwnerId":"123456","password":"2FA_if_not_in_env"}' \
  http://localhost:3002/channel/@mychannel/transfer

# takeover one-shot
curl -X POST -H "x-api-key: $UBOT_API_KEY" -H "Content-Type: application/json" \
  -d '{"newOwnerId":"123456"}' http://localhost:3002/channel/@mychannel/takeover

# groups
curl -X POST -H "x-api-key: $UBOT_API_KEY" -H "Content-Type: application/json" \
  -d '{"userId":"123456"}' http://localhost:3002/group/123456789/promote
curl -X POST -H "x-api-key: $UBOT_API_KEY" -H "Content-Type: application/json" \
  -d '{"newOwnerId":"123456"}' http://localhost:3002/group/123456/takeover
```

## Notes

- Ownership transfer requires the userbot to be **creator** and valid `TWO_FA_PASSWORD`. Telegram may reject with `FRESH_CHANGE_ADMINS_FORBIDDEN` if account changed admins recently.
- Basic groups are auto-migrated to supergroups (id changes).
- Session stored encrypted in `sessions/ubot.session.enc` (600) or `UBOT_SESSION_STRING` env (also encrypted if `ENCRYPTION_KEY` set).

## Docker

Build via root `docker-compose.yml` (`ubot` service, `expose: 3002`, volume `ubot_sessions:/app/ubot/sessions`).
