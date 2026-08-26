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

/** CORS restricted to the configured webapp origin (falls back to reflect-all on bad URL). */
let corsOrigin: string | boolean = true;
try {
  if (config.webappUrl) corsOrigin = new URL(config.webappUrl).origin;
} catch {
  corsOrigin = true;
}
app.use(cors({ origin: corsOrigin, credentials: false }));
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
app.get('/api/info', (_req, res) => {
  res.json({ adminTelegramIds: config.adminTelegramIds, feeBps: config.feeBps });
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
    paymentAddress: '',
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

// JSON 500 for anything that slipped past a handler.
app.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => {
  logger.error('Unhandled API error', err);
  if (!res.headersSent) {
    res.status(500).json({ error: 'internal_error' });
  }
});

const publicDir = path.resolve(__dirname, '..', '..', 'webapp', 'public');
app.use((req, res, next) => {
  res.setHeader('Cache-Control', 'no-cache');
  next();
});
app.use('/', express.static(publicDir));

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
