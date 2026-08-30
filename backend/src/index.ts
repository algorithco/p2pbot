// src/index.ts
import express, { Request, Response, NextFunction, RequestHandler } from 'express';
import path from 'path';
import cors from 'cors';
import type { Server } from 'http';
import { config } from './config';
import { db, connectDB, listDeals } from './db/queries';
import { Address, openContract } from '@ton/core';
import { Escrow } from './contracts/wrappers/Escrow';
import { client } from './blockchain/tonClient';
import logger from './logger';
import { startBot, getBot } from './bot/bot';
import { startListener } from './blockchain/listener';
import {
  createDealRecord,
  generateDealLink,
  getDealById,
  getDealLink,
  validateDealLink,
  markDealLinkUsed,
  assignRoleToDeal,
  purgeExpiredLinks,
} from './services/dealService';
import {
  identityAuth,
  requireIdentity,
  requireAdmin,
  rateLimit,
  getIdentityId,
  isValidPositiveInt,
} from './auth/guard';

const app = express();
// Trust X-Forwarded-* from nginx/cloudflared (needed for https detection behind proxy)
app.set('trust proxy', 1);

/** CORS — micro-architecture: backend (3000) separate from frontend (8080 via nginx).
 * Allow WEBAPP_URL, FRONTEND_URL, and local dev origins. Falls back to allow-all in dev.
 */
function buildAllowedOrigins(): string[] {
  const origins = new Set<string>();
  for (const u of [config.webappUrl, config.frontendUrl]) {
    if (!u) continue;
    try { origins.add(new URL(u).origin); } catch {}
  }
  // Local dev + docker internal
  origins.add('http://localhost:8080');
  origins.add('http://127.0.0.1:8080');
  origins.add('http://frontend:80');
  origins.add('http://frontend');
  origins.add('http://localhost:3000');
  return Array.from(origins);
}
const allowedOrigins = buildAllowedOrigins();
const corsOrigin: boolean | ((origin: string | undefined, cb: (err: Error | null, allow?: boolean) => void) => void) =
  allowedOrigins.length === 0
    ? true
    : (origin, cb) => {
        if (!origin) return cb(null, true); // same-origin / curl / healthcheck
        if (allowedOrigins.includes(origin)) return cb(null, true);
        // Fallback: allow if WEBAPP_URL not set (dev)
        if (!config.webappUrl && !config.frontendUrl) return cb(null, true);
        return cb(null, false);
      };
// Use function form when we have a list, boolean otherwise (type any to avoid overload mismatch)
app.use(cors({ origin: corsOrigin as never, credentials: false }));
app.use(express.json({ limit: '256kb' }));
app.use(identityAuth);

type AsyncRequestHandler = (req: Request, res: Response, next: NextFunction) => Promise<unknown>;

/** Wraps async handlers so rejections hit the error middleware -> 500 JSON. */
function asyncHandler(fn: AsyncRequestHandler): RequestHandler {
  return (req, res, next) => {
    Promise.resolve(fn(req, res, next)).catch(next);
  };
}

// Rate limiters (per-ip sliding window)
const notifyLimiter = rateLimit({ windowMs: 60_000, max: 5, name: 'notify' });
const dealsCreateLimiter = rateLimit({ windowMs: 60_000, max: 10, name: 'deals-create' });
const chatPostLimiter = rateLimit({ windowMs: 60_000, max: 60, name: 'chat-post' });
const joinLimiter = rateLimit({ windowMs: 60_000, max: 20, name: 'join' });

function isAdminTelegramId(id: number): boolean {
  return config.adminTelegramIds.map(Number).includes(Number(id));
}

/**
 * Caller telegram id for a route:
 * verified identity wins; body value only trusted from api-key callers.
 */
function callerTelegramId(req: Request): number | null {
  const identity = getIdentityId(req);
  if (identity !== null) return identity;
  if (req.body && typeof req.body === 'object') {
    const bodyVal = Number((req.body as Record<string, unknown>).telegramId);
    if (isValidPositiveInt(bodyVal)) return bodyVal;
  }
  return null;
}

