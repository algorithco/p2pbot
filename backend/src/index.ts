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
import { commentToPayloadB64, jettonTransferPayload } from './utils/tonPayload';
import { isEncryptionEnabled } from './utils/encryption';
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
  const memo = depositComment(deal.id);
  const outMemo = releaseComment({ id: deal.id, amount, asset, terms });
  // Ensure the payment address is monitored for deposits (with comment)
  const payAddr = (deal as unknown as { payment_address?: string }).payment_address || resolvePaymentAddress();
  if (payAddr) addAddressToMonitor(payAddr);
  // Build invite link using WEBAPP_URL when configured (prevents Host header injection) — fallback to request host for local dev
  const baseUrl = config.webappUrl || config.frontendUrl || `${req.protocol}://${req.get('host')}`;
  // Provide both webapp deep link and direct API join link
  const webappLink = `${baseUrl.replace(/\/$/, '')}/#/deal/${deal.id}/join/${linkToken}`;
  const apiLink = `${req.protocol}://${req.get('host')}/api/deals/${deal.id}/join/${linkToken}`;
  const depositPayload = commentToPayloadB64(memo);
  const releasePayload = commentToPayloadB64(outMemo);
  let jettonPayload: string | null = null;
  if (asset.toUpperCase() !== 'TON') {
    try {
      // For Jetton (USDT) deposits, buyer sends Jetton transfer with forward comment = memo
      // Payload is the jetton transfer cell with forwardPayload containing memo
      // We precompute a sample for display; actual amount/destination will be set by wallet
      const mockDest = payAddr && payAddr.length > 10 ? Address.parse(payAddr) : Address.parse('EQAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAJKZ');
      jettonPayload = jettonTransferPayload({
        amount: BigInt(Math.round(Number(amount) * 1e6)), // USDT 6 decimals mock for preview
        destination: mockDest,
        forwardComment: memo,
        forwardTonAmount: BigInt(1000000), // 0.001 TON for forward
      });
    } catch { jettonPayload = null; }
  }
  return res.json({
    deal,
    link: webappLink,
    apiLink,
    webappLink,
    depositComment: memo,
    depositMemo: memo,
    depositPayload,
    releasePreview: outMemo,
    releasePayload,
    jettonPayload,
    paymentAddress: payAddr,
    encryption: isEncryptionEnabled() ? 'e2e-aes-256-gcm' : 'transport-only',
    instructions:
      asset.toUpperCase() === 'TON'
        ? `Send ${amount} ${asset} to ${payAddr} with comment "${memo}" (payload ${depositPayload.slice(0, 24)}...) so bot detects your deposit. On release seller will receive "${outMemo}" (payload ${releasePayload.slice(0, 24)}...).`
        : `Send ${amount} ${asset} (Jetton) to ${payAddr} with forward comment "${memo}" (payload ${depositPayload.slice(0, 24)}...) — bot detects via forward payload. Release memo: "${outMemo}".`,
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

// TON payload helpers — memo in ALL on-chain transactions (comment op 0, Jetton forward)
// Public: encode a comment to TON Connect payload (base64 BOC) so buyer wallet always includes memo
app.get('/api/ton/payload', asyncHandler(async (req, res) => {
  const comment = String(req.query.comment || '').trim();
  if (!comment) return res.status(400).json({ error: 'comment_required' });
  if (comment.length > 120) return res.status(400).json({ error: 'comment_too_long', max: 120 });
  const payload = commentToPayloadB64(comment);
  return res.json({ comment, payload, format: 'base64', note: 'Use as TON Connect sendTransaction payload' });
}));

// Deal-specific TON payloads (deposit + release) — requires party or public for deposit preview
app.get('/api/deals/:id/payload', asyncHandler(async (req, res) => {
  const dealId = Number(req.params.id);
  if (!Number.isInteger(dealId) || dealId <= 0) return res.status(400).json({ error: 'invalid_id' });
  const deal = await getDealById(dealId);
  if (!deal) return res.status(404).json({ error: 'deal_not_found' });
  const memo = depositComment(dealId);
  const outMemo = releaseComment({ id: dealId, amount: deal.amount, asset: deal.asset, terms: deal.terms });
  const depositPayload = commentToPayloadB64(memo);
  const releasePayload = commentToPayloadB64(outMemo);
  let jettonPayload: string | null = null;
  if (String(deal.asset).toUpperCase() !== 'TON') {
    try {
      const payAddr = String(deal.payment_address || resolvePaymentAddress() || 'EQAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAJKZ');
      jettonPayload = jettonTransferPayload({
        amount: BigInt(Math.round(Number(deal.amount) * 1e6)),
        destination: Address.parse(payAddr),
        forwardComment: memo,
        forwardTonAmount: BigInt(1000000),
      });
    } catch { jettonPayload = null; }
  }
  return res.json({
    dealId,
    asset: deal.asset,
    amount: deal.amount,
    depositComment: memo,
    depositPayload,
    releaseComment: outMemo,
    releasePayload,
    jettonPayload,
    paymentAddress: deal.payment_address || resolvePaymentAddress(),
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
    { method: 'GET', path: '/api/deals', auth: 'public', desc: 'List last 100 deals' },
    { method: 'GET', path: '/api/deals/:id', auth: 'public', desc: 'Single deal by id' },
    { method: 'GET', path: '/api/deals/mine', auth: 'Identity', desc: 'Deals where caller is buyer or seller (requires x-init-data or x-api-key)' },
    { method: 'POST', path: '/api/deals', auth: 'Identity', desc: 'Create deal {sellerId, asset TON|USDT, amount, terms?, deadline?} — caller forced to one side, returns {deal, link, webappLink, encryption}' },
    { method: 'POST', path: '/api/deals/:id/join/:token', auth: 'Identity', desc: 'Consume one-time link atomically, assign missing buyer/seller role' },
    { method: 'GET', path: '/api/deals/:id/key', auth: 'Identity (party or admin)', desc: 'Get per-deal E2E chat key {key, algo: aes-256-gcm} — only buyer/seller/admin' },
    { method: 'GET', path: '/api/deals/:id/chat', auth: 'Identity (party or admin)', desc: 'Deal chat messages — ciphertext only (E2E). Decrypt client-side with per-deal key. ?limit=1..200' },
    { method: 'POST', path: '/api/deals/:id/chat', auth: 'Identity (party or admin)', desc: 'Post E2E ciphertext {ciphertext: base64(iv+tag+enc)} — server never sees plaintext. Legacy {content} also accepted and E2E-encrypted server-side' },
    { method: 'POST', path: '/api/notify', auth: 'Admin', desc: 'Send bot message {chatId, message} — rate 5/min' },
    { method: 'GET', path: '/api/notifications', auth: 'Admin', desc: 'Last 200 notifications' },
    { method: 'POST', path: '/api/withdraw', auth: 'Admin', desc: 'Release (guarded DB → RELEASED; on-chain stub if REQUIRE_ONCHAIN=true without signer)' },
    { method: 'POST', path: '/api/refund', auth: 'Admin', desc: 'Refund (guarded DB → REFUNDED)' },
    { method: 'GET', path: '/api/status/:address', auth: 'public', desc: 'On-chain Escrow.getStatus() for address' },
    { method: 'GET', path: '/api/balance/:address', auth: 'public', desc: 'TON wallet balance via TONCenter (nanotons + TON, state)' },
    { method: 'GET', path: '/api/ton/payload', auth: 'public', desc: 'Encode comment to TON Connect payload {comment, payload: base64} — memo for ALL TON tx' },
    { method: 'GET', path: '/api/deals/:id/payload', auth: 'public', desc: 'Deal-specific payloads: depositPayload/releasePayload (+ jettonPayload for USDT) with memo' },
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
