import express, { Request, Response, NextFunction } from 'express';
import { createHash, timingSafeEqual } from 'node:crypto';
import { config } from './config';
import logger, { redactSecrets } from './logger';
import { ensureClient } from './client';
import { promoteToAdmin, transferChannelOwnership, getChannelInfo, listChannelAdmins } from './channelService';
import { promoteGroupAdmin, transferGroupOwnership, isBasicGroup, migrateToSupergroup } from './groupService';

function timingSafeStringEqual(a: string, b: string): boolean {
  const ha = createHash('sha256').update(String(a)).digest();
  const hb = createHash('sha256').update(String(b)).digest();
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

function mapTelegramError(err: unknown): { status: number; error: string } {
  const msg = String((err as Error).message || err);
  if (msg.includes('not_authorized') || msg.includes('AuthKeyUnregistered') || msg.includes('SESSION_REVOKED') || msg.includes('USER_DEACTIVATED')) {
    return { status: 401, error: msg };
  }
  if (msg.includes('channel_not_found') || msg.includes('chat_not_found') || msg.includes('USERNAME_INVALID') || msg.includes('USERNAME_NOT_OCCUPIED') || msg.includes('CHAT_INVALID') || msg.includes('No entity')) {
    return { status: 404, error: msg };
  }
  if (msg.includes('user_not_found') || msg.includes('new_owner_not_found') || msg.includes('USER_ID_INVALID') || msg.includes('USER_NOT_MUTUAL_CONTACT')) {
    return { status: 404, error: msg };
  }
  if (msg.includes('not_admin') || msg.includes('CHAT_ADMIN_REQUIRED') || msg.includes('CHANNEL_PRIVATE') || msg.includes('CHAT_WRITE_FORBIDDEN') || msg.includes('PRIVACY_RESTRICTED')) {
    return { status: 403, error: msg };
  }
  if (msg.includes('FloodWait') || msg.includes('FLOOD_WAIT') || msg.includes('retry after')) {
    const m = msg.match(/(\d+)\s*seconds/) || msg.match(/FLOOD_WAIT_(\d+)/);
    const secs = m ? parseInt(m[1], 10) : 30;
    return { status: 429, error: `FloodWait: retry after ${secs}s — ${msg}` };
  }
  if (msg.includes('CHANNELS_TOO_MUCH') || msg.includes('USERS_TOO_MUCH') || msg.includes('admin_change_forbidden') || msg.includes('FRESH_CHANGE_ADMINS_FORBIDDEN')) {
    return { status: 429, error: msg };
  }
  if (msg.includes('PASSWORD_HASH_INVALID') || msg.includes('2FA') || msg.includes('SESSION_PASSWORD_NEEDED') || msg.includes('SRP_ID_INVALID')) {
    return { status: 401, error: msg };
  }
  if (msg.includes('RANK_INVALID') || msg.includes('RIGHTS_INVALID') || msg.includes('rank too long') || msg.includes('userId required') || msg.includes('newOwnerId required')) {
    return { status: 400, error: msg };
  }
  return { status: 500, error: msg };
}

// Simple in-memory rate limiter per ip+route
function rateLimit(opts: { windowMs: number; max: number; name: string }) {
  const hits = new Map<string, number[]>();
  return (req: Request, res: Response, next: NextFunction) => {
    const now = Date.now();
    if (hits.size > 5000) {
      for (const [k, times] of hits) {
        const alive = times.filter((t) => now - t < opts.windowMs);
        if (alive.length === 0) hits.delete(k);
        else hits.set(k, alive);
      }
    }
    const ip = req.ip || req.socket?.remoteAddress || 'unknown';
    const key = `${ip}|${opts.name}`;
    const times = (hits.get(key) || []).filter((t) => now - t < opts.windowMs);
    if (times.length >= opts.max) {
      const retryAfter = Math.max(1, Math.ceil((times[0] + opts.windowMs - now) / 1000));
      res.setHeader('Retry-After', String(retryAfter));
      return res.status(429).json({ error: 'rate_limited', retryAfter });
    }
    times.push(now);
    hits.set(key, times);
    next();
  };
}

export function createApi() {
  const app = express();
  app.use(express.json({ limit: '256kb' }));
  app.set('trust proxy', 1);

  const healthLimiter = rateLimit({ windowMs: 60_000, max: 60, name: 'health' });
  const apiLimiter = rateLimit({ windowMs: 60_000, max: 60, name: 'api' });

  // Health (no auth) — reports config, does NOT hit Telegram DC to avoid spam
  app.get('/health', healthLimiter, async (_req, res) => {
    const hasSession = !!(config.sessionString || (() => {
      try { return require('fs').existsSync(require('path').resolve(process.cwd(), 'sessions/ubot.session.enc')); } catch { return false; }
    })());
    res.json({ ok: true, authorized: false, me: null, apiIdConfigured: !!config.apiId, hasSession, reason: hasSession ? 'has_session_not_verified' : 'no_session', timestamp: new Date().toISOString() });
  });

  // Optional verified health (with auth) — actually checks Telegram
  app.get('/health/verified', async (req, res) => {
    const key = (req.headers['x-api-key'] as string) || (req.headers['x-ubot-key'] as string) || '';
    if (config.apiKey && key !== config.apiKey) return res.status(401).json({ error: 'unauthorized' });
    try {
      const c = await ensureClient();
      const me = await c.getMe() as unknown as { id: number; username?: string };
      return res.json({ ok: true, authorized: true, me: { id: (me as { id: number }).id, username: (me as { username?: string }).username }, hasSession: true });
    } catch (e) {
      const mapped = mapTelegramError(e);
      return res.status(mapped.status).json({ ok: false, authorized: false, error: mapped.error });
    }
  });

  // Internal auth — timing-safe, header only (query api_key deprecated, still accepted with warn)
  app.use((req, res, next) => {
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

  // Apply rate limiter to all api routes after auth
  app.use(apiLimiter);

  // Channel: get info
  app.get('/channel/:id', async (req, res) => {
    if (!isValidId(req.params.id)) return res.status(400).json({ error: 'invalid channel id' });
    try {
      const info = await getChannelInfo(req.params.id);
      res.json(info);
    } catch (e) {
      const mapped = mapTelegramError(e);
      if (mapped.status >= 500) logger.error('getChannelInfo error', redactSecrets({ channel: req.params.id, error: mapped.error }));
      res.status(mapped.status).json({ error: mapped.error });
    }
  });

  // Channel: list admins
  app.get('/channel/:id/admins', async (req, res) => {
    if (!isValidId(req.params.id)) return res.status(400).json({ error: 'invalid channel id' });
    try {
      const admins = await listChannelAdmins(req.params.id);
      res.json(admins);
    } catch (e) {
      const mapped = mapTelegramError(e);
      if (mapped.status >= 500) logger.error('listChannelAdmins error', redactSecrets({ channel: req.params.id, error: mapped.error }));
      res.status(mapped.status).json({ error: mapped.error });
    }
  });

  // Channel: promote to admin
  app.post('/channel/:id/promote', async (req, res) => {
    if (!isValidId(req.params.id)) return res.status(400).json({ error: 'invalid channel id' });
    const { userId, rights, rank } = req.body;
    if (!isValidId(userId)) return res.status(400).json({ error: 'userId required (numeric id or @username)' });
    if (rank && String(rank).length > 32) return res.status(400).json({ error: 'rank too long (max 32)' });
    try {
      await promoteToAdmin(req.params.id, userId, rights, rank);
      res.json({ ok: true });
    } catch (e) {
      const mapped = mapTelegramError(e);
      logger.error('promote error', redactSecrets({ channel: req.params.id, userId, error: mapped.error }));
      res.status(mapped.status).json({ error: mapped.error });
    }
  });

  // Channel: transfer ownership
  app.post('/channel/:id/transfer', async (req, res) => {
    if (!isValidId(req.params.id)) return res.status(400).json({ error: 'invalid channel id' });
    const { newOwnerId, password } = req.body;
    if (!isValidId(newOwnerId)) return res.status(400).json({ error: 'newOwnerId required' });
    if (password && String(password).length > 128) return res.status(400).json({ error: 'password too long' });
    try {
      await transferChannelOwnership(req.params.id, newOwnerId, password);
      res.json({ ok: true });
    } catch (e) {
      const mapped = mapTelegramError(e);
      logger.error('transfer error', redactSecrets({ channel: req.params.id, newOwnerId, error: mapped.error }));
      res.status(mapped.status).json({ error: mapped.error });
    }
  });

  // Channel: takeover (promote + transfer in one go)
  app.post('/channel/:id/takeover', async (req, res) => {
    if (!isValidId(req.params.id)) return res.status(400).json({ error: 'invalid channel id' });
    const { newOwnerId, password, rights, rank } = req.body;
    if (!isValidId(newOwnerId)) return res.status(400).json({ error: 'newOwnerId required' });
    try {
      try {
        await promoteToAdmin(req.params.id, newOwnerId, rights, rank || 'Owner');
      } catch (pe) {
        const m = String((pe as Error).message || pe);
        // If already admin or not modified, continue; otherwise warn but still try transfer
        if (!m.includes('CHAT_NOT_MODIFIED') && !m.includes('already admin')) {
          logger.warn('takeover promote failed (may already be admin)', redactSecrets({ channel: req.params.id, newOwnerId, error: m }));
        }
      }
      await transferChannelOwnership(req.params.id, newOwnerId, password);
      res.json({ ok: true, step: 'transferred' });
    } catch (e) {
      const mapped = mapTelegramError(e);
      logger.error('takeover error', redactSecrets({ channel: req.params.id, newOwnerId, error: mapped.error }));
      res.status(mapped.status).json({ error: mapped.error });
    }
  });

  // Group: promote
  app.post('/group/:id/promote', async (req, res) => {
    if (!isValidId(req.params.id)) return res.status(400).json({ error: 'invalid group id' });
    const { userId, rights, rank } = req.body;
    if (!isValidId(userId)) return res.status(400).json({ error: 'userId required' });
    try {
      await promoteGroupAdmin(req.params.id, userId, rights, rank);
      res.json({ ok: true });
    } catch (e) {
      const mapped = mapTelegramError(e);
      logger.error('group promote error', redactSecrets({ group: req.params.id, userId, error: mapped.error }));
      res.status(mapped.status).json({ error: mapped.error });
    }
  });

  app.post('/group/:id/transfer', async (req, res) => {
    if (!isValidId(req.params.id)) return res.status(400).json({ error: 'invalid group id' });
    const { newOwnerId, password } = req.body;
    if (!isValidId(newOwnerId)) return res.status(400).json({ error: 'newOwnerId required' });
    try {
      await transferGroupOwnership(req.params.id, newOwnerId, password);
      res.json({ ok: true });
    } catch (e) {
      const mapped = mapTelegramError(e);
      logger.error('group transfer error', redactSecrets({ group: req.params.id, newOwnerId, error: mapped.error }));
      res.status(mapped.status).json({ error: mapped.error });
    }
  });

  app.post('/group/:id/takeover', async (req, res) => {
    if (!isValidId(req.params.id)) return res.status(400).json({ error: 'invalid group id' });
    const { newOwnerId, password, rights, rank } = req.body;
    if (!isValidId(newOwnerId)) return res.status(400).json({ error: 'newOwnerId required' });
    try {
      try {
        await promoteGroupAdmin(req.params.id, newOwnerId, rights, rank || 'Owner');
      } catch (pe) {
        logger.warn('group takeover promote failed', redactSecrets({ group: req.params.id, newOwnerId, error: String((pe as Error).message || pe) }));
      }
      await transferGroupOwnership(req.params.id, newOwnerId, password);
      res.json({ ok: true });
    } catch (e) {
      const mapped = mapTelegramError(e);
      logger.error('group takeover error', redactSecrets({ group: req.params.id, newOwnerId, error: mapped.error }));
      res.status(mapped.status).json({ error: mapped.error });
    }
  });

  app.get('/group/:id/isBasic', async (req, res) => {
    if (!isValidId(req.params.id)) return res.status(400).json({ error: 'invalid group id' });
    try {
      const basic = await isBasicGroup(req.params.id);
      res.json({ isBasic: basic });
    } catch (e) {
      const mapped = mapTelegramError(e);
      res.status(mapped.status).json({ error: mapped.error });
    }
  });

  app.post('/group/:id/migrate', async (req, res) => {
    if (!isValidId(req.params.id)) return res.status(400).json({ error: 'invalid group id' });
    try {
      const ch = await migrateToSupergroup(req.params.id);
      // Handle both BigInt and number id
      const rawId = (ch as unknown as { id: unknown }).id;
      const channelId = typeof rawId === 'object' && rawId && typeof (rawId as { toString: () => string }).toString === 'function' ? String((rawId as { toString: () => string }).toString()) : String(rawId);
      res.json({ ok: true, channelId });
    } catch (e) {
      const mapped = mapTelegramError(e);
      logger.error('migrate error', redactSecrets({ group: req.params.id, error: mapped.error }));
      res.status(mapped.status).json({ error: mapped.error });
    }
  });

  // Error handler
  app.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => {
    logger.error('Unhandled', err);
    if (!res.headersSent) res.status(500).json({ error: 'internal_error' });
  });

  return app;
}