// Notification endpoint (admin-only)
app.post('/api/notify', requireAdmin, notifyLimiter, asyncHandler(async (req, res) => {
  const { chatId, message } = req.body;
  if (!chatId || !message) return res.status(400).json({ error: 'chatId and message required' });
  const bot = getBot();
  if (!bot) return res.status(503).json({ error: 'bot_not_configured' });
  await bot.api.sendMessage(chatId, String(message));
  try {
    await db.query('INSERT INTO notifications (chat_id, message) VALUES ($1,$2)', [chatId, String(message)]);
  } catch (e) {
    logger.warn('could not persist notification', e);
  }
  return res.json({ ok: true });
}));

// Notification history (admin-only)
app.get('/api/notifications', requireAdmin, asyncHandler(async (_req, res) => {
  try {
    const result = await db.query('SELECT * FROM notifications ORDER BY id DESC LIMIT 200');
    return res.json(result.rows);
  } catch (err) {
    logger.warn('/api/notifications error', err);
    return res.json([]);
  }
}));

// Public: webapp boot info (feeBps lets the frontend show exact fees)
const ADDR_RE = /^(EQ|UQ)[A-Za-z0-9_-]{46}$|^0:-1?[0-9a-fA-F]{64}$/;
function resolvePaymentAddress(): string | null {
  if (config.walletAddress && ADDR_RE.test(config.walletAddress.trim())) return config.walletAddress.trim();
  if (config.adminAddress && ADDR_RE.test(config.adminAddress.trim())) return config.adminAddress.trim();
  return null;
}

// TON Connect dapp manifest — uses public frontend URL when behind cloudflared/nginx
// Priority: 1) WEBAPP_URL/FRONTEND_URL env (explicit cloudflare URL), 2) X-Forwarded-* from proxy, 3) Host header
app.get('/tonconnect-manifest.json', (req, res) => {
  // If WEBAPP_URL is set to https://<cloudflare>, use it directly (bot and manifest share same public URL)
  const configured = (config.webappUrl || config.frontendUrl || '').trim().replace(/\/+$/, '');
  let origin: string;
  if (configured && /^https?:\/\//i.test(configured)) {
    try {
      origin = new URL(configured).origin;
    } catch {
      origin = configured;
    }
  } else {
    // Derive from request (supports cloudflared: X-Forwarded-Proto https + Host xxx.trycloudflare.com)
    const host = (req.get('x-forwarded-host') || req.get('host') || 'localhost').split(',')[0].trim() || 'localhost';
    const forwardedProto = (req.get('x-forwarded-proto') || '').split(',')[0].trim();
    const proto =
      forwardedProto === 'https' || forwardedProto === 'http'
        ? forwardedProto
        : host.startsWith('localhost') || host.startsWith('127.0.0.1')
          ? 'http'
          : 'https';
    origin = `${proto}://${host}`;
  }
  res.setHeader('Cache-Control', 'no-cache');
  res.json({
    url: origin,
    name: 'TonEscrow',
    iconUrl: `${origin}/icon.svg`,
    termsOfUseUrl: origin,
    privacyPolicyUrl: origin,
  });
});

app.get('/api/info', (_req, res) => {
  res.json({
    adminTelegramIds: config.adminTelegramIds,
    feeBps: config.feeBps,
    paymentAddress: resolvePaymentAddress(),
    network: config.tonNetwork
  });
});

// Deals belonging to the caller (must come before /api/deals/:id)
app.get('/api/deals/mine', requireIdentity, asyncHandler(async (req, res) => {
  const telegramId = getIdentityId(req);
  if (telegramId === null) return res.status(401).json({ error: 'identity_required' });
  const result = await db.query(
    'SELECT * FROM deals WHERE buyer_telegram_id = $1 OR seller_telegram_id = $1 ORDER BY id DESC LIMIT 200',
    [telegramId]
  );
  return res.json(result.rows);
}));

// Existing deal list (public read)
app.get('/api/deals', asyncHandler(async (_req, res) => {
  try {
    return res.json(await listDeals(100));
  } catch (err) {
    logger.warn('/api/deals error', err);
    return res.json([]);
  }
}));

app.get('/api/deals/:id', asyncHandler(async (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id)) return res.status(400).json({ error: 'invalid_id' });
  return res.json(await getDealById(id));
}));

