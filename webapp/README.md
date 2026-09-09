# TonEscrow — Telegram Mini App

A polished, production-grade Telegram Web App (Mini App) front-end for the P2P escrow bot. Pure static files — no build step, no framework.

## Features

- **Deals dashboard** — stats, Active / Completed / All filters, live-polling deal cards
- **4-step create-deal wizard** — role selection, counterparty ID, TON/USDT asset + amount with fee estimate, terms & deadline, review; submits via the native Telegram **MainButton**
- **Deal detail** — status timeline, buyer/seller party cards, terms, metadata, escrow contract address (copy + Tonviewer explorer link), on-chain status chip, share invite link
- **Deal chat** — per-deal messaging with 4s polling and optimistic send
- **Join flow** — deep links (`#/deal/:id/join/:token`) and `start_param` support (`dealId.token`)
- **Account screen** — profile card, Auto/Light/Dark appearance override, API connectivity test, admin tools entry
- **Admin tools** — bot broadcast notifications + recent history (visible when your Telegram ID is in `ADMIN_TELEGRAM_IDS`)
- **Telegram integration** — `telegram-web-app.js`, theme sync via CSS variables, BackButton/MainButton, HapticFeedback, closing confirmation guard, safe-area insets, viewport height fix — all gracefully degraded to a "Preview mode" when opened outside Telegram

## Structure

```
public/
├── index.html        app shell (loads TG SDK + local scripts)
├── manifest.json     PWA manifest
├── icon.svg          app icon
├── css/style.css     design system (synced with --tg-theme-* vars)
└── js/
    ├── tg.js         Telegram WebApp bridge (haptics, buttons, dialogs)
    ├── api.js        backend HTTP client (sends x-init-data headers)
    ├── ui.js         DOM helpers, formatting, toasts, bottom sheets
    └── app.js        hash router + views (home/create/deal/chat/profile/admin)
```

## Run locally

```bash
cd webapp
npm install
npm start          # http://localhost:8080 (cache disabled)
```

In production the Express backend serves this same folder at `/` (port 3000 by default), which is also where the `/api/*` endpoints live.

## Deploying inside Telegram

1. Host on a **public HTTPS URL** (required by Telegram).
2. Point the bot's menu button / inline `web_app` button at that URL.
3. Invite links use `{origin}/api/deals/{id}/join/{token}`; the app also accepts `start_param` in the form `dealId.token` when launched via `t.me/yourbot?startapp=...`.

## Backend expectations

| Endpoint                                       | Used for                                                       |
| ---------------------------------------------- | -------------------------------------------------------------- |
| `GET /api/info`                                | admin IDs + connectivity check                                 |
| `GET /api/deals/mine` (alias `GET /api/deals`) | private dashboard — only own deals (admin sees all)            |
| `GET /api/deals/:id?token=`                    | private detail — only buyer/seller/admin or valid invite token |
| `POST /api/deals`                              | create (`{sellerId, buyerId, asset, amount, terms, deadline}`) |
| `POST /api/deals/:id/join/:token`              | join via invite                                                |
| `GET/POST /api/deals/:id/chat`                 | private deal chat (party/admin only)                           |
| `GET /api/status/:address`                     | on-chain escrow status (optional)                              |
| `POST /api/notify`, `GET /api/notifications`   | admin tools                                                    |

The client forwards `x-init-data` and `x-telegram-user-id` headers on every request so the backend can add initData validation later.

## Packaging as TWA (optional)

```bash
npm i -g @bubblewrap/cli
bubblewrap init --manifest https://your-public-url/manifest.json
bubblewrap build
```
