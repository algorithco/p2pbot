import express from 'express';
import { config, validateConfig } from './config';
import logger from './logger';
import { pool, ensureTables } from './db/queries';
import { startBot, getBot } from './bot/bot';

const app = express();
app.use(express.json({ limit: '256kb' }));

// Health (no auth) — docker healthcheck
app.get('/health', async (_req, res) => {
  let dbOk = false;
  try {
    await pool.query('SELECT 1');
    dbOk = true;
  } catch {}
  res.json({ ok: true, dbOk, hasToken: !!config.botToken });
});

// Internal API auth for other endpoints if needed
app.use((req, res, next) => {
  // Allow /health without auth
  if (req.path === '/health') return next();
  if (!config.apiKey) return next();
  const key = (req.headers['x-api-key'] as string) || (req.headers['x-utrade-key'] as string) || (req.query.api_key as string) || '';
  if (key !== config.apiKey) return res.status(401).json({ error: 'unauthorized' });
  next();
});

app.get('/api/trades/:id', async (req, res) => {
  try {
    const id = Number(req.params.id);
    const r = await pool.query('SELECT id, seller_telegram_id, buyer_telegram_id, phone, status, created_at FROM utrade_trades WHERE id = $1', [id]);
    if (r.rows.length === 0) return res.status(404).json({ error: 'not_found' });
    res.json(r.rows[0]);
  } catch (e) {
    res.status(500).json({ error: String((e as Error).message || e) });
  }
});

let server: ReturnType<typeof app.listen> | null = null;

async function main() {
  const errs = validateConfig();
  if (errs.length) {
    for (const e of errs) logger.warn(e);
    if (!config.botToken || !config.databaseUrl) {
      logger.warn('utradebot will start in degraded mode (missing token/db)');
    }
  }

  // DB
  try {
    await pool.query('SELECT 1');
    logger.info('utradebot: DB connected');
    await ensureTables();
  } catch (e) {
    logger.error('utradebot: DB failed', e);
  }

  // Bot
  if (config.botToken) {
    try {
      await startBot();
    } catch (e) {
      logger.error('utradebot: bot failed to start', e);
    }
  } else {
    logger.warn('UTRADE_BOT_TOKEN not set — bot polling disabled');
  }

  const port = config.port;
  server = app.listen(port, () => {
    logger.info(`utradebot HTTP on http://localhost:${port}`);
  });
}

main().catch((e) => {
  logger.error('utradebot fatal', e);
  process.exit(1);
});

process.on('SIGINT', async () => {
  logger.info('SIGINT — shutdown');
  const b = getBot();
  if (b) try { await b.stop(); } catch {}
  if (server) server.close(() => logger.info('HTTP closed'));
  try { await pool.end(); } catch {}
  process.exit(0);
});
process.on('SIGTERM', async () => {
  logger.info('SIGTERM — shutdown');
  const b = getBot();
  if (b) try { await b.stop(); } catch {}
  if (server) server.close(() => logger.info('HTTP closed'));
  try { await pool.end(); } catch {}
  process.exit(0);
});
process.on('unhandledRejection', (e) => logger.error('unhandledRejection', e));