// Create a new deal (buyer optional for api-key callers, returns generated link)
app.post('/api/deals', dealsCreateLimiter, requireIdentity, asyncHandler(async (req, res) => {
  const { asset, amount, terms, deadline } = req.body;
  if (!asset || !amount) return res.status(400).json({ error: 'sellerId, asset, amount required' });

  // The creator must occupy exactly one side of the deal. For identity-auth
  // callers the authenticated id is forced onto that side; the counterparty
  // id is taken from whichever side they did NOT claim.
  let sellerId = isValidPositiveInt(req.body.sellerId) ? Number(req.body.sellerId) : null;
  let buyerId = isValidPositiveInt(req.body.buyerId) ? Number(req.body.buyerId) : null;

  if (req.authMode !== 'api-key') {
    const meId = req.user ? req.user.id : Number(req.headers['x-telegram-user-id']) || null;
    if (!meId) return res.status(401).json({ error: 'identity_required' });

    const role = String((req.body as Record<string, unknown>).role || '').toLowerCase();
    if (buyerId === meId) {
      // creator claims buyer side; sellerId must be the counterparty
    } else if (sellerId === meId) {
      // creator claims seller side
    } else if (role === 'sell' || (!sellerId && buyerId)) {
      sellerId = meId;
    } else {
      buyerId = meId;
    }

    if (sellerId === meId && !buyerId) return res.status(400).json({ error: 'counterparty_id_required' });
    if (buyerId === meId && !sellerId) return res.status(400).json({ error: 'counterparty_id_required' });
  }

  if (!isValidPositiveInt(sellerId)) return res.status(400).json({ error: 'sellerId_must_be_positive_int' });
  if (buyerId !== null && sellerId === buyerId) {
    return res.status(400).json({ error: 'sellerId_must_differ_from_buyerId' });
  }

  const deal = await createDealRecord({
    buyerId,
    sellerId,
    buyerTelegramId: buyerId,
    sellerTelegramId: sellerId,
    asset,
    amount,
    feeBps: config.feeBps,
    status: 'AWAITING_DEPOSIT',
    contractAddress: '',
    paymentAddress: resolvePaymentAddress() || '',
    terms: terms || '',
    deadline: deadline ? new Date(deadline) : null,
  });
  const linkToken = await generateDealLink(deal.id);
  return res.json({
    deal,
    link: `${req.protocol}://${req.get('host')}/api/deals/${deal.id}/join/${linkToken}`,
  });
}));

// Join a deal via one-time link (assigns the missing role exactly once)
app.post('/api/deals/:id/join/:token', joinLimiter, requireIdentity, asyncHandler(async (req, res) => {
  const dealId = Number(req.params.id);
  const token = String(req.params.token || '');
  if (!Number.isInteger(dealId) || !token) return res.status(400).json({ error: 'invalid_request' });

  // Token must exist in deal_links…
  const link = await getDealLink(token);
  if (!link || Number(link.deal_id) !== dealId) {
    return res.status(404).json({ error: 'invalid_token' });
  }
  // …and not be expired.
  if (new Date(link.expires_at).getTime() <= Date.now()) {
    void markDealLinkUsed(token).catch(() => undefined);
    return res.status(410).json({ error: 'link_expired' });
  }

  const deal = await validateDealLink(token);
  if (!deal || Number(deal.id) !== dealId) {
    return res.status(404).json({ error: 'deal_not_found' });
  }

  // Role = whichever side is still missing.
  let role: 'buyer' | 'seller';
  if (deal.buyer_telegram_id == null) role = 'buyer';
  else if (deal.seller_telegram_id == null) role = 'seller';
  else return res.status(409).json({ error: 'deal_already_full' });

  // Telegram id: verified identity wins; body value only for api-key callers.
  let telegramId: number | null;
  if ((req.authMode === 'telegram' || req.authMode === 'dev') && req.user && isValidPositiveInt(req.user.id)) {
    telegramId = req.user.id; // body {telegramId} is ignored for authenticated callers
  } else {
    telegramId = callerTelegramId(req);
  }
  if (telegramId === null) return res.status(400).json({ error: 'telegramId_required' });

  await assignRoleToDeal(dealId, role, telegramId);

  // One-time link: consume it.
  await markDealLinkUsed(token);
  void purgeExpiredLinks().catch((err) => logger.warn('purgeExpiredLinks failed', err));

  return res.json({ ok: true, role });
}));

