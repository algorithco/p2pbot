import { config, validateConfig } from './config';
import logger from './logger';
import { ensureClient } from './client';
import { createApi } from './api';

async function main() {
  const errs = validateConfig();
  if (errs.length) {
    for (const e of errs) logger.warn(e);
    // Not fatal for health endpoint, but warn
  }

  // Try to connect userbot (non-fatal if not authorized)
  try {
    await ensureClient();
  } catch (e) {
    logger.error('Failed to ensure Telegram client', e);
  }

  const app = createApi();
  const port = config.port;

  app.listen(port, () => {
    logger.info(`ubot listening on http://localhost:${port} (apiId=${config.apiId ? 'set' : 'missing'}, authorized probe at /health)`);
    if (config.apiKey) logger.info('UBOT_API_KEY auth enabled');
    else logger.warn('UBOT_API_KEY not set — internal API is OPEN (dev only)');
  });
}

main().catch((e) => {
  logger.error('ubot fatal', e);
  process.exit(1);
});

process.on('unhandledRejection', (e) => logger.error('unhandledRejection', e));
process.on('SIGINT', async () => {
  logger.info('SIGINT — shutting down');
  const { disconnect } = await import('./client');
  await disconnect();
  process.exit(0);
});
process.on('SIGTERM', async () => {
  logger.info('SIGTERM — shutting down');
  const { disconnect } = await import('./client');
  await disconnect();
  process.exit(0);
});
