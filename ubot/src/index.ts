import { config, validateConfig } from './config';
import logger from './logger';
import { ensureClient, checkAuthorized } from './client';
import { createApi } from './api';

async function main() {
  const errs = validateConfig();
  if (errs.length) {
    for (const e of errs) logger.warn(e);
    // ENCRYPTION_KEY errors are warnings, but API_ID/HASH missing should be more visible
    if (errs.some((e) => e.includes('API_ID') || e.includes('API_HASH'))) {
      logger.error('ubot misconfigured — API_ID/HASH required; service will start but all channel ops will fail');
    }
  }

  // Try to connect userbot with backoff — non-fatal for health endpoint, but log clearly
  let attempts = 0;
  const maxAttempts = 3;
  while (attempts < maxAttempts) {
    attempts++;
    try {
      await ensureClient();
      logger.info('Userbot initial connection succeeded');
      break;
    } catch (e) {
      const msg = String((e as Error).message || e);
      logger.error(`Failed to ensure Telegram client (attempt ${attempts}/${maxAttempts})`, { error: msg });
      if (msg.includes('not_authorized') || msg.includes('API_ID') || msg.includes('ENCRYPTION_KEY')) {
        // Auth/config errors won't recover without restart/re-login — don't loop forever
        logger.warn('Auth/config error — will retry on next API request, not looping at startup');
        break;
      }
      if (attempts < maxAttempts) {
        const wait = Math.min(5000 * attempts, 15000);
        logger.info(`Retrying ensureClient in ${wait}ms...`);
        await new Promise((r) => setTimeout(r, wait));
      }
    }
  }

  const app = createApi();
  const port = config.port;

  const server = app.listen(port, () => {
    logger.info(`ubot listening on http://localhost:${port} (apiId=${config.apiId ? 'set' : 'missing'}, health at /health, verified health at /health/verified)`);
    if (config.apiKey) logger.info('UBOT_API_KEY auth enabled (timing-safe, header only)');
    else logger.warn('UBOT_API_KEY not set — internal API is OPEN (dev only) — set a 32+ char random key');
    // Periodic auth check to detect session revocation without spamming
    setInterval(async () => {
      try {
        const ok = await checkAuthorized();
        if (!ok) logger.warn('Periodic check: session no longer authorized — may need re-login');
      } catch {}
    }, 60_000);
  });

  // Graceful shutdown
  const shutdown = async (signal: string) => {
    logger.info(`${signal} — shutting down`);
    try {
      const { disconnect } = await import('./client');
      await disconnect();
    } catch {}
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 5000);
  };
  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
}

main().catch((e) => {
  logger.error('ubot fatal', e);
  process.exit(1);
});

process.on('unhandledRejection', (e) => {
  const msg = String((e as Error)?.message || e);
  // Don't crash on FloodWait, just log
  if (msg.includes('FloodWait') || msg.includes('FLOOD_WAIT')) {
    logger.warn('unhandled FloodWait', e);
  } else {
    logger.error('unhandledRejection', e);
  }
});
process.on('uncaughtException', (e) => {
  logger.error('uncaughtException', e);
  process.exit(1);
});