// Chat endpoints
app.get('/api/deals/:id/chat', asyncHandler(async (req, res) => {
  const { id } = req.params;
  const messages = await db.query('SELECT * FROM messages WHERE deal_id = $1 ORDER BY created_at ASC', [id]);
  return res.json(messages.rows);
}));

app.post('/api/deals/:id/chat', chatPostLimiter, requireIdentity, asyncHandler(async (req, res) => {
  const dealId = Number(req.params.id);
  if (!Number.isInteger(dealId) || dealId <= 0) return res.status(400).json({ error: 'invalid_id' });
  const content = req.body ? req.body.content : undefined;
  if (typeof content !== 'string' || !content.trim()) return res.status(400).json({ error: 'content_required' });

  // Sender identity is FORCED server-side; body senderTelegramId only trusted from api-key callers.
  let senderTelegramId: number | null;
  if (
    req.authMode === 'api-key' &&
    req.body &&
    isValidPositiveInt((req.body as Record<string, unknown>).senderTelegramId)
  ) {
    senderTelegramId = Number((req.body as Record<string, unknown>).senderTelegramId);
  } else {
    senderTelegramId = req.user && isValidPositiveInt(req.user.id) ? req.user.id : null;
  }
  if (senderTelegramId === null) return res.status(400).json({ error: 'sender_required' });

  // Only a party to the deal (or an admin/api-key caller) may post.
  const deal = await getDealById(dealId);
  if (!deal) return res.status(404).json({ error: 'deal_not_found' });
  const isParty =
    (deal.buyer_telegram_id != null && Number(deal.buyer_telegram_id) === senderTelegramId) ||
    (deal.seller_telegram_id != null && Number(deal.seller_telegram_id) === senderTelegramId);
  const isAdminCaller = req.authMode === 'api-key' || isAdminTelegramId(senderTelegramId);
  if (!isParty && !isAdminCaller) return res.status(403).json({ error: 'not_a_party_to_deal' });

  await db.query('INSERT INTO messages (deal_id, sender_telegram_id, content) VALUES ($1,$2,$3)', [dealId, senderTelegramId, content]);
  return res.json({ ok: true });
}));

// Withdraw endpoint (admin-only; deprecated wrapper — guarded DB transition only)
app.post('/api/withdraw', requireAdmin, asyncHandler(async (req, res) => {
  const { dealId, toAddress, amount, tokenType } = req.body;
  const { transferTokens } = await import('./services/escrowService');
  const result = await transferTokens(Number(dealId), toAddress, amount, tokenType);
  return res.json(result);
}));

// Refund endpoint (admin-only; deprecated wrapper — guarded DB transition only)
app.post('/api/refund', requireAdmin, asyncHandler(async (req, res) => {
  const { dealId, toAddress } = req.body;
  const { refundBuyerWithoutFee } = await import('./services/escrowService');
  const result = await refundBuyerWithoutFee(Number(dealId), toAddress);
  return res.json(result);
}));

app.get('/api/status/:address', asyncHandler(async (req, res) => {
  try {
    const addr = Address.parse(req.params.address);
    const escrow = new Escrow(addr as any);
    const opened = openContract(escrow, ({ address: a }) => client.provider(a, null as any));
    const status = await opened.getStatus();
    return res.json({ status });
  } catch (err) {
    logger.warn('/api/status error', err);
    return res.status(500).json({ error: String(err) });
  }
}));

