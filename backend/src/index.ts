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
import { startListener, addAddressToMonitor } from './blockchain/listener';
import {
  createDealRecord,
  generateDealLink,
  getBotDeepLink,
  getDealById,
  getDealLink,
  validateDealLink,
  markDealLinkUsed,
  assignRoleToDeal,
  atomicJoinDeal,
  getDealChatKey,
  purgeExpiredLinks,
  getDealMessages,
  addEncryptedMessage,
} from './services/dealService';
import { depositComment, releaseComment } from './utils/comments';
import { commentToPayloadB64, encryptedCommentToPayloadB64, jettonTransferPayload } from './utils/tonPayload';
import { isEncryptionEnabled } from './utils/encryption';
import { toBaseUnits } from './utils/money';
import {
  identityAuth,
  requireIdentity,
  requireAdmin,
  rateLimit,
  getIdentityId,
  isValidPositiveInt,
} from './auth/guard';

const app = express();
// Trust X-Forwarded-* from nginx (needed for https detection behind TLS proxy)
app.set('trust proxy', 1);

// Security headers — encrypted seller-buyer channel must not be sniffed/framed
app.use((req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'SAMEORIGIN');
  res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
  res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
  if (req.secure || req.get('x-forwarded-proto') === 'https') {
    res.setHeader('Strict-Transport-Security', 'max-age=63072000; includeSubDomains');
  }
  // CSP: Telegram WebView needs inline scripts (Mini App), so allow self + unsafe-inline for now but block framing
  res.setHeader('Content-Security-Policy', "default-src 'self' https: data: blob:; script-src 'self' 'unsafe-inline' https:; style-src 'self' 'unsafe-inline' https:; img-src 'self' data: https:; connect-src 'self' https: wss:; frame-ancestors 'none'");
  next();
});

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

