import express, { Request, Response, NextFunction } from 'express';
import { createHmac, timingSafeEqual, randomUUID } from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { config } from './config';
import logger, { redactSecrets } from './logger';
import { ensureClient, isGlobalFlooded, isChannelBlocked, getGlobalFloodUntil, sleep, channelBreakers } from './client';
import { promoteToAdmin, transferChannelOwnership, getChannelInfo, listChannelAdmins } from './channelService';
import { promoteGroupAdmin, transferGroupOwnership, isBasicGroup, migrateToSupergroup, addGroupMember } from './groupService';
// helmet/cors are optional at compile-time — fallback to no-op if not installed
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let helmet: any = null;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let cors: any = null;
try {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  helmet = require('helmet');
} catch {
  helmet = null;
}
try {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  cors = require('cors');
} catch {
  cors = null;
}

const TIMING_PEPPER = 'ubot::timing-safe-compare::v1';
function timingSafeStringEqual(a: string, b: string): boolean {
  const ha = createHmac('sha256', TIMING_PEPPER).update(String(a)).digest();
  const hb = createHmac('sha256', TIMING_PEPPER).update(String(b)).digest();
  return timingSafeEqual(ha, hb);
}

function isValidId(v: unknown): boolean {
  if (v === undefined || v === null) return false;
  const s = String(v).trim();
  if (!s) return false;
  if (s.length > 64) return false;
  // Allow @username, -100... channel id, or numeric id
  return /^(@?[A-Za-z0-9_]+|-?\d+)$/.test(s);
}

function mapTelegramError(err: unknown): { status: number; error: string; retryAfter?: number } {
  const raw = (err as Error)?.message ?? (err as { errorMessage?: string })?.errorMessage ?? String(err);
  const msg = String(raw);

  function parseRetryAfter(): number | undefined {
    let m: RegExpMatchArray | null;
    // Most specific first
    m = msg.match(/FLOOD_WAIT_(\d+)/i);
    if (m) return parseInt(m[1], 10);
    m = msg.match(/FLOOD_PREMIUM_WAIT_(\d+)/i);
    if (m) return parseInt(m[1], 10);
    m = msg.match(/SLOWMODE_WAIT_(\d+)/i);
    if (m) return parseInt(m[1], 10);
    m = msg.match(/TAKEOUT_INIT_DELAY_(\d+)/i);
    if (m) return parseInt(m[1], 10);
    m = msg.match(/(?:SESSION_TOO_FRESH|PASSWORD_TOO_FRESH)_(\d+)/i);
    if (m) return parseInt(m[1], 10);
    // Generic seconds patterns
    m = msg.match(/(\d+)\s*seconds/i);
    if (m) return parseInt(m[1], 10);
    m = msg.match(/wait of (\d+) seconds/i);
    if (m) return parseInt(m[1], 10);
    m = msg.match(/retry after (\d+)/i);
    if (m) return parseInt(m[1], 10);
    // Fallback seconds property on error object
    const sec = (err as { seconds?: unknown })?.seconds;
    if (typeof sec === 'number' && Number.isFinite(sec) && sec > 0) return sec;
    const sec2 = (err as { errorMessage?: unknown } as Record<string, unknown>)?.seconds;
    if (typeof sec2 === 'number' && Number.isFinite(sec2) && (sec2 as number) > 0) return sec2 as number;
    return undefined;
  }

  // Auth / revoked
  if (/not_authorized|AuthKeyUnregistered|AuthKeyDuplicated|SESSION_REVOKED|USER_DEACTIVATED|AUTH_KEY_DUPLICATED|AuthKeyNotFound|AUTH_KEY_UNREGISTERED/i.test(msg)) {
    return { status: 401, error: msg };
  }
  if (/channel_not_found|chat_not_found|USERNAME_INVALID|USERNAME_NOT_OCCUPIED|CHAT_INVALID|No entity/i.test(msg)) {
    return { status: 404, error: msg };
  }
  if (/user_not_found|new_owner_not_found|USER_ID_INVALID|USER_NOT_MUTUAL_CONTACT/i.test(msg)) {
    return { status: 404, error: msg };
  }
  if (/not_admin|CHAT_ADMIN_REQUIRED|CHANNEL_PRIVATE|CHAT_WRITE_FORBIDDEN|PRIVACY_RESTRICTED/i.test(msg)) {
    return { status: 403, error: msg };
  }

  // Flood / 429 family — must include all ban-risk errors
  const isFloodLike =
    /FLOOD_WAIT|FLOOD_PREMIUM_WAIT|PEER_FLOOD|USER_FLOOD|PHONE_NUMBER_FLOOD|FRESH_CHANGE_ADMINS_FORBIDDEN|admin_change_forbidden|SLOWMODE_WAIT|SlowModeWait|TAKEOUT_INIT_DELAY|TakeoutInitDelay|CHANNELS_TOO_MUCH|ChannelsTooMuch|USERS_TOO_MUCH|SESSION_TOO_FRESH|PASSWORD_TOO_FRESH|FloodWait|FloodError/i.test(
      msg
    );

  if (isFloodLike) {
    const parsed = parseRetryAfter();
    let retryAfter = parsed;
    if (!retryAfter) {
      if (/FRESH_CHANGE_ADMINS_FORBIDDEN/i.test(msg)) retryAfter = 86400;
      else if (/PEER_FLOOD/i.test(msg)) retryAfter = 86400;
      else if (/PHONE_NUMBER_FLOOD/i.test(msg)) retryAfter = 86400;
      else if (/USER_FLOOD/i.test(msg)) retryAfter = 86400;
      else if (/CHANNELS_TOO_MUCH|USERS_TOO_MUCH/i.test(msg)) retryAfter = 3600;
      else if (/SLOWMODE_WAIT/i.test(msg)) retryAfter = 60;
      else if (/TAKEOUT_INIT_DELAY/i.test(msg)) retryAfter = 30;
      else retryAfter = 30;
    }
    const ra = retryAfter ?? 30;
    // Ensure PEER_FLOOD and others map to 429 not 500
    return { status: 429, error: `FloodWait: retry after ${ra}s — ${msg}`, retryAfter: ra };
  }

  // Also catch generic FloodWait via seconds property even if string didn't match
  const secsFromObj = parseRetryAfter();
  if (secsFromObj !== undefined && /FloodWaitError|FloodWait/i.test(msg)) {
    return { status: 429, error: `FloodWait: retry after ${secsFromObj}s — ${msg}`, retryAfter: secsFromObj };
  }

  if (/PASSWORD_HASH_INVALID|2FA|SESSION_PASSWORD_NEEDED|SRP_ID_INVALID|PASSWORD_EMPTY/i.test(msg)) {
    return { status: 401, error: msg };
  }
  if (/RANK_INVALID|RIGHTS_INVALID|rank too long|userId required|newOwnerId required/i.test(msg)) {
    return { status: 400, error: msg };
  }
  return { status: 500, error: msg };
}