// --- API Documentation (self-describing) ------------------------------------
const API_DOCS = {
  name: 'TON Escrow Bot — REST API',
  version: '1.0.0',
  baseUrl: '/api',
  auth: {
    telegram: 'x-init-data (HMAC-SHA256 via BOT_TOKEN) + x-telegram-user-id — verified in src/auth/initData.ts, 24h window',
    apiKey: 'x-api-key: <API_KEY> header or ?api_key= (timing-safe, see src/auth/guard.ts)',
    devFallback: 'x-telegram-user-id only when BOT_TOKEN and API_KEY unset (never in prod)',
    admin: 'Telegram id in ADMIN_TELEGRAM_IDS or any api-key caller',
  },
  rateLimits: 'create deal 10/min · join 20/min · chat post 60/min · notify 5/min (sliding window per IP+route)',
  endpoints: [
    { method: 'GET', path: '/api/info', auth: 'public', desc: 'Health + feeBps, paymentAddress, network, adminTelegramIds' },
    { method: 'GET', path: '/tonconnect-manifest.json', auth: 'public', desc: 'TON Connect manifest (dynamic origin)' },
    { method: 'GET', path: '/api/docs', auth: 'public', desc: 'This doc (JSON)' },
    { method: 'GET', path: '/api/openapi.json', auth: 'public', desc: 'OpenAPI 3.0 spec (machine-readable)' },
    { method: 'GET', path: '/docs', auth: 'public', desc: 'Human HTML docs (try it)' },
    { method: 'GET', path: '/api/deals', auth: 'public', desc: 'List last 100 deals' },
    { method: 'GET', path: '/api/deals/:id', auth: 'public', desc: 'Single deal by id' },
    { method: 'GET', path: '/api/deals/mine', auth: 'Identity', desc: 'Deals where caller is buyer or seller (requires x-init-data or x-api-key)' },
    { method: 'POST', path: '/api/deals', auth: 'Identity', desc: 'Create deal {sellerId, asset TON|USDT, amount, terms?, deadline?} — caller forced to one side, returns {deal, link} with one-time join link' },
    { method: 'POST', path: '/api/deals/:id/join/:token', auth: 'Identity', desc: 'Consume one-time link, assign missing buyer/seller role' },
    { method: 'GET', path: '/api/deals/:id/chat', auth: 'public', desc: 'Deal chat messages' },
    { method: 'POST', path: '/api/deals/:id/chat', auth: 'Identity (party or admin)', desc: 'Post {content} — sender forced to caller, only party/admin' },
    { method: 'POST', path: '/api/notify', auth: 'Admin', desc: 'Send bot message {chatId, message} — rate 5/min' },
    { method: 'GET', path: '/api/notifications', auth: 'Admin', desc: 'Last 200 notifications' },
    { method: 'POST', path: '/api/withdraw', auth: 'Admin', desc: 'Release (guarded DB → RELEASED; on-chain stub if REQUIRE_ONCHAIN=true without signer)' },
    { method: 'POST', path: '/api/refund', auth: 'Admin', desc: 'Refund (guarded DB → REFUNDED)' },
    { method: 'GET', path: '/api/status/:address', auth: 'public', desc: 'On-chain Escrow.getStatus() for address' },
  ],
  internalServices: {
    signer: { url: 'http://signer:3001 (internal, NOT published)', endpoints: ['GET /health (open)', 'GET /address (x-api-key)', 'GET /info (x-api-key)', 'POST /send {to,value,comment?}', 'POST /send-batch {requests[]}', 'POST /deploy', 'POST /deploy-escrow {escrowAddress, escrowStateInit{codeBoc,dataBoc}, value, bodyBoc}'] },
    ubot: { url: 'http://ubot:3002 (internal)', endpoints: ['GET /health (open)', 'GET /channel/:id, /channel/:id/admins (x-api-key)', 'POST /channel/:id/promote {userId,rights?,rank?}', 'POST /channel/:id/transfer {newOwnerId,password?}', 'POST /channel/:id/takeover {newOwnerId,password?}', 'POST /group/:id/promote|transfer|takeover', 'GET /group/:id/isBasic, POST /group/:id/migrate'] },
    utradebot: { url: 'http://utradebot:3003 (internal)', endpoints: ['GET /health (open)', 'GET /api/trades/:id (x-api-key if set)', 'Telegram bot: /start, /sell, /buy, /mytrades, /setphone, /setbuyer, /help'] },
  },
  headers: {
    'x-init-data': 'Telegram WebApp initData (required for Identity when not api-key)',
    'x-telegram-user-id': 'Fallback when api-key/dev only',
    'x-api-key': 'Shared secret if API_KEY set',
    'x-signer-key / x-api-key (signer)': 'SIGNER_API_KEY',
    'x-ubot-key / x-api-key (ubot)': 'UBOT_API_KEY',
  },
  notes: [
    'Mini App served at / (webapp/public) with ?deal=<id>&join=<token> deep links; requires WEBAPP_URL=https://<public> for Telegram menu button',
    'Postgres: deals, users, messages, deal_links, notifications + utrade_trades/utrade_events (shared volume pgdata)',
    'See backend/README.md for full env table and auth legend',
  ],
};