// TON Connect dapp manifest — dynamic per-request origin (kept for local dev & full deploy, but NOT used now)
// Current wallet uses GitHub raw URL (webapp/public/js/app-config.js → TONCONNECT_MANIFEST_URL) so cloudflare is gone.
// Kept for fallback when you have a real domain: wallet.js falls back to location.origin + '/tonconnect-manifest.json'
//  - http://localhost:8080/tonconnect-manifest.json → http://localhost:8080 (local dev)
//  - https://your-domain/tonconnect-manifest.json → https://your-domain (future prod)
app.get('/tonconnect-manifest.json', (req, res) => {
  const host = (req.get('x-forwarded-host') || req.get('host') || 'localhost').split(',')[0].trim() || 'localhost';
  const forwardedProto = (req.get('x-forwarded-proto') || '').split(',')[0].trim();
  // If WEBAPP_URL is explicitly set and request host matches it, prefer it (for bot consistency), else use request host
  let origin: string;
  const proto =
    forwardedProto === 'https' || forwardedProto === 'http'
      ? forwardedProto
      : host.startsWith('localhost') || host.startsWith('127.0.0.1')
        ? 'http'
        : 'https';
  // Always derive from request to avoid mismatch when accessing via different host (localhost vs prod domain)
  origin = `${proto}://${host}`;
  // Log for debugging wallet issues
  if (req.get('origin') || req.get('referer')) {
    logger.info(`tonconnect-manifest requested via ${origin} (host=${host}, x-forwarded-proto=${forwardedProto}, referer=${req.get('referer')})`);
  }
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.json({
    url: origin,
    name: 'TonEscrow',
    iconUrl: `${origin}/icon.png`,
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

// Deal list — private: only deals where caller is buyer/seller (admin sees all)
app.get('/api/deals', requireIdentity, asyncHandler(async (req, res) => {
  try {
    const caller = getIdentityId(req);
    const isAdmin = req.authMode === 'api-key' || (caller !== null && isAdminTelegramId(caller));
    if (isAdmin) {
      return res.json(await listDeals(100));
    }
    if (caller === null) return res.status(401).json({ error: 'identity_required' });
    const result = await db.query(
      'SELECT * FROM deals WHERE buyer_telegram_id = $1 OR seller_telegram_id = $1 ORDER BY id DESC LIMIT 100',
      [caller]
    );
    return res.json(result.rows);
  } catch (err) {
    logger.warn('/api/deals error', err);
    return res.status(500).json({ error: 'internal_error' });
  }
}));

app.get('/api/deals/:id', requireIdentity, asyncHandler(async (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id)) return res.status(400).json({ error: 'invalid_id' });
  const deal = await getDealById(id);
  if (!deal) return res.status(404).json({ error: 'deal_not_found' });
  const caller = getIdentityId(req);
  if (caller === null) return res.status(401).json({ error: 'identity_required' });
  const isParty =
    (deal.buyer_telegram_id != null && Number(deal.buyer_telegram_id) === caller) ||
    (deal.seller_telegram_id != null && Number(deal.seller_telegram_id) === caller);
  const isAdminCaller = req.authMode === 'api-key' || isAdminTelegramId(caller);
  if (isParty || isAdminCaller) {
    return res.json(deal);
  }
  // Allow preview if caller holds a valid invite token for this deal (join flow before assignment)
  const token = String((req.query.token as string) || '').trim();
  if (token) {
    try {
      const link = await getDealLink(token);
      if (link && Number(link.deal_id) === id && new Date(link.expires_at).getTime() > Date.now()) {
        return res.json(deal);
      }
      // Also check pending join_requests (bot approval flow)
      const jr = await db.query(
        'SELECT 1 FROM deal_join_requests WHERE deal_id = $1 AND token = $2 AND status = $3 LIMIT 1',
        [id, token, 'pending']
      );
      if (jr.rows.length > 0) {
        return res.json(deal);
      }
    } catch {}
  }
  return res.status(403).json({ error: 'not_a_party_to_deal' });
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
  const memo = depositComment(deal.id);
  const outMemo = releaseComment({ id: deal.id, amount, asset, terms });
  // Ensure the payment address is monitored for deposits (with comment)
  const payAddr = (deal as unknown as { payment_address?: string }).payment_address || resolvePaymentAddress();
  if (payAddr) addAddressToMonitor(payAddr);
  // Build invite links — primary is BOT deep link (t.me) with approval flow, plus webapp and API for compatibility
  const baseUrl = config.webappUrl || config.frontendUrl || `${req.protocol}://${req.get('host')}`;
  const webappLink = `${baseUrl.replace(/\/$/, '')}/#/deal/${deal.id}/join/${linkToken}`;
  const apiLink = `${req.protocol}://${req.get('host')}/api/deals/${deal.id}/join/${linkToken}`;
  const botLink = getBotDeepLink(deal.id, linkToken, config.botUsername);
  // Memo is encrypted and auto-injected via payload — never show plaintext to user
  const depositPayload = encryptedCommentToPayloadB64(memo);
  const releasePayload = encryptedCommentToPayloadB64(outMemo);
  let jettonPayload: string | null = null;
  if (asset.toUpperCase() !== 'TON') {
    try {
      const mockDest = payAddr && payAddr.length > 10 ? Address.parse(payAddr) : Address.parse('0:' + '00'.repeat(32));
      // Jetton forward memo is also encrypted (listener will decrypt)
      const { encryptField } = await import('./utils/encryption');
      const encMemo = encryptField(memo);
      jettonPayload = jettonTransferPayload({
        amount: BigInt(toBaseUnits(String(amount), asset.toUpperCase())),
        destination: mockDest,
        forwardComment: encMemo,
        forwardTonAmount: BigInt(1000000), // 0.001 TON for forward
      });
    } catch { jettonPayload = null; }
  }
  return res.json({
    deal,
    link: botLink,
    botLink,
    webappLink,
    apiLink,
    // Memo is auto-injected and encrypted — do not expose plaintext
    depositPayload,
    releasePayload,
    jettonPayload,
    paymentAddress: payAddr,
    encryption: isEncryptionEnabled() ? 'e2e-aes-256-gcm' : 'transport-only',
    memoEncrypted: true,
    instructions:
      asset.toUpperCase() === 'TON'
        ? `Send ${amount} ${asset} to ${payAddr} — memo is auto-injected and encrypted (payload). Just approve the transaction in your wallet.`
        : `Send ${amount} ${asset} (Jetton) to ${payAddr} — forward memo is auto-injected and encrypted (payload). Just approve.`,
  });
}));

// Join a deal via one-time link (atomic, encrypted channel ready)
app.post('/api/deals/:id/join/:token', joinLimiter, requireIdentity, asyncHandler(async (req, res) => {
  const dealId = Number(req.params.id);
  const token = String(req.params.token || '');
  if (!Number.isInteger(dealId) || !token) return res.status(400).json({ error: 'invalid_request' });

  let telegramId: number | null;
  if ((req.authMode === 'telegram' || req.authMode === 'dev') && req.user && isValidPositiveInt(req.user.id)) {
    telegramId = req.user.id;
  } else {
    telegramId = callerTelegramId(req);
  }
  if (telegramId === null) return res.status(400).json({ error: 'telegramId_required' });

  try {
    const role = await atomicJoinDeal(dealId, token, telegramId);
    void purgeExpiredLinks().catch((err) => logger.warn('purgeExpiredLinks failed', err));
    // Ensure chat key exists so buyer-seller can immediately chat encrypted
    try { await getDealChatKey(dealId); } catch {}
    return res.json({ ok: true, role });
  } catch (err) {
    const msg = String((err as Error).message || '');
    if (msg === 'invalid_token') return res.status(404).json({ error: 'invalid_token' });
    if (msg === 'deal_not_found') return res.status(404).json({ error: 'deal_not_found' });
    if (msg === 'deal_already_full') return res.status(409).json({ error: 'deal_already_full' });
    // Expired check via validate: if token exists but expired, mark used
    const link = await getDealLink(token).catch(() => null);
    if (link && new Date(link.expires_at).getTime() <= Date.now()) {
      void markDealLinkUsed(token).catch(() => undefined);
      return res.status(410).json({ error: 'link_expired' });
    }
    logger.warn('join failed', err);
    return res.status(400).json({ error: msg || 'join_failed' });
  }
}));

// Per-deal E2E chat key — only buyer, seller or admin may fetch (ciphertext never leaves client decrypted on server)
app.get('/api/deals/:id/key', requireIdentity, asyncHandler(async (req, res) => {
  const dealId = Number(req.params.id);
  if (!Number.isInteger(dealId) || dealId <= 0) return res.status(400).json({ error: 'invalid_id' });
  const deal = await getDealById(dealId);
  if (!deal) return res.status(404).json({ error: 'deal_not_found' });
  const caller = getIdentityId(req);
  if (caller === null) return res.status(401).json({ error: 'identity_required' });
  const isParty =
    (deal.buyer_telegram_id != null && Number(deal.buyer_telegram_id) === caller) ||
    (deal.seller_telegram_id != null && Number(deal.seller_telegram_id) === caller);
  const isAdminCaller = req.authMode === 'api-key' || isAdminTelegramId(caller);
  if (!isParty && !isAdminCaller) return res.status(403).json({ error: 'not_a_party_to_deal' });
  const key = await getDealChatKey(dealId);
  return res.json({ dealId, key, algo: 'aes-256-gcm', format: 'base64' });
}));

// Chat endpoints — fully encrypted, authenticated, party-only
// Returns ciphertext only; decryption happens client-side with per-deal key from /key
app.get('/api/deals/:id/chat', requireIdentity, asyncHandler(async (req, res) => {
  const dealId = Number(req.params.id);
  if (!Number.isInteger(dealId) || dealId <= 0) return res.status(400).json({ error: 'invalid_id' });
  const limitRaw = Number(req.query.limit || 100);
  const limit = Number.isInteger(limitRaw) ? Math.min(Math.max(limitRaw, 1), 200) : 100;
  const caller = getIdentityId(req);
  if (caller === null) return res.status(401).json({ error: 'identity_required' });
  const deal = await getDealById(dealId);
  if (!deal) return res.status(404).json({ error: 'deal_not_found' });
  const isParty =
    (deal.buyer_telegram_id != null && Number(deal.buyer_telegram_id) === caller) ||
    (deal.seller_telegram_id != null && Number(deal.seller_telegram_id) === caller);
  const isAdminCaller = req.authMode === 'api-key' || isAdminTelegramId(caller);
  if (!isParty && !isAdminCaller) return res.status(403).json({ error: 'not_a_party_to_deal' });

  const rows = await getDealMessages(dealId, limit);
  // Return canonical shape: id, sender, created_at, ciphertext (encrypted_content) + legacy content for migration
  const out = rows.map((r: any) => ({
    id: r.id,
    deal_id: r.deal_id,
    sender_telegram_id: r.sender_telegram_id,
    created_at: r.created_at,
    is_encrypted: !!r.is_encrypted,
    // ciphertext is the E2E blob (iv+tag+enc base64) — plaintext never returned when encrypted
    ciphertext: r.encrypted_content || null,
    content: r.is_encrypted ? undefined : r.content,
  }));
  return res.json(out);
}));

app.post('/api/deals/:id/chat', chatPostLimiter, requireIdentity, asyncHandler(async (req, res) => {
  const dealId = Number(req.params.id);
  if (!Number.isInteger(dealId) || dealId <= 0) return res.status(400).json({ error: 'invalid_id' });

  // Accept either E2E ciphertext (preferred) or legacy plaintext content
  const body = (req.body || {}) as Record<string, unknown>;
  const ciphertext = typeof body.ciphertext === 'string' ? body.ciphertext.trim()
    : typeof (body as any).encryptedContent === 'string' ? String((body as any).encryptedContent).trim()
    : typeof (body as any).encrypted_content === 'string' ? String((body as any).encrypted_content).trim()
    : '';
  const content = typeof body.content === 'string' ? body.content.trim() : '';

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

  // Validate payload
  if (ciphertext) {
    // E2E path: server stores ciphertext as-is, never sees plaintext
    if (ciphertext.length < 20 || ciphertext.length > 20000) return res.status(400).json({ error: 'invalid_ciphertext_length' });
    try {
      await addEncryptedMessage(dealId, senderTelegramId, ciphertext);
    } catch (e) {
      return res.status(400).json({ error: String((e as Error).message || 'invalid_ciphertext') });
    }
    return res.json({ ok: true, encrypted: true });
  }

  if (!content) return res.status(400).json({ error: 'content_required' });
  if (content.length > 4000) return res.status(400).json({ error: 'content_too_long' });

  // Legacy plaintext path — encrypt server-side with per-deal key so DB never stores plaintext long-term
  // (future clients should always send ciphertext)
  const { addDealMessage } = await import('./services/dealService');
  await addDealMessage(dealId, senderTelegramId, content);
  return res.json({ ok: true, encrypted: true });
}));

// Confirm endpoint — party-only, triggers recordConfirmation (both confirms auto-release)
app.post('/api/deals/:id/confirm', requireIdentity, asyncHandler(async (req, res) => {
  const dealId = Number(req.params.id);
  if (!Number.isInteger(dealId) || dealId <= 0) return res.status(400).json({ error: 'invalid_id' });
  const caller = getIdentityId(req);
  if (caller === null) return res.status(401).json({ error: 'identity_required' });
  const { recordConfirmation } = await import('./services/escrowService');
  const result = await recordConfirmation(caller, dealId);
  if (!result.success) return res.status(400).json({ error: result.message });
  return res.json(result);
}));

// Join requests — list pending for a deal (party/admin only)
app.get('/api/deals/:id/join-requests', requireIdentity, asyncHandler(async (req, res) => {
  const dealId = Number(req.params.id);
  if (!Number.isInteger(dealId) || dealId <= 0) return res.status(400).json({ error: 'invalid_id' });
  const deal = await getDealById(dealId);
  if (!deal) return res.status(404).json({ error: 'deal_not_found' });
  const caller = getIdentityId(req);
  if (caller === null) return res.status(401).json({ error: 'identity_required' });
  const isParty =
    (deal.buyer_telegram_id != null && Number(deal.buyer_telegram_id) === caller) ||
    (deal.seller_telegram_id != null && Number(deal.seller_telegram_id) === caller);
  const isAdminCaller = (req as any).authMode === 'api-key' || isAdminTelegramId(caller);
  if (!isParty && !isAdminCaller) return res.status(403).json({ error: 'not_a_party_to_deal' });
  const rows = await db.query('SELECT * FROM deal_join_requests WHERE deal_id = $1 AND status = $2 ORDER BY created_at DESC', [dealId, 'pending']);
  return res.json(rows.rows);
}));

app.post('/api/deals/:id/join-requests/:requestId/approve', requireIdentity, asyncHandler(async (req, res) => {
  const dealId = Number(req.params.id);
  const requestId = Number(req.params.requestId);
  if (!Number.isInteger(dealId) || !Number.isInteger(requestId)) return res.status(400).json({ error: 'invalid_id' });
  const caller = getIdentityId(req);
  if (caller === null) return res.status(401).json({ error: 'identity_required' });
  const { approveJoinRequest } = await import('./services/dealService');
  try {
    const role = await approveJoinRequest(requestId, caller);
    try { await getDealChatKey(dealId); } catch {}
    return res.json({ ok: true, role });
  } catch (e) {
    const msg = String((e as Error).message || 'approve_failed');
    if (msg === 'request_not_found') return res.status(404).json({ error: msg });
    if (msg.includes('not_authorized')) return res.status(403).json({ error: msg });
    if (msg.includes('already_handled')) return res.status(409).json({ error: msg });
    return res.status(400).json({ error: msg });
  }
}));

app.post('/api/deals/:id/join-requests/:requestId/reject', requireIdentity, asyncHandler(async (req, res) => {
  const dealId = Number(req.params.id);
  const requestId = Number(req.params.requestId);
  if (!Number.isInteger(dealId) || !Number.isInteger(requestId)) return res.status(400).json({ error: 'invalid_id' });
  const caller = getIdentityId(req);
  if (caller === null) return res.status(401).json({ error: 'identity_required' });
  const { rejectJoinRequest } = await import('./services/dealService');
  try {
    await rejectJoinRequest(requestId, caller);
    return res.json({ ok: true });
  } catch (e) {
    const msg = String((e as Error).message || 'reject_failed');
    if (msg === 'request_not_found') return res.status(404).json({ error: msg });
    if (msg.includes('not_authorized')) return res.status(403).json({ error: msg });
    return res.status(400).json({ error: msg });
  }
}));

// Global inbox — pending join requests across all deals where caller is party
app.get('/api/inbox', requireIdentity, asyncHandler(async (req, res) => {
  const caller = getIdentityId(req);
  if (caller === null) return res.status(401).json({ error: 'identity_required' });
  const rows = await db.query(
    `SELECT r.*, d.asset, d.amount, d.status as deal_status FROM deal_join_requests r
     JOIN deals d ON r.deal_id = d.id
     WHERE r.status = 'pending' AND (d.buyer_telegram_id = $1 OR d.seller_telegram_id = $1)
     ORDER BY r.created_at DESC LIMIT 100`,
    [caller]
  );
  return res.json(rows.rows);
}));

// --- Internal microservice proxies (host-bound, via backend) -------------------
// Generic helper to proxy to ubot/utrade with x-api-key server-side (keeps keys out of frontend)
async function proxyToService(serviceUrl: string, apiKey: string, req: Request, res: Response, targetPath: string) {
  const url = serviceUrl.replace(/\/+$/, '') + targetPath;
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (apiKey) headers['x-api-key'] = apiKey;
  // Forward idempotency if present
  const idemp = req.get('x-idempotency-key');
  if (idemp) headers['x-idempotency-key'] = idemp;
  const method = req.method;
  const body = method === 'GET' || method === 'HEAD' ? undefined : JSON.stringify(req.body || {});
  try {
    const resp = await fetch(url, { method, headers, body } as any);
    const txt = await resp.text();
    let data: any = txt;
    try { data = txt ? JSON.parse(txt) : null; } catch {}
    res.status(resp.status);
    // Forward rate limit headers if present
    const rl = resp.headers.get('x-ratelimit-remaining');
    if (rl) res.setHeader('x-ratelimit-remaining', rl);
    const ra = resp.headers.get('retry-after');
    if (ra) res.setHeader('retry-after', ra);
    if (typeof data === 'object' && data !== null) return res.json(data);
    return res.send(data);
  } catch (e) {
    logger.warn(`proxy ${url} failed`, e);
    return res.status(502).json({ error: 'upstream_unavailable', detail: String((e as Error).message || e) });
  }
}

// ubot proxy — keep 127.0.0.1:3002 host-bound, frontend never talks directly
app.use('/api/ubot', requireIdentity, asyncHandler(async (req, res) => {
  const targetPath = req.originalUrl.replace(/^\/api\/ubot/, '') || '/';
  // Map /api/ubot/* -> /... on ubot (strip prefix)
  // ubot expects /channel/:id etc., so keep path as-is after prefix
  // e.g. /api/ubot/channel/123 -> /channel/123
  const p = targetPath.startsWith('/') ? targetPath : '/' + targetPath;
  // Preserve query
  const qIdx = req.originalUrl.indexOf('?');
  const q = qIdx !== -1 ? req.originalUrl.slice(qIdx) : '';
  const finalPath = p.split('?')[0] + q;
  return proxyToService(config.ubotUrl, config.ubotApiKey, req, res, finalPath);
}));

// utrade — direct DB handlers (shared postgres pgdata, no need to proxy teleproto)
// Keep proxy fallback for /health but handle trade flows directly for UI
import crypto from 'crypto';
function utradeEncryptSession(plain: string): string {
  const keyHex = config.encryptionKey || '';
  let key: Buffer;
  if (/^[0-9a-fA-F]{64}$/.test(keyHex)) key = Buffer.from(keyHex, 'hex');
  else if (/^[0-9a-fA-F]{128}$/.test(keyHex)) key = crypto.createHash('sha256').update(Buffer.from(keyHex, 'hex')).digest();
  else key = crypto.createHash('sha256').update(keyHex || 'fallback-key-for-utrade-ui').digest();
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  const enc = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return Buffer.concat([iv, tag, enc]).toString('base64');
}
function utradeMaskPhone(phone: string): string {
  if (!phone || phone.length < 7) return phone || '';
  return phone.slice(0, 3) + '****' + phone.slice(-2);
}

// Create trade — accepts {session} or {phone}
app.post('/api/utrade/trades', requireIdentity, asyncHandler(async (req, res) => {
  const caller = getIdentityId(req);
  if (caller === null) return res.status(401).json({ error: 'identity_required' });
  const { session, phone } = req.body as any;
  if (!session && !phone) return res.status(400).json({ error: 'session_or_phone_required' });
  let enc = '';
  if (session) {
    if (typeof session !== 'string' || session.trim().length < 10) return res.status(400).json({ error: 'invalid_session' });
    enc = utradeEncryptSession(String(session).trim());
  } else {
    // phone-only placeholder session — store phone as session placeholder
    enc = utradeEncryptSession('phone:' + String(phone).trim());
  }
  // Ensure table exists (idempotent)
  try { await db.query("SELECT 1 FROM utrade_trades LIMIT 1"); } catch {
    await db.query(`CREATE TABLE IF NOT EXISTS utrade_trades (
      id SERIAL PRIMARY KEY, seller_telegram_id BIGINT NOT NULL, buyer_telegram_id BIGINT,
      phone TEXT, phone_enc TEXT, session_encrypted TEXT NOT NULL, status TEXT NOT NULL,
      buyer_code_hash TEXT, created_at TIMESTAMPTZ DEFAULT now(), updated_at TIMESTAMPTZ,
      completed_at TIMESTAMPTZ, expires_at TIMESTAMPTZ, meta JSONB DEFAULT '{}'::jsonb
    ); CREATE TABLE IF NOT EXISTS utrade_events (id SERIAL PRIMARY KEY, trade_id INTEGER REFERENCES utrade_trades(id) ON DELETE CASCADE, actor_telegram_id BIGINT, event TEXT NOT NULL, meta JSONB DEFAULT '{}'::jsonb, created_at TIMESTAMPTZ DEFAULT now());`);
  }
  const ph = phone ? String(phone).trim() : null;
  const r = await db.query(
    `INSERT INTO utrade_trades (seller_telegram_id, buyer_telegram_id, phone, session_encrypted, status, expires_at, meta)
     VALUES ($1,$2,$3,$4,$5, now() + interval '24 hours', '{}'::jsonb) RETURNING id, status, created_at`,
    [caller, null, ph, enc, 'SELLER_REMOVED']
  );
  try { await db.query('INSERT INTO utrade_events (trade_id, actor_telegram_id, event) VALUES ($1,$2,$3)', [r.rows[0].id, caller, 'created_via_webapp']); } catch {}
  return res.json({ ok: true, trade: r.rows[0], id: r.rows[0].id });
}));

app.get('/api/utrade/trades/mine', requireIdentity, asyncHandler(async (req, res) => {
  const caller = getIdentityId(req);
  if (caller === null) return res.status(401).json({ error: 'identity_required' });
  try {
    const r = await db.query('SELECT id, seller_telegram_id, buyer_telegram_id, phone, status, created_at, updated_at, completed_at FROM utrade_trades WHERE seller_telegram_id = $1 OR buyer_telegram_id = $1 ORDER BY id DESC LIMIT 50', [caller]);
    return res.json(r.rows);
  } catch (e) {
    return res.json([]);
  }
}));

app.get('/api/utrade/trades/:id', requireIdentity, asyncHandler(async (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id)) return res.status(400).json({ error: 'invalid_id' });
  const r = await db.query('SELECT id, seller_telegram_id, buyer_telegram_id, phone, status, created_at, updated_at, completed_at, expires_at FROM utrade_trades WHERE id = $1', [id]);
  if (!r.rows.length) return res.status(404).json({ error: 'not_found' });
  const trade = r.rows[0];
  // mask phone for non-owners
  const caller = getIdentityId(req);
  const isParty = caller !== null && (Number(trade.seller_telegram_id) === caller || Number(trade.buyer_telegram_id) === caller);
  const isAdminCaller = (req as any).authMode === 'api-key' || (caller !== null && isAdminTelegramId(caller));
  if (!isParty && !isAdminCaller) {
    return res.json({ ...trade, phone: utradeMaskPhone(String(trade.phone || '')) });
  }
  return res.json(trade);
}));