// --- rate limiting ---
type LimiterEntry = { opts: { windowMs: number; max: number; name: string }; hits: Map<string, number[]> };
const limiterRegistry = new Map<string, LimiterEntry>();

function rateLimit(opts: { windowMs: number; max: number; name: string }) {
  const hits = new Map<string, number[]>();
  limiterRegistry.set(opts.name, { opts, hits });
  return (req: Request, res: Response, next: NextFunction) => {
    const now = Date.now();
    if (hits.size > 5000) {
      for (const [k, times] of hits) {
        const alive = times.filter((t) => now - t < opts.windowMs);
        if (alive.length === 0) hits.delete(k);
        else hits.set(k, alive);
      }
    }
    const ip = req.ip || (req.socket?.remoteAddress as string) || 'unknown';
    let apiKeyPart = 'anon';
    if (config.apiKey) {
      const rawKey = (req.headers['x-api-key'] as string) || (req.headers['x-ubot-key'] as string) || '';
      if (rawKey) {
        // HMAC (keyed) to avoid storing raw secrets in map keys — not a bare hash
        apiKeyPart = createHmac('sha256', TIMING_PEPPER).update(String(rawKey)).digest('hex').slice(0, 12);
      } else {
        apiKeyPart = 'no-key';
      }
    }
    const key = `${ip}|${apiKeyPart}|${opts.name}`;
    const times = (hits.get(key) || []).filter((t) => now - t < opts.windowMs);
    const limit = opts.max;
    const remaining = Math.max(0, limit - times.length);
    // Always set X-RateLimit headers
    res.setHeader('X-RateLimit-Limit', String(limit));
    res.setHeader('X-RateLimit-Remaining', String(Math.max(0, remaining - 1 >= 0 ? remaining - 1 : 0)));
    // For remaining calculation after this request, we set to max - (times.length+1)
    // But we set before check to simplify; update after push below
    const resetTs = times.length > 0 ? times[0] + opts.windowMs : now + opts.windowMs;
    res.setHeader('X-RateLimit-Reset', String(Math.ceil(resetTs / 1000)));

    if (times.length >= opts.max) {
      const retryAfter = Math.max(1, Math.ceil((times[0] + opts.windowMs - now) / 1000));
      res.setHeader('Retry-After', String(retryAfter));
      res.setHeader('X-RateLimit-Remaining', '0');
      return res.status(429).json({ error: 'rate_limited', retryAfter, limit, windowMs: opts.windowMs });
    }
    times.push(now);
    hits.set(key, times);
    // update remaining after push
    res.setHeader('X-RateLimit-Remaining', String(Math.max(0, limit - times.length)));
    res.setHeader('X-RateLimit-Reset', String(Math.ceil((times[0] + opts.windowMs) / 1000)));
    next();
  };
}

