import { TelegramClient } from 'teleproto';
import { StringSession } from 'teleproto/sessions';
import { config } from './config';
import logger from './logger';
import { loadEncryptedSession, saveEncryptedSession } from './sessionManager';

let client: TelegramClient | null = null;
let connectPromise: Promise<TelegramClient> | null = null;

export function getClient(): TelegramClient | null {
  return client;
}

export async function ensureClient(): Promise<TelegramClient> {
  if (client) {
    try {
      if (await client.checkAuthorization()) return client;
    } catch {
      // fall through to reconnect
    }
  }
  if (connectPromise) return connectPromise;
  connectPromise = (async () => {
    const sessionStr = loadEncryptedSession() || '';
    if (!sessionStr) {
      throw new Error('not_authorized: UBOT_SESSION_STRING empty — run npm run login:qr (teleproto) or login-telethon.py');
    }
    if (!config.apiId || !config.apiHash) {
      throw new Error('API_ID / API_HASH not configured — set in ubot/.env');
    }

    const stringSession = new StringSession(sessionStr);
    const c = new TelegramClient(stringSession, config.apiId, config.apiHash, {
      connectionRetries: 1,
      retryDelay: 1000,
      autoReconnect: false, // avoid spam when session invalid; healthcheck will retry on demand
    });

    logger.info('Connecting TelegramClient (teleproto)...');
    try {
      await c.connect();
    } catch (e) {
      logger.warn('Telegram connect failed (will retry on next request)', e);
      throw new Error(`telegram_connect_failed: ${String((e as Error).message || e)}`);
    }

    let authorized = false;
    try {
      authorized = await c.checkAuthorization();
    } catch (e) {
      logger.warn('checkAuthorization failed', e);
      await c.disconnect().catch(() => undefined);
      throw new Error(`not_authorized: ${(e as Error).message}`);
    }
    if (!authorized) {
      logger.warn('Userbot not authorized — session invalid/expired, regenerate via npm run login:qr');
      await c.disconnect().catch(() => undefined);
      throw new Error('not_authorized: session invalid');
    }
    const me = await c.getMe();
    logger.info(`Userbot connected as ${(me as unknown as { username?: string })?.username || (me as unknown as { id: number })?.id}`);
    try {
      const saved = (c.session as StringSession).save() as unknown as string;
      if (saved && saved !== sessionStr) saveEncryptedSession(saved);
    } catch {}
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