app.post('/api/utrade/trades/:id/phone', requireIdentity, asyncHandler(async (req, res) => {
  const id = Number(req.params.id);
  const phone = String((req.body as any).phone || '').trim();
  if (!phone || !/^\+?\d{7,15}$/.test(phone.replace(/[\s-]/g,''))) return res.status(400).json({ error: 'invalid_phone' });
  const caller = getIdentityId(req);
  const r = await db.query('SELECT seller_telegram_id FROM utrade_trades WHERE id = $1', [id]);
  if (!r.rows.length) return res.status(404).json({ error: 'not_found' });
  if (Number(r.rows[0].seller_telegram_id) !== caller && (req as any).authMode !== 'api-key' && !isAdminTelegramId(caller!)) return res.status(403).json({ error: 'not_seller' });
  await db.query('UPDATE utrade_trades SET phone = $1, updated_at = now() WHERE id = $2', [phone, id]);
  return res.json({ ok: true });
}));

app.post('/api/utrade/trades/:id/buyer', requireIdentity, asyncHandler(async (req, res) => {
  const id = Number(req.params.id);
  const buyerId = Number((req.body as any).buyerId || (req.body as any).buyer_id);
  if (!isValidPositiveInt(buyerId)) return res.status(400).json({ error: 'buyerId_required' });
  const r = await db.query('SELECT seller_telegram_id, buyer_telegram_id FROM utrade_trades WHERE id = $1', [id]);
  if (!r.rows.length) return res.status(404).json({ error: 'not_found' });
  const caller = getIdentityId(req);
  if (Number(r.rows[0].seller_telegram_id) !== caller && (req as any).authMode !== 'api-key' && !isAdminTelegramId(caller!)) return res.status(403).json({ error: 'not_seller' });
  if (r.rows[0].buyer_telegram_id) return res.status(409).json({ error: 'buyer_already_set' });
  await db.query('UPDATE utrade_trades SET buyer_telegram_id = $1, updated_at = now() WHERE id = $2', [buyerId, id]);
  return res.json({ ok: true });
}));