// --- idempotency for takeover (24h) ---
const IDEMPOTENCY_TTL = 24 * 60 * 60 * 1000;
type IdemEntry = { ts: number; status: number; body: unknown };
const idempotencyStore = new Map<string, IdemEntry>();

function getIdempotencyKey(req: Request): string | null {
  const k = req.headers['x-idempotency-key'] as string | undefined;
  if (!k) return null;
  const trimmed = String(k).trim();
  if (!trimmed || trimmed.length > 128) return null;
  // scope to method+path+param id to avoid cross-channel reuse
  const idPart = (req.params as Record<string, string>).id ? `|${String((req.params as Record<string, string>).id)}` : '';
  return `${req.method}:${req.path}${idPart}:${trimmed}`;
}

function getIdempotencyHit(key: string): IdemEntry | null {
  const v = idempotencyStore.get(key);
  if (!v) return null;
  if (Date.now() - v.ts > IDEMPOTENCY_TTL) {
    idempotencyStore.delete(key);
    return null;
  }
  return v;
}

function setIdempotency(key: string, status: number, body: unknown): void {
  idempotencyStore.set(key, { ts: Date.now(), status, body });
  if (idempotencyStore.size > 2000) {
    const now = Date.now();
    for (const [k, v] of idempotencyStore) {
      if (now - v.ts > IDEMPOTENCY_TTL) idempotencyStore.delete(k);
    }
    if (idempotencyStore.size > 2000) {
      const keys = Array.from(idempotencyStore.keys()).slice(0, 500);
      for (const k of keys) idempotencyStore.delete(k);
    }
  }
}

// --- me cache for /health/verified (60s) ---
let meCache: { ts: number; data: { id: number; username?: string } } | null = null;
const ME_CACHE_TTL = 60_000;

function hasSessionFile(): boolean {
  try {
    const p1 = path.resolve(__dirname, '..', 'sessions', 'ubot.session.enc');
    const p2 = path.resolve(process.cwd(), 'sessions', 'ubot.session.enc');
    // also support SESSIONS_DIR from sessionManager constant location: same as p1
    return fs.existsSync(p1) || fs.existsSync(p2);
  } catch {
    return false;
  }
}

