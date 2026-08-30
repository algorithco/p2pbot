import express, { Request, Response, NextFunction } from 'express';
import { config } from './config';
import logger from './logger';
import { ensureClient } from './client';
import { promoteToAdmin, transferChannelOwnership, getChannelInfo, listChannelAdmins } from './channelService';
import { promoteGroupAdmin, transferGroupOwnership, isBasicGroup, migrateToSupergroup } from './groupService';

export function createApi() {
  const app = express();
  app.use(express.json({ limit: '256kb' }));

  // Health (no auth) — does NOT connect to Telegram DC to avoid spam; just reports config
  app.get('/health', async (_req, res) => {
    const hasSession = !!(config.sessionString || (() => {
      try { return require('fs').existsSync(require('path').resolve(process.cwd(), 'sessions/ubot.session.enc')); } catch { return false; }
    })());
    // Do not call ensureClient() here — that would spam DC when session invalid
    // Health just reports if session is configured, not if it's authorized
    res.json({ ok: true, authorized: false, me: null, apiIdConfigured: !!config.apiId, hasSession, reason: hasSession ? 'has_session_not_verified' : 'no_session' });
  });

  // Internal auth
  app.use((req, res, next) => {
    if (!config.apiKey) return next();
    const key = (req.headers['x-api-key'] as string) || (req.headers['x-ubot-key'] as string) || (req.query.api_key as string) || '';
    if (key !== config.apiKey) return res.status(401).json({ error: 'unauthorized', hint: 'x-api-key required' });
    next();
  });

  // Channel: get info
  app.get('/channel/:id', async (req, res) => {
    try {
      const info = await getChannelInfo(req.params.id);
      res.json(info);
    } catch (e) {
      res.status(500).json({ error: String((e as Error).message || e) });
    }
  });

  // Channel: list admins
  app.get('/channel/:id/admins', async (req, res) => {
    try {
      const admins = await listChannelAdmins(req.params.id);
      res.json(admins);
    } catch (e) {
      res.status(500).json({ error: String((e as Error).message || e) });
    }
  });

  // Channel: promote to admin
  app.post('/channel/:id/promote', async (req, res) => {
    const { userId, rights, rank } = req.body;
    if (!userId) return res.status(400).json({ error: 'userId required' });
    try {
      await promoteToAdmin(req.params.id, userId, rights, rank);
      res.json({ ok: true });
    } catch (e) {
      logger.error('promote error', e);
      res.status(500).json({ error: String((e as Error).message || e) });
    }
  });

  // Channel: transfer ownership
  app.post('/channel/:id/transfer', async (req, res) => {
    const { newOwnerId, password } = req.body;
    if (!newOwnerId) return res.status(400).json({ error: 'newOwnerId required' });
    try {
      await transferChannelOwnership(req.params.id, newOwnerId, password);
      res.json({ ok: true });
    } catch (e) {
      logger.error('transfer error', e);
      res.status(500).json({ error: String((e as Error).message || e) });
    }
  });

  // Channel: takeover (promote + transfer in one go)
  app.post('/channel/:id/takeover', async (req, res) => {
    const { newOwnerId, password, rights, rank } = req.body;
    if (!newOwnerId) return res.status(400).json({ error: 'newOwnerId required' });
    try {
      // First promote to admin if not already
      try {
        await promoteToAdmin(req.params.id, newOwnerId, rights, rank || 'Owner');
      } catch (pe) {
        logger.warn('takeover promote failed (may already be admin)', pe);
      }
      await transferChannelOwnership(req.params.id, newOwnerId, password);
      res.json({ ok: true, step: 'transferred' });
    } catch (e) {
      logger.error('takeover error', e);
      res.status(500).json({ error: String((e as Error).message || e) });
    }
  });

  // Group: promote
  app.post('/group/:id/promote', async (req, res) => {
    const { userId, rights, rank } = req.body;
    if (!userId) return res.status(400).json({ error: 'userId required' });
    try {
      await promoteGroupAdmin(req.params.id, userId, rights, rank);
      res.json({ ok: true });
    } catch (e) {
      res.status(500).json({ error: String((e as Error).message || e) });
    }
  });

  app.post('/group/:id/transfer', async (req, res) => {
    const { newOwnerId, password } = req.body;
    if (!newOwnerId) return res.status(400).json({ error: 'newOwnerId required' });
    try {
      await transferGroupOwnership(req.params.id, newOwnerId, password);
      res.json({ ok: true });
    } catch (e) {
      res.status(500).json({ error: String((e as Error).message || e) });
    }
  });

  app.post('/group/:id/takeover', async (req, res) => {
    const { newOwnerId, password, rights, rank } = req.body;
    if (!newOwnerId) return res.status(400).json({ error: 'newOwnerId required' });
    try {
      try {
        await promoteGroupAdmin(req.params.id, newOwnerId, rights, rank || 'Owner');
      } catch (pe) {
        logger.warn('group takeover promote failed', pe);
      }
      await transferGroupOwnership(req.params.id, newOwnerId, password);
      res.json({ ok: true });
    } catch (e) {
      res.status(500).json({ error: String((e as Error).message || e) });
    }
  });

  app.get('/group/:id/isBasic', async (req, res) => {
    try {
      const basic = await isBasicGroup(req.params.id);
      res.json({ isBasic: basic });
    } catch (e) {
      res.status(500).json({ error: String((e as Error).message || e) });
    }
  });

  app.post('/group/:id/migrate', async (req, res) => {
    try {
      const ch = await migrateToSupergroup(req.params.id);
      res.json({ ok: true, channelId: String((ch as unknown as { id: unknown }).id) });
    } catch (e) {
      res.status(500).json({ error: String((e as Error).message || e) });
    }
  });

  // Error handler
  app.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => {
    logger.error('Unhandled', err);
    if (!res.headersSent) res.status(500).json({ error: 'internal_error' });
  });

  return app;
}