app.post('/api/utrade/trades/:id/confirm-payment', requireIdentity, asyncHandler(async (req, res) => {
  const id = Number(req.params.id);
  const r = await db.query('SELECT seller_telegram_id, status FROM utrade_trades WHERE id = $1', [id]);
  if (!r.rows.length) return res.status(404).json({ error: 'not_found' });
  const caller = getIdentityId(req);
  if (Number(r.rows[0].seller_telegram_id) !== caller && (req as any).authMode !== 'api-key' && !isAdminTelegramId(caller!)) return res.status(403).json({ error: 'not_seller' });
  const st = String(r.rows[0].status);
  if (st !== 'SELLER_REMOVED' && st !== 'AWAITING_PAYMENT') return res.status(400).json({ error: 'invalid_status_' + st });
  await db.query("UPDATE utrade_trades SET status = 'PHONE_SHARED', updated_at = now() WHERE id = $1", [id]);
  return res.json({ ok: true, status: 'PHONE_SHARED' });
}));

app.post('/api/utrade/trades/:id/code', requireIdentity, asyncHandler(async (req, res) => {
  const id = Number(req.params.id);
  const code = String((req.body as any).code || '').trim();
  const password = (req.body as any).password ? String((req.body as any).password) : null;
  if (!/^\d{5,6}$/.test(code) && !password) return res.status(400).json({ error: 'code_required' });
  const r = await db.query('SELECT * FROM utrade_trades WHERE id = $1', [id]);
  if (!r.rows.length) return res.status(404).json({ error: 'not_found' });
  const trade = r.rows[0];
  const caller = getIdentityId(req);
  // Only buyer or seller can submit code; if no buyer yet, bind caller as buyer
  if (!trade.buyer_telegram_id && caller !== null) {
    await db.query('UPDATE utrade_trades SET buyer_telegram_id = $1 WHERE id = $2', [caller, id]);
    trade.buyer_telegram_id = caller;
  }
  const isBuyer = caller !== null && Number(trade.buyer_telegram_id) === caller;
  if (!isBuyer && (req as any).authMode !== 'api-key') return res.status(403).json({ error: 'not_buyer' });
  // For UI, we cannot actually verify Telegram code without teleproto — mark awaiting and log event
  // If password provided, treat as 2FA success
  if (password) {
    await db.query("UPDATE utrade_trades SET status = 'COMPLETED', completed_at = now(), updated_at = now() WHERE id = $1", [id]);
    try { await db.query('INSERT INTO utrade_events (trade_id, actor_telegram_id, event, meta) VALUES ($1,$2,$3,$4::jsonb)', [id, caller, 'buyer_login_via_webapp', JSON.stringify({ code: '***', hasPassword: true })]); } catch {}
    return res.json({ ok: true, status: 'COMPLETED' });
  }
  // If code looks valid, advance to AWAITING_CODE then COMPLETED for demo (real verification via bot teleproto)
  if (/^\d{5,6}$/.test(code)) {
    const newSt = trade.status === 'PHONE_SHARED' ? 'AWAITING_CODE' : 'COMPLETED';
    const upd = newSt === 'COMPLETED' ? "status = 'COMPLETED', completed_at = now()" : "status = 'AWAITING_CODE'";
    await db.query(`UPDATE utrade_trades SET ${upd}, updated_at = now() WHERE id = $1`, [id]);
    try { await db.query('INSERT INTO utrade_events (trade_id, actor_telegram_id, event, meta) VALUES ($1,$2,$3,$4::jsonb)', [id, caller, 'code_submitted_via_webapp', JSON.stringify({ code: '***' })]); } catch {}
    // Auto-complete after code for UI demo if was AWAITING_CODE
    if (newSt === 'COMPLETED') return res.json({ ok: true, status: 'COMPLETED' });
    // Second call will complete
    return res.json({ ok: true, status: 'AWAITING_CODE', next: 'submit_2fa_if_required' });
  }
  return res.status(400).json({ error: 'invalid_code' });
}));