app.get('/api/docs', (_req, res) => {
  res.json(API_DOCS);
});

app.get('/api/openapi.json', (req, res) => {
  const host = req.get('host') || 'localhost:3000';
  const scheme = host.startsWith('localhost') || host.startsWith('127.0.0.1') ? 'http' : 'https';
  const servers = [{ url: `${scheme}://${host}` }];
  // Minimal OpenAPI 3.0 from API_DOCS
  const paths: Record<string, unknown> = {};
  for (const ep of API_DOCS.endpoints) {
    const p = ep.path.replace(/:(\w+)/g, '{$1}');
    if (!paths[p]) paths[p] = {};
    const m = ep.method.toLowerCase();
    (paths[p] as Record<string, unknown>)[m] = {
      summary: ep.desc,
      tags: [ep.auth],
      responses: { '200': { description: 'OK' } },
    };
  }
  res.json({
    openapi: '3.0.3',
    info: { title: API_DOCS.name, version: API_DOCS.version },
    servers,
    paths,
    components: { securitySchemes: { initData: { type: 'apiKey', in: 'header', name: 'x-init-data' }, apiKey: { type: 'apiKey', in: 'header', name: 'x-api-key' } } },
  });
});

app.get('/docs', (_req, res) => {
  res.type('html').send(`<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>TON Escrow — API Docs</title><style>
  *{box-sizing:border-box}body{font-family:system-ui,Segoe UI,Roboto,Helvetica,Arial,sans-serif;margin:0;background:#0b0e14;color:#e6e8eb}
  a{color:#6aa8ff}header{padding:24px 20px;border-bottom:1px solid #1f2533;background:#0f131d;position:sticky;top:0}
  h1{margin:0;font-size:22px}h2{margin:28px 0 12px;font-size:18px;color:#8ab4ff}code{background:#1a2030;padding:2px 6px;border-radius:6px;font-size:13px}
  .wrap{max-width:1080px;margin:0 auto;padding:20px}table{width:100%;border-collapse:collapse;background:#111827;border:1px solid #1f2533;border-radius:10px;overflow:hidden}
  th,td{padding:10px 12px;border-bottom:1px solid #1f2533;text-align:left;font-size:14px}th{background:#0f131d;color:#8ab4ff}tr:last-child td{border-bottom:none}
  .tag{padding:2px 8px;border-radius:999px;font-size:12px;background:#1a2030;border:1px solid #2a3550}
  .auth-public{color:#7dd3a5}.auth-Identity{color:#f0c27a}.auth-Admin{color:#ff8a8a}
  pre{white-space:pre-wrap;background:#0f131d;border:1px solid #1f2533;padding:14px;border-radius:10px;overflow:auto}
  </style></head><body><header><div class="wrap"><h1>TON Escrow Bot — API Docs</h1><div style="opacity:.7;margin-top:6px">Base: <code>/api</code> · <a href="/api/docs">/api/docs</a> (JSON) · <a href="/api/openapi.json">/api/openapi.json</a> · <a href="/api/info">/api/info</a></div></div></header><div class="wrap">
  <h2>Auth</h2><pre>${JSON.stringify(API_DOCS.auth, null, 2)}</pre>
  <h2>Rate limits</h2><p><code>${API_DOCS.rateLimits}</code></p>
  <h2>Endpoints</h2><table><thead><tr><th>Method</th><th>Path</th><th>Auth</th><th>Description</th></tr></thead><tbody id="rows"></tbody></table>
  <h2>Internal services (docker network escrow-net, not published)</h2><pre id="internal"></pre>
  <h2>Headers</h2><pre id="headers"></pre>
  <h2>Try</h2><p>Health: <code>curl http://localhost:3000/api/info</code> · Docs JSON: <code>curl http://localhost:3000/api/docs</code></p>
  <pre id="try"></pre>
  </div><script>
  fetch('/api/docs').then(r=>r.json()).then(d=>{
    const tbody=document.getElementById('rows');
    for(const ep of d.endpoints){
      const tr=document.createElement('tr');
      tr.innerHTML='<td><code>'+ep.method+'</code></td><td><code>'+ep.path+'</code></td><td><span class="tag auth-'+ep.auth.split(/[ (]/)[0]+'">'+ep.auth+'</span></td><td>'+ep.desc+'</td>';
      tbody.appendChild(tr);
    }
    document.getElementById('internal').textContent=JSON.stringify(d.internalServices,null,2);
    document.getElementById('headers').textContent=JSON.stringify(d.headers,null,2);
    document.getElementById('try').textContent='curl -H "x-api-key: $API_KEY" http://localhost:3000/api/deals/mine\\n\\n# with Telegram initData (Mini App):\\ncurl -H "x-init-data: $INIT_DATA" -H "x-telegram-user-id: 123" http://localhost:3000/api/deals';
  }).catch(e=>{document.body.innerHTML+='<pre>'+e+'</pre>'});
  </script></body></html>`);
});

