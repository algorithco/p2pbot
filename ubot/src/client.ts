import { TelegramClient } from 'telegram';
import { StringSession } from 'telegram/sessions';
import { config } from './config';
import logger from './logger';
import { loadEncryptedSession, saveEncryptedSession } from './sessionManager';

let client: TelegramClient | null = null;
let connectPromise: Promise<TelegramClient> | null = null;

export function getClient(): TelegramClient | null {
  return client;
}

export async function ensureClient(): Promise<TelegramClient> {
  if (client && (await client.checkAuthorization())) return client;
  if (connectPromise) return connectPromise;
  connectPromise = (async () => {
    const sessionStr = loadEncryptedSession() || '';
    const stringSession = new StringSession(sessionStr);

    if (!config.apiId || !config.apiHash) {
      throw new Error('API_ID / API_HASH not configured — set in ubot/.env');
    }

    const c = new TelegramClient(stringSession, config.apiId, config.apiHash, {
      connectionRetries: 5,
      retryDelay: 2000,
      autoReconnect: true,
    });

    logger.info('Connecting TelegramClient...');
    await c.connect();

    const authorized = await c.checkAuthorization();
    if (!authorized) {
      logger.warn('Userbot not authorized — need to run npm run login to generate session');
      // Do not throw; let API report not_authorized
    } else {
      const me = await c.getMe();
      logger.info(`Userbot connected as ${(me as unknown as { username?: string })?.username || (me as unknown as { id: number })?.id}`);
      // Persist session (may have been updated)
      try {
        const saved = (c.session as StringSession).save() as unknown as string;
        if (saved && saved !== sessionStr) saveEncryptedSession(saved);
      } catch {}
    }

    client = c;
    return c;
  })();

  try {
    return await connectPromise;
  } finally {
    connectPromise = null;
  }
}

export async function disconnect(): Promise<void> {
  if (client) {
    try {
      await client.disconnect();
    } catch {}
    client = null;
  }
}

export async function withFloodWait<T>(fn: () => Promise<T>, retries = 3): Promise<T> {
  let lastErr: unknown;
  for (let i = 0; i < retries; i++) {
    try {
      return await fn();
    } catch (e) {
      const msg = String((e as Error).message || e);
      const floodMatch = msg.match(/FloodWaitError|FLOOD_WAIT_(\d+)|retry after (\d+) seconds/i);
      if (floodMatch) {
        const secs = parseInt(floodMatch[1] || floodMatch[2] || '30', 10);
        const wait = Math.min(secs, 120) * 1000;
        logger.warn(`FloodWait — sleeping ${secs}s (attempt ${i + 1}/${retries})`);
        await new Promise((r) => setTimeout(r, wait));
        lastErr = e;
        continue;
      }
      throw e;
    }
  }
  throw lastErr;
}

export function isAuthorized(): boolean {
  return !!client;
}