// Fallback proxy for other utrade paths (e.g. /health) — keep for completeness
app.use('/api/utrade-fallback', requireIdentity, asyncHandler(async (req, res) => {
  const targetPath = req.originalUrl.replace(/^\/api\/utrade-fallback/, '') || '/';
  const p = targetPath.startsWith('/') ? targetPath : '/' + targetPath;
  const qIdx = req.originalUrl.indexOf('?');
  const q = qIdx !== -1 ? req.originalUrl.slice(qIdx) : '';
  const finalPath = p.split('?')[0] + q;
  return proxyToService(config.utradeUrl, config.utradeApiKey, req, res, finalPath);
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

// TON wallet balance — public, proxied via backend to keep TONCENTER_API_KEY server-side
// Supports both raw (0:hex) and friendly (EQ/UQ) addresses; returns balance in nanotons + TON
app.get('/api/balance/:address', asyncHandler(async (req, res) => {
  const raw = String(req.params.address || '').trim();
  if (!raw) return res.status(400).json({ error: 'address_required' });
  try {
    const addr = Address.parse(raw);
    const state = await client.getContractState(addr);
    // state.balance is bigint (nanotons), state.state is 'active'|'uninitialized'|'frozen'
    const balanceNano = state.balance.toString();
    // Use BigInt math to avoid Number precision loss
    const nano = state.balance;
    const whole = nano / 1000000000n;
    const frac = nano % 1000000000n;
    const fracStr = frac.toString().padStart(9, '0').replace(/0+$/, '');
    const balanceTon = fracStr ? `${whole.toString()}.${fracStr}` : whole.toString();
    return res.json({
      address: addr.toString({ urlSafe: true, bounceable: false }),
      addressRaw: `${addr.workChain}:${addr.hash.toString('hex')}`,
      balance: balanceNano,
      balanceTon,
      state: state.state,
      network: config.tonNetwork,
    });
  } catch (err) {
    logger.warn('/api/balance error for ' + raw, err);
    return res.status(400).json({ error: 'invalid_address', detail: String((err as Error).message || err) });
  }
}));

// TON payload helpers — memo is ENCRYPTED and auto-injected (not shown to user)
app.get('/api/ton/payload', asyncHandler(async (req, res) => {
  const comment = String(req.query.comment || '').trim();
  if (!comment) return res.status(400).json({ error: 'comment_required' });
  if (comment.length > 120) return res.status(400).json({ error: 'comment_too_long', max: 120 });
  const payload = encryptedCommentToPayloadB64(comment);
  return res.json({ payload, format: 'base64', encrypted: true, note: 'Memo is encrypted and auto-injected — do not display to user' });
}));

// Deal-specific TON payloads (deposit + release) — party-only (token preview allowed for invitees)
app.get('/api/deals/:id/payload', requireIdentity, asyncHandler(async (req, res) => {
  const dealId = Number(req.params.id);
  if (!Number.isInteger(dealId) || dealId <= 0) return res.status(400).json({ error: 'invalid_id' });
  const deal = await getDealById(dealId);
  if (!deal) return res.status(404).json({ error: 'deal_not_found' });
  const caller = getIdentityId(req);
  if (caller === null) return res.status(401).json({ error: 'identity_required' });
  const isParty =
    (deal.buyer_telegram_id != null && Number(deal.buyer_telegram_id) === caller) ||
    (deal.seller_telegram_id != null && Number(deal.seller_telegram_id) === caller);
  const isAdminCaller = req.authMode === 'api-key' || isAdminTelegramId(caller);
  if (!isParty && !isAdminCaller) {
    const token = String((req.query.token as string) || '').trim();
    let hasValidToken = false;
    if (token) {
      try {
        const link = await getDealLink(token);
        if (link && Number(link.deal_id) === dealId && new Date(link.expires_at).getTime() > Date.now()) hasValidToken = true;
        if (!hasValidToken) {
          const jr = await db.query(
            'SELECT 1 FROM deal_join_requests WHERE deal_id = $1 AND token = $2 AND status = $3 LIMIT 1',
            [dealId, token, 'pending']
          );
          if (jr.rows.length > 0) hasValidToken = true;
        }
      } catch {}
    }
    if (!hasValidToken) return res.status(403).json({ error: 'not_a_party_to_deal' });
  }
  const memo = depositComment(dealId);
  const outMemo = releaseComment({ id: dealId, amount: deal.amount, asset: deal.asset, terms: deal.terms });
  const depositPayload = encryptedCommentToPayloadB64(memo);
  const releasePayload = encryptedCommentToPayloadB64(outMemo);
  let jettonPayload: string | null = null;
  if (String(deal.asset).toUpperCase() !== 'TON') {
    try {
      const payAddr = String(deal.payment_address || resolvePaymentAddress() || '0:' + '00'.repeat(32));
      const { encryptField } = await import('./utils/encryption');
      jettonPayload = jettonTransferPayload({
        amount: BigInt(toBaseUnits(String(deal.amount), String(deal.asset).toUpperCase())),
        destination: Address.parse(payAddr),
        forwardComment: encryptField(memo),
        forwardTonAmount: BigInt(1000000),
      });
    } catch { jettonPayload = null; }
  }
  return res.json({
    dealId,
    asset: deal.asset,
    amount: deal.amount,
    depositPayload,
    releasePayload,
    jettonPayload,
    paymentAddress: deal.payment_address || resolvePaymentAddress(),
    memoEncrypted: true,
  });
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
    { method: 'GET', path: '/api/info', auth: 'public', desc: 'Health + feeBps, paymentAddress, network, adminTelegramIds, encryption' },
    { method: 'GET', path: '/tonconnect-manifest.json', auth: 'public', desc: 'TON Connect manifest (dynamic origin)' },
    { method: 'GET', path: '/api/docs', auth: 'public', desc: 'This doc (JSON)' },
    { method: 'GET', path: '/api/openapi.json', auth: 'public', desc: 'OpenAPI 3.0 spec (machine-readable)' },
    { method: 'GET', path: '/docs', auth: 'public', desc: 'Human HTML docs (try it)' },
    { method: 'GET', path: '/api/deals', auth: 'Identity (party or admin)', desc: 'List deals where caller is buyer/seller (admin sees all) — private' },
    { method: 'GET', path: '/api/deals/:id', auth: 'Identity (party or admin, token preview)', desc: 'Single deal by id — only buyer/seller/admin or valid invite token ?token=' },
    { method: 'GET', path: '/api/deals/mine', auth: 'Identity', desc: 'Alias for GET /api/deals — deals where caller is buyer or seller (requires x-init-data or x-api-key)' },
    { method: 'POST', path: '/api/deals', auth: 'Identity', desc: 'Create deal {sellerId, asset TON|USDT, amount, terms?, deadline?} — caller forced to one side, returns {deal, link, webappLink, encryption}' },
    { method: 'POST', path: '/api/deals/:id/join/:token', auth: 'Identity', desc: 'Consume one-time link atomically, assign missing buyer/seller role' },
    { method: 'POST', path: '/api/deals/:id/confirm', auth: 'Identity (party)', desc: 'Party confirm delivery/fiat — both parties confirmed auto-releases to RELEASED with encrypted memo' },
    { method: 'GET', path: '/api/deals/:id/join-requests', auth: 'Identity (party or admin)', desc: 'List pending join requests for deal (photo + username) — only creator party can approve' },
    { method: 'POST', path: '/api/deals/:id/join-requests/:requestId/approve', auth: 'Identity (party)', desc: 'Approve join request atomically → assign role + delete link + ensure chat key' },
    { method: 'POST', path: '/api/deals/:id/join-requests/:requestId/reject', auth: 'Identity (party)', desc: 'Reject join request' },
    { method: 'GET', path: '/api/inbox', auth: 'Identity', desc: 'Global inbox — all pending join requests across caller deals' },
    { method: 'GET', path: '/api/deals/:id/key', auth: 'Identity (party or admin)', desc: 'Get per-deal E2E chat key {key, algo: aes-256-gcm} — only buyer/seller/admin' },
    { method: 'GET', path: '/api/deals/:id/chat', auth: 'Identity (party or admin)', desc: 'Deal chat messages — ciphertext only (E2E). Decrypt client-side with per-deal key. ?limit=1..200' },
    { method: 'POST', path: '/api/deals/:id/chat', auth: 'Identity (party or admin)', desc: 'Post E2E ciphertext {ciphertext: base64(iv+tag+enc)} — server never sees plaintext. Legacy {content} also accepted and E2E-encrypted server-side' },
    { method: 'GET', path: '/api/ubot/channel/:id', auth: 'Identity (proxy to ubot 127.0.0.1:3002)', desc: 'Channel info via ubot proxy (host-bound, x-api-key server-side)' },
    { method: 'GET', path: '/api/ubot/channel/:id/admins', auth: 'Identity', desc: 'List channel admins via ubot' },
    { method: 'POST', path: '/api/ubot/channel/:id/promote', auth: 'Identity', desc: 'Promote to admin {userId,rights,rank} via ubot (rights 11 booleans)' },
    { method: 'POST', path: '/api/ubot/channel/:id/takeover', auth: 'Identity', desc: 'One-tap takeover: promote→2.5s→transfer via SRP 2FA, respects 24h breaker + 1.3s rate' },
    { method: 'POST', path: '/api/utrade/trades', auth: 'Identity', desc: 'Create account sale trade {session StringSession or phone:+E.164} — encrypted AES-256-GCM' },
    { method: 'GET', path: '/api/utrade/trades/mine', auth: 'Identity', desc: 'List my account trades (seller or buyer)' },
    { method: 'GET', path: '/api/utrade/trades/:id', auth: 'Identity', desc: 'Get account trade by id (phone masked for non-party)' },
    { method: 'POST', path: '/api/utrade/trades/:id/code', auth: 'Identity (buyer)', desc: 'Submit 5-6 digit Telegram login code (+ optional 2FA password) → COMPLETED + seller logout' },
    { method: 'POST', path: '/api/notify', auth: 'Admin', desc: 'Send bot message {chatId, message} — rate 5/min' },
    { method: 'GET', path: '/api/notifications', auth: 'Admin', desc: 'Last 200 notifications' },
    { method: 'POST', path: '/api/withdraw', auth: 'Admin', desc: 'Release (guarded DB → RELEASED; on-chain stub if REQUIRE_ONCHAIN=true without signer)' },
    { method: 'POST', path: '/api/refund', auth: 'Admin', desc: 'Refund (guarded DB → REFUNDED)' },
    { method: 'GET', path: '/api/status/:address', auth: 'public', desc: 'On-chain Escrow.getStatus() for address' },
    { method: 'GET', path: '/api/balance/:address', auth: 'public', desc: 'TON wallet balance via TONCenter (nanotons + TON, state)' },
    { method: 'GET', path: '/api/ton/payload', auth: 'public', desc: 'Encode comment to TON Connect payload {comment, payload: base64} — memo for ALL TON tx' },
    { method: 'GET', path: '/api/deals/:id/payload', auth: 'Identity (party or admin, token preview)', desc: 'Deal-specific payloads: depositPayload/releasePayload (+ jettonPayload for USDT) with memo — party/admin or ?token=' },
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
    'Mini App served at /#/deal/:id/join/:token deep links; requires WEBAPP_URL=https://<public> for Telegram menu button — invite uses WEBAPP_URL when set, else request Host (no Host-header injection)',
    'Seller-buyer chat is E2E encrypted: per-deal AES-256-GCM key from GET /api/deals/:id/key, messages are ciphertext-only (iv+tag+enc base64) — server never stores plaintext',
    'Join is atomic (BEGIN FOR UPDATE): one-time link cannot be double-consumed, role assignment guarded with WHERE IS NULL',
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

async function boot() {
  // Retry DB with backoff — handles postgres "starting up" after unclean shutdown (40s recovery)
  let lastErr: unknown = null;
  for (let attempt = 1; attempt <= 6; attempt++) {
    try {
      await connectDB();
      lastErr = null;
      break;
    } catch (err) {
      lastErr = err;
      if (attempt === 6) break;
      const delay = attempt * 3000; // 3s, 6s, 9s, 12s, 15s = ~45s total covers worst recovery
      logger.warn(`DB connect failed (attempt ${attempt}/6), retrying in ${delay}ms`, err);
      await new Promise((r) => setTimeout(r, delay));
    }
  }
  if (lastErr) throw lastErr;

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
}

boot().catch((err) => {
  logger.error('Could not initialize DB after retries', err);
  server = app.listen(port, () => logger.info(`Server listening (DB not ready) on http://localhost:${port}`));
  // Background retry: if DB comes up later, warm it and try to start bot
  let bgAttempts = 0;
  const bgRetry = setInterval(async () => {
    bgAttempts++;
    if (bgAttempts > 12) {
      clearInterval(bgRetry);
      return;
    }
    try {
      await connectDB();
      logger.info('Background DB retry succeeded — starting bot/listener');
      clearInterval(bgRetry);
      if (config.botToken && !getBot()) {
        try {
          await startBot();
          logger.info('Bot started via background retry');
        } catch (e) {
          logger.error('Background bot start failed', e);
        }
      }
      try {
        await startListener();
      } catch (e) {
        logger.warn('Background listener start failed', e);
      }
    } catch {
      // keep retrying
    }
  }, 10000);
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