// JSON 500 for anything that slipped past a handler.
app.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => {
  logger.error('Unhandled API error', err);
  if (!res.headersSent) {
    res.status(500).json({ error: 'internal_error' });
  }
});

// --- Micro-architecture: backend is API-only, frontend is separate nginx service (webapp:80 -> 8080) ---
// For local dev without frontend, set SERVE_STATIC=true to re-enable static serving.
if (config.serveStatic) {
  const publicDir = path.resolve(__dirname, '..', '..', 'webapp', 'public');
  app.use((req, res, next) => {
    res.setHeader('Cache-Control', 'no-cache');
    next();
  });
  app.use('/', express.static(publicDir));
  logger.info('SERVE_STATIC=true — backend also serving webapp/public (dev fallback)');
} else {
  // API-only root — point to frontend and docs
  app.get('/', (_req, res) => {
    res.json({
      service: 'escrow-backend',
      mode: 'micro-architecture: API-only (frontend separate)',
      frontend: config.frontendUrl,
      docs: '/api/docs',
      htmlDocs: '/docs',
      openapi: '/api/openapi.json',
      health: '/api/info',
      note: 'Frontend (Telegram Mini App) runs as separate service webapp:80 -> host :8080, proxies /api to this backend',
    });
  });
}

const port = Number(process.env.PORT || 3000);
let server: Server | null = null;

connectDB()
  .then(async () => {
    if (config.botToken) {
      try {
        await startBot();
      } catch (err) {
        logger.error('Bot failed to start — continuing without Telegram polling', err);
      }
    } else {
      logger.warn('BOT_TOKEN not set — /api/notify will return 503');
    }
    try {
      await startListener();
    } catch (err) {
      logger.error('Blockchain listener failed to start', err);
    }
    server = app.listen(port, () => logger.info(`Server listening on http://localhost:${port}`));
  })
  .catch(err => {
    logger.error('Could not initialize DB', err);
    server = app.listen(port, () => logger.info(`Server listening (DB not ready) on http://localhost:${port}`));
  });

let shuttingDown = false;
async function shutdown(signal: string) {
  if (shuttingDown) return;
  shuttingDown = true;
  logger.info(`${signal} received — shutting down`);
  const bot = getBot();
  if (bot) {
    try {
      await bot.stop();
    } catch (err) {
      logger.warn('Bot stop failed during shutdown', err);
    }
  }
  if (server) {
    server.close(() => logger.info('HTTP server closed'));
  }
  try {
    await db.end();
  } catch (err) {
    logger.warn('DB pool close failed during shutdown', err);
  }
  process.exit(0);
}
process.on('SIGINT', () => void shutdown('SIGINT'));
process.on('SIGTERM', () => void shutdown('SIGTERM'));

process.on('unhandledRejection', logger.error);