export function createApi() {
  const app = express();

  // helmet (fallback no-op if not installed) — imported at top via dynamic require
  let helmetMw: (req: Request, res: Response, next: NextFunction) => void = (_req, _res, next) => next();
  try {
    const fn = helmet?.default || helmet;
    if (typeof fn === 'function') {
      helmetMw = fn({ crossOriginEmbedderPolicy: false, hsts: config.isProduction ? { maxAge: 31536000 } : false });
    } else if (helmet) {
      // helmet may be the middleware factory itself
      const maybe = helmet as unknown as (opts?: unknown) => (req: Request, res: Response, next: NextFunction) => void;
      if (typeof maybe === 'function') helmetMw = maybe({ crossOriginEmbedderPolicy: false });
    }
  } catch {
    helmetMw = (_req, _res, next) => next();
  }
  app.use(helmetMw);

  // cors: allow frontend origin if set, otherwise reflect origin but no credentials (internal)
  let corsMw: (req: Request, res: Response, next: NextFunction) => void = (_req, _res, next) => next();
  try {
    const fn = cors?.default || cors;
    if (typeof fn === 'function') {
      const allowed = process.env.FRONTEND_URL || process.env.WEBAPP_URL;
      corsMw = allowed
        ? fn({ origin: [allowed, 'http://localhost:8080', 'http://127.0.0.1:8080'], credentials: false })
        : fn({ origin: true, credentials: false });
    }
  } catch {
    corsMw = (_req, _res, next) => next();
  }
  app.use(corsMw);

  app.use(express.json({ limit: '256kb' }));
  app.set('trust proxy', 'loopback');

  // morgan-like request logger with reqId
  app.use((req: Request, res: Response, next: NextFunction) => {
    const reqId = randomUUID();
    (req as unknown as Record<string, unknown>).reqId = reqId;
    res.setHeader('X-Request-Id', String(reqId));
    const start = Date.now();
    res.on('finish', () => {
      const ms = Date.now() - start;
      const ua = (req.headers['user-agent'] as string) || '-';
      logger.info(`${req.method} ${req.originalUrl} ${res.statusCode} ${ms}ms`, {
        reqId,
        ip: req.ip || req.socket?.remoteAddress,
        ua: String(ua).slice(0, 120),
      });
    });
    next();
  });

  const healthLimiter = rateLimit({ windowMs: 60_000, max: 60, name: 'health' });
  const verifiedLimiter = rateLimit({ windowMs: 60_000, max: 10, name: 'verified' });
  const promoteLimiter = rateLimit({ windowMs: 60_000, max: config.maxPromotePerMin || 5, name: 'promote' });
  const transferLimiter = rateLimit({ windowMs: 60_000, max: config.maxTransferPerMin || 2, name: 'transfer' });
  const takeoverLimiter = rateLimit({ windowMs: 60_000, max: config.maxTransferPerMin || 2, name: 'takeover' });
  const migrateLimiter = rateLimit({ windowMs: 60_000, max: 2, name: 'migrate' });
  const inviteLimiter = rateLimit({ windowMs: 60_000, max: 3, name: 'invite' });
  const apiLimiter = rateLimit({ windowMs: 60_000, max: 60, name: 'api' });

  // Health (no auth) — reports config, does NOT hit Telegram DC to avoid spam
  app.get('/health', healthLimiter, async (_req, res) => {
    const hasSession = !!(config.sessionString || hasSessionFile());
    res.json({
      ok: true,
      authorized: false,
      me: null,
      apiIdConfigured: !!config.apiId,
      hasSession,
      reason: hasSession ? 'has_session_not_verified' : 'no_session',
      timestamp: new Date().toISOString(),
    });
  });

  // Ready (cheap, no TG hit) — checks global flood, breakers, memory
  app.get('/ready', healthLimiter, async (_req, res) => {
    const flooded = isGlobalFlooded();
    const floodUntil = getGlobalFloodUntil();
    const retryAfter = flooded ? Math.max(1, Math.ceil((floodUntil - Date.now()) / 1000)) : undefined;
    const mem = process.memoryUsage();
    const memOk = mem.heapUsed < 512 * 1024 * 1024;
    // lastAuthFailure heuristic: check if AUTH_KEY_DUPLICATED breaker active (indicates auth issue)
    const authBlocked = isChannelBlocked('AUTH_KEY_DUPLICATED') || isChannelBlocked('FRESH_CHANGE_ADMINS_FORBIDDEN');
    const ready = !flooded && memOk;
    const status = ready ? 200 : 503;
    if (flooded && retryAfter) res.setHeader('Retry-After', String(retryAfter));
    res.status(status).json({
      ok: ready,
      ready,
      flooded,
      floodUntil: flooded ? new Date(floodUntil).toISOString() : null,
      ...(retryAfter ? { retryAfter } : {}),
      breakers: Array.from(channelBreakers.entries()).map(([k, v]) => ({
        key: k,
        until: new Date(v).toISOString(),
        remainingSec: Math.max(0, Math.ceil((v - Date.now()) / 1000)),
      })),
      memory: { heapUsed: mem.heapUsed, heapTotal: mem.heapTotal, rss: mem.rss },
      uptime: process.uptime(),
      authBlocked,
      timestamp: new Date().toISOString(),
    });
  });

  // Metrics (limiter stats + flood state) — try prom-client fallback to json
  app.get('/metrics', healthLimiter, async (_req, res) => {
    // try prom-client text format if available and client requests it
    const accept = (_req.headers.accept as string) || '';
    if (accept.includes('text/plain')) {
      try {
        // eslint-disable-next-line @typescript-eslint/no-require-imports
        const prom = require('prom-client');
        if (prom && prom.register && typeof prom.register.metrics === 'function') {
          const metricsText = await prom.register.metrics();
          res.setHeader('Content-Type', prom.register.contentType || 'text/plain');
          return res.send(metricsText);
        }
      } catch {
        // fall through to json
      }
    }
    const mem = process.memoryUsage();
    const flooded = isGlobalFlooded();
    const floodUntil = getGlobalFloodUntil();
    const breakers = Array.from(channelBreakers.entries()).map(([k, v]) => ({
      key: k,
      until: new Date(v).toISOString(),
      remainingSec: Math.max(0, Math.ceil((v - Date.now()) / 1000)),
    }));
    const limiters: Record<string, unknown> = {};
    for (const [name, entry] of limiterRegistry) {
      let totalKeys = entry.hits.size;
      let totalHits = 0;
      const now = Date.now();
      for (const [, times] of entry.hits) {
        const alive = times.filter((t) => now - t < entry.opts.windowMs);
        totalHits += alive.length;
      }
      limiters[name] = { windowMs: entry.opts.windowMs, max: entry.opts.max, activeKeys: totalKeys, totalHits };
    }
    res.json({
      ok: true,
      flood: {
        isGlobalFlooded: flooded,
        globalFloodUntil: floodUntil ? new Date(floodUntil).toISOString() : null,
        retryAfter: flooded ? Math.max(1, Math.ceil((floodUntil - Date.now()) / 1000)) : 0,
      },
      breakers,
      memory: mem,
      uptime: process.uptime(),
      limiters,
      idempotency: { size: idempotencyStore.size },
      meCache: meCache ? { ageSec: Math.floor((Date.now() - meCache.ts) / 1000) } : null,
      timestamp: new Date().toISOString(),
    });
  });

  // Internal auth — timing-safe, header only (query api_key deprecated, still accepted with warn)
  app.use((req: Request, res: Response, next: NextFunction) => {
    if (!config.apiKey) return next();
    const headerKey = (req.headers['x-api-key'] as string) || (req.headers['x-ubot-key'] as string) || '';
    const queryKey = req.query.api_key as string | undefined;
    if (queryKey) {
      logger.warn('ubot api: query api_key deprecated, use x-api-key header (leaks in logs)');
    }
    const provided = headerKey || queryKey || '';
    if (!provided) return res.status(401).json({ error: 'unauthorized', hint: 'x-api-key required' });
    const ok = timingSafeStringEqual(provided, config.apiKey);
    if (!ok) return res.status(401).json({ error: 'unauthorized', hint: 'x-api-key required' });
    next();
  });

  // Global flood check middleware after auth
  app.use((req: Request, res: Response, next: NextFunction) => {
    if (isGlobalFlooded()) {
      const until = getGlobalFloodUntil();
      const retryAfter = Math.max(1, Math.ceil((until - Date.now()) / 1000));
      res.setHeader('Retry-After', String(retryAfter));
      return res.status(429).json({
        error: `global flood active — retry after ${retryAfter}s`,
        retryAfter,
        until: new Date(until).toISOString(),
        hint: `global flood until ${new Date(until).toISOString()}`,
      });
    }
    next();
  });

  // Apply generic api limiter to all api routes after auth + flood check
  app.use(apiLimiter);

  // Helper: channel breaker for FRESH (transfer/takeover)
  const freshBreakerMiddleware = (req: Request, res: Response, next: NextFunction) => {
    if (isChannelBlocked('FRESH_CHANGE_ADMINS_FORBIDDEN')) {
      const until = channelBreakers.get('FRESH_CHANGE_ADMINS_FORBIDDEN');
      const retryAfter = until ? Math.max(1, Math.ceil((until - Date.now()) / 1000)) : 86400;
      res.setHeader('Retry-After', String(retryAfter));
      return res.status(429).json({
        error: 'FRESH_CHANGE_ADMINS_FORBIDDEN: recent admin changes — Telegram anti-abuse, wait 24h',
        retryAfter,
        hint: 'wait 24h before transfer/takeover',
        breaker: 'FRESH_CHANGE_ADMINS_FORBIDDEN',
        until: until ? new Date(until).toISOString() : null,
      });
    }
    next();
  };

  // Verified health (with auth, cached, cheap after first hit)
  app.get('/health/verified', verifiedLimiter, async (req: Request, res: Response) => {
    // If still flooded (should be caught by global middleware, but double-check for cache path)
    if (isGlobalFlooded()) {
      const until = getGlobalFloodUntil();
      const retryAfter = Math.max(1, Math.ceil((until - Date.now()) / 1000));
      res.setHeader('Retry-After', String(retryAfter));
      return res.status(429).json({ ok: false, authorized: false, error: `global flood active — retry after ${retryAfter}s`, retryAfter });
    }
    // serve cache if fresh
    if (meCache && Date.now() - meCache.ts < ME_CACHE_TTL) {
      res.setHeader('X-Cache', 'HIT');
      return res.json({ ok: true, authorized: true, me: meCache.data, hasSession: true, cached: true, timestamp: new Date().toISOString() });
    }
    try {
      const c = await ensureClient();
      const me = (await c.getMe()) as unknown as { id: number; username?: string };
      const data = { id: (me as { id: number }).id, username: (me as { username?: string }).username };
      meCache = { ts: Date.now(), data };
      res.setHeader('X-Cache', 'MISS');
      return res.json({ ok: true, authorized: true, me: data, hasSession: true, cached: false, timestamp: new Date().toISOString() });
    } catch (e) {
      const mapped = mapTelegramError(e);
      if (mapped.status === 429) res.setHeader('Retry-After', String(mapped.retryAfter ?? 30));
      return res.status(mapped.status).json({ ok: false, authorized: false, error: mapped.error, ...(mapped.retryAfter ? { retryAfter: mapped.retryAfter } : {}) });
    }
  });

  // Channel: get info
  app.get('/channel/:id', async (req: Request, res: Response) => {
    if (!isValidId(req.params.id)) return res.status(400).json({ error: 'invalid channel id' });
    try {
      const info = await getChannelInfo(String(req.params.id));
      res.json(info);
    } catch (e) {
      const mapped = mapTelegramError(e);
      if (mapped.status === 429) res.setHeader('Retry-After', String(mapped.retryAfter ?? 30));
      else if (mapped.retryAfter) res.setHeader('Retry-After', String(mapped.retryAfter));
      if (mapped.status >= 500) logger.error('getChannelInfo error', redactSecrets({ channel: req.params.id, error: mapped.error, reqId: (req as unknown as Record<string, unknown>).reqId }));
      res.status(mapped.status).json({ error: mapped.error, ...(mapped.retryAfter ? { retryAfter: mapped.retryAfter } : {}) });
    }
  });

  // Channel: list admins
  app.get('/channel/:id/admins', async (req: Request, res: Response) => {
    if (!isValidId(req.params.id)) return res.status(400).json({ error: 'invalid channel id' });
    try {
      const admins = await listChannelAdmins(String(req.params.id));
      res.json(admins);
    } catch (e) {
      const mapped = mapTelegramError(e);
      if (mapped.status === 429) res.setHeader('Retry-After', String(mapped.retryAfter ?? 30));
      else if (mapped.retryAfter) res.setHeader('Retry-After', String(mapped.retryAfter));
      if (mapped.status >= 500) logger.error('listChannelAdmins error', redactSecrets({ channel: req.params.id, error: mapped.error, reqId: (req as unknown as Record<string, unknown>).reqId }));
      res.status(mapped.status).json({ error: mapped.error, ...(mapped.retryAfter ? { retryAfter: mapped.retryAfter } : {}) });
    }
  });

  // Channel: promote to admin
  app.post('/channel/:id/promote', promoteLimiter, async (req: Request, res: Response) => {
    if (!isValidId(req.params.id)) return res.status(400).json({ error: 'invalid channel id' });
    const { userId, rights, rank } = req.body;
    if (!isValidId(userId)) return res.status(400).json({ error: 'userId required (numeric id or @username)' });
    if (rank && String(rank).length > 32) return res.status(400).json({ error: 'rank too long (max 32)' });
    try {
      await promoteToAdmin(String(req.params.id), userId, rights, rank);
      res.json({ ok: true });
    } catch (e) {
      const mapped = mapTelegramError(e);
      if (mapped.status === 429) res.setHeader('Retry-After', String(mapped.retryAfter ?? 30));
      else if (mapped.retryAfter) res.setHeader('Retry-After', String(mapped.retryAfter));
      logger.error('promote error', redactSecrets({ channel: req.params.id, userId, error: mapped.error, reqId: (req as unknown as Record<string, unknown>).reqId }));
      res.status(mapped.status).json({ error: mapped.error, ...(mapped.retryAfter ? { retryAfter: mapped.retryAfter } : {}) });
    }
  });

  // Channel: invite
  app.post('/channel/:id/invite', inviteLimiter, async (req: Request, res: Response) => {
    if (!isValidId(req.params.id)) return res.status(400).json({ error: 'invalid channel id' });
    const { userId } = req.body;
    if (!isValidId(userId)) return res.status(400).json({ error: 'userId required (numeric id or @username)' });
    try {
      await addGroupMember(String(req.params.id), userId);
      res.json({ ok: true });
    } catch (e) {
      const mapped = mapTelegramError(e);
      if (mapped.status === 429) res.setHeader('Retry-After', String(mapped.retryAfter ?? 30));
      else if (mapped.retryAfter) res.setHeader('Retry-After', String(mapped.retryAfter));
      logger.error('channel invite error', redactSecrets({ channel: req.params.id, userId, error: mapped.error, reqId: (req as unknown as Record<string, unknown>).reqId }));
      res.status(mapped.status).json({ error: mapped.error, ...(mapped.retryAfter ? { retryAfter: mapped.retryAfter } : {}) });
    }
  });

  // Channel: transfer ownership
  app.post('/channel/:id/transfer', transferLimiter, freshBreakerMiddleware, async (req: Request, res: Response) => {
    if (!isValidId(req.params.id)) return res.status(400).json({ error: 'invalid channel id' });
    const { newOwnerId, password } = req.body;
    if (!isValidId(newOwnerId)) return res.status(400).json({ error: 'newOwnerId required' });
    if (password && String(password).length > 128) return res.status(400).json({ error: 'password too long' });
    try {
      await transferChannelOwnership(String(req.params.id), newOwnerId, password);
      res.json({ ok: true });
    } catch (e) {
      const mapped = mapTelegramError(e);
      if (mapped.status === 429) res.setHeader('Retry-After', String(mapped.retryAfter ?? 30));
      else if (mapped.retryAfter) res.setHeader('Retry-After', String(mapped.retryAfter));
      logger.error('transfer error', redactSecrets({ channel: req.params.id, newOwnerId, error: mapped.error, reqId: (req as unknown as Record<string, unknown>).reqId }));
      res.status(mapped.status).json({ error: mapped.error, ...(mapped.retryAfter ? { retryAfter: mapped.retryAfter } : {}) });
    }
  });

  // Channel: takeover (promote + transfer in one go)
  app.post('/channel/:id/takeover', takeoverLimiter, freshBreakerMiddleware, async (req: Request, res: Response) => {
    if (!isValidId(req.params.id)) return res.status(400).json({ error: 'invalid channel id' });
    const { newOwnerId, password, rights, rank } = req.body;
    if (!isValidId(newOwnerId)) return res.status(400).json({ error: 'newOwnerId required' });

    // idempotency
    const idemKey = getIdempotencyKey(req);
    if (idemKey) {
      const hit = getIdempotencyHit(idemKey);
      if (hit) {
        res.setHeader('X-Idempotent-Replayed', 'true');
        return res.status(hit.status).json(hit.body);
      }
    }

    try {
      try {
        await promoteToAdmin(String(req.params.id), newOwnerId, rights, rank || 'Owner');
      } catch (pe) {
        const m = String((pe as Error).message || pe);
        if (!m.includes('CHAT_NOT_MODIFIED') && !m.includes('already admin')) {
          logger.warn('takeover promote failed (may already be admin)', redactSecrets({ channel: req.params.id, newOwnerId, error: m, reqId: (req as unknown as Record<string, unknown>).reqId }));
        }
      }
      // human delay between promote and transfer to avoid ban (2500 + rand*2500)
      await sleep(2500 + Math.random() * 2500);
      await transferChannelOwnership(String(req.params.id), newOwnerId, password);
      const body = { ok: true, step: 'transferred' };
      if (idemKey) setIdempotency(idemKey, 200, body);
      res.json(body);
    } catch (e) {
      const mapped = mapTelegramError(e);
      if (mapped.status === 429) res.setHeader('Retry-After', String(mapped.retryAfter ?? 30));
      else if (mapped.retryAfter) res.setHeader('Retry-After', String(mapped.retryAfter));
      logger.error('takeover error', redactSecrets({ channel: req.params.id, newOwnerId, error: mapped.error, reqId: (req as unknown as Record<string, unknown>).reqId }));
      res.status(mapped.status).json({ error: mapped.error, ...(mapped.retryAfter ? { retryAfter: mapped.retryAfter } : {}) });
    }
  });

  // Group: promote
  app.post('/group/:id/promote', promoteLimiter, async (req: Request, res: Response) => {
    if (!isValidId(req.params.id)) return res.status(400).json({ error: 'invalid group id' });
    const { userId, rights, rank } = req.body;
    if (!isValidId(userId)) return res.status(400).json({ error: 'userId required' });
    try {
      await promoteGroupAdmin(String(req.params.id), userId, rights, rank);
      res.json({ ok: true });
    } catch (e) {
      const mapped = mapTelegramError(e);
      if (mapped.status === 429) res.setHeader('Retry-After', String(mapped.retryAfter ?? 30));
      else if (mapped.retryAfter) res.setHeader('Retry-After', String(mapped.retryAfter));
      logger.error('group promote error', redactSecrets({ group: req.params.id, userId, error: mapped.error, reqId: (req as unknown as Record<string, unknown>).reqId }));
      res.status(mapped.status).json({ error: mapped.error, ...(mapped.retryAfter ? { retryAfter: mapped.retryAfter } : {}) });
    }
  });

  // Group: invite
  app.post('/group/:id/invite', inviteLimiter, async (req: Request, res: Response) => {
    if (!isValidId(req.params.id)) return res.status(400).json({ error: 'invalid group id' });
    const { userId } = req.body;
    if (!isValidId(userId)) return res.status(400).json({ error: 'userId required' });
    try {
      await addGroupMember(String(req.params.id), userId);
      res.json({ ok: true });
    } catch (e) {
      const mapped = mapTelegramError(e);
      if (mapped.status === 429) res.setHeader('Retry-After', String(mapped.retryAfter ?? 30));
      else if (mapped.retryAfter) res.setHeader('Retry-After', String(mapped.retryAfter));
      logger.error('group invite error', redactSecrets({ group: req.params.id, userId, error: mapped.error, reqId: (req as unknown as Record<string, unknown>).reqId }));
      res.status(mapped.status).json({ error: mapped.error, ...(mapped.retryAfter ? { retryAfter: mapped.retryAfter } : {}) });
    }
  });

  app.post('/group/:id/transfer', transferLimiter, freshBreakerMiddleware, async (req: Request, res: Response) => {
    if (!isValidId(req.params.id)) return res.status(400).json({ error: 'invalid group id' });
    const { newOwnerId, password } = req.body;
    if (!isValidId(newOwnerId)) return res.status(400).json({ error: 'newOwnerId required' });
    try {
      await transferGroupOwnership(String(req.params.id), newOwnerId, password);
      res.json({ ok: true });
    } catch (e) {
      const mapped = mapTelegramError(e);
      if (mapped.status === 429) res.setHeader('Retry-After', String(mapped.retryAfter ?? 30));
      else if (mapped.retryAfter) res.setHeader('Retry-After', String(mapped.retryAfter));
      logger.error('group transfer error', redactSecrets({ group: req.params.id, newOwnerId, error: mapped.error, reqId: (req as unknown as Record<string, unknown>).reqId }));
      res.status(mapped.status).json({ error: mapped.error, ...(mapped.retryAfter ? { retryAfter: mapped.retryAfter } : {}) });
    }
  });

  app.post('/group/:id/takeover', takeoverLimiter, freshBreakerMiddleware, async (req: Request, res: Response) => {
    if (!isValidId(req.params.id)) return res.status(400).json({ error: 'invalid group id' });
    const { newOwnerId, password, rights, rank } = req.body;
    if (!isValidId(newOwnerId)) return res.status(400).json({ error: 'newOwnerId required' });

    const idemKey = getIdempotencyKey(req);
    if (idemKey) {
      const hit = getIdempotencyHit(idemKey);
      if (hit) {
        res.setHeader('X-Idempotent-Replayed', 'true');
        return res.status(hit.status).json(hit.body);
      }
    }

    try {
      try {
        await promoteGroupAdmin(String(req.params.id), newOwnerId, rights, rank || 'Owner');
      } catch (pe) {
        logger.warn('group takeover promote failed', redactSecrets({ group: req.params.id, newOwnerId, error: String((pe as Error).message || pe), reqId: (req as unknown as Record<string, unknown>).reqId }));
      }
      await sleep(2500 + Math.random() * 2500);
      await transferGroupOwnership(String(req.params.id), newOwnerId, password);
      const body = { ok: true, step: 'transferred' };
      if (idemKey) setIdempotency(idemKey, 200, body);
      res.json(body);
    } catch (e) {
      const mapped = mapTelegramError(e);
      if (mapped.status === 429) res.setHeader('Retry-After', String(mapped.retryAfter ?? 30));
      else if (mapped.retryAfter) res.setHeader('Retry-After', String(mapped.retryAfter));
      logger.error('group takeover error', redactSecrets({ group: req.params.id, newOwnerId, error: mapped.error, reqId: (req as unknown as Record<string, unknown>).reqId }));
      res.status(mapped.status).json({ error: mapped.error, ...(mapped.retryAfter ? { retryAfter: mapped.retryAfter } : {}) });
    }
  });

  app.get('/group/:id/isBasic', async (req: Request, res: Response) => {
    if (!isValidId(req.params.id)) return res.status(400).json({ error: 'invalid group id' });
    try {
      const basic = await isBasicGroup(String(req.params.id));
      res.json({ isBasic: basic });
    } catch (e) {
      const mapped = mapTelegramError(e);
      if (mapped.status === 429) res.setHeader('Retry-After', String(mapped.retryAfter ?? 30));
      else if (mapped.retryAfter) res.setHeader('Retry-After', String(mapped.retryAfter));
      res.status(mapped.status).json({ error: mapped.error, ...(mapped.retryAfter ? { retryAfter: mapped.retryAfter } : {}) });
    }
  });

  app.post('/group/:id/migrate', migrateLimiter, async (req: Request, res: Response) => {
    if (!isValidId(req.params.id)) return res.status(400).json({ error: 'invalid group id' });
    try {
      const ch = await migrateToSupergroup(String(req.params.id));
      // Handle both BigInt and number id
      const rawId = (ch as unknown as { id: unknown }).id;
      const channelId =
        typeof rawId === 'object' && rawId && typeof (rawId as { toString: () => string }).toString === 'function'
          ? String((rawId as { toString: () => string }).toString())
          : String(rawId);
      res.json({ ok: true, channelId });
    } catch (e) {
      const mapped = mapTelegramError(e);
      if (mapped.status === 429) res.setHeader('Retry-After', String(mapped.retryAfter ?? 30));
      else if (mapped.retryAfter) res.setHeader('Retry-After', String(mapped.retryAfter));
      logger.error('migrate error', redactSecrets({ group: req.params.id, error: mapped.error, reqId: (req as unknown as Record<string, unknown>).reqId }));
      res.status(mapped.status).json({ error: mapped.error, ...(mapped.retryAfter ? { retryAfter: mapped.retryAfter } : {}) });
    }
  });

  // Error handler — ensures Retry-After, redacted logging
  app.use((err: unknown, req: Request, res: Response, _next: NextFunction) => {
    const mapped = mapTelegramError(err);
    // Always set Retry-After for 429, using parsed retryAfter or fallback 30
    if (mapped.status === 429) {
      if (!res.headersSent) res.setHeader('Retry-After', String(mapped.retryAfter ?? 30));
    } else if (mapped.retryAfter) {
      if (!res.headersSent) res.setHeader('Retry-After', String(mapped.retryAfter));
    }
    logger.error(
      'Unhandled',
      redactSecrets({
        error: mapped.error,
        status: mapped.status,
        retryAfter: mapped.retryAfter,
        reqId: (req as unknown as Record<string, unknown>).reqId,
        path: req.originalUrl,
        stack: (err as Error).stack?.slice(0, 800),
      } as Record<string, unknown>)
    );
    if (!res.headersSent) {
      const status = mapped.status >= 400 && mapped.status < 600 ? mapped.status : 500;
      // Ensure Retry-After for 429 if not already set
      if (status === 429 && !res.getHeader('Retry-After')) {
        res.setHeader('Retry-After', String(mapped.retryAfter ?? 30));
      }
      res.status(status).json({ error: mapped.error || 'internal_error', ...(mapped.retryAfter ? { retryAfter: mapped.retryAfter } : status === 429 ? { retryAfter: 30 } : {}), reqId: (req as unknown as Record<string, unknown>).reqId });
    }
  });

  return app;
}
