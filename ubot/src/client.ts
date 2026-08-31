import { TelegramClient } from 'teleproto';
import { StringSession } from 'teleproto/sessions';
import { config } from './config';
import logger from './logger';
import { loadEncryptedSession, saveEncryptedSession } from './sessionManager';

let client: TelegramClient | null = null;
let connectPromise: Promise<TelegramClient> | null = null;
let lastAuthFailureAt = 0;
let lastConnectAttemptAt = 0;

export function getClient(): TelegramClient | null {
  return client;
}

export async function ensureClient(): Promise<TelegramClient> {
  // Throttle repeated auth failures (e.g., session invalid) to avoid log spam and DC hammering
  const now = Date.now();
  if (lastAuthFailureAt && now - lastAuthFailureAt < 30_000) {
    throw new Error('not_authorized: session invalid (throttled 30s, check docker logs)');
  }
  if (client) {
    try {
      if (await client.checkAuthorization()) return client;
      // Not authorized anymore
      logger.warn('checkAuthorization returned false — session no longer authorized');
      await disconnect();
    } catch (e) {
      const msg = String((e as Error).message || e);
      if (msg.includes('AuthKeyUnregistered') || msg.includes('AuthKeyNotFound') || msg.includes('SESSION_REVOKED') || msg.includes('USER_DEACTIVATED')) {
        lastAuthFailureAt = Date.now();
        logger.warn('Userbot session revoked/unregistered — regenerate via npm run login:qr', e);
        await disconnect().catch(() => undefined);
        throw new Error('not_authorized: session revoked/unregistered — regenerate via npm run login:qr');
      }
      // Fall through to reconnect for other errors
      logger.warn('checkAuthorization failed, will reconnect', e);
      await disconnect().catch(() => undefined);
    }
  }
  if (connectPromise) return connectPromise;
  // Rate limit connect attempts
  if (now - lastConnectAttemptAt < 3000) {
    await new Promise((r) => setTimeout(r, 1000));
  }
  lastConnectAttemptAt = Date.now();

  connectPromise = (async () => {
    const sessionStr = loadEncryptedSession() || '';
    if (!sessionStr) {
      lastAuthFailureAt = Date.now();
      throw new Error('not_authorized: UBOT_SESSION_STRING empty — run npm run login:qr (teleproto) or set ENCRYPTION_KEY correctly');
    }
    if (!config.apiId || !config.apiHash) {
      throw new Error('API_ID / API_HASH not configured — set in ubot/.env');
    }

    const stringSession = new StringSession(sessionStr);
    const c = new TelegramClient(stringSession, config.apiId, config.apiHash, {
      connectionRetries: 2,
      retryDelay: 2000,
      autoReconnect: false,
    });

    logger.info('Connecting TelegramClient (teleproto)...');
    try {
      await c.connect();
    } catch (e) {
      const msg = String((e as Error).message || e);
      if (msg.includes('FloodWait') || (e as { seconds?: number })?.seconds) {
        // Let withFloodWait handle it at call site, but for initial connect, propagate
        logger.warn('Telegram connect FloodWait', e);
      } else {
        logger.warn('Telegram connect failed (will retry on next request)', e);
      }
      throw new Error(`telegram_connect_failed: ${msg}`);
    }

    let authorized = false;
    try {
      authorized = await c.checkAuthorization();
    } catch (e) {
      const msg = String((e as Error).message || e);
      logger.warn('checkAuthorization failed', e);
      await c.disconnect().catch(() => undefined);
      if (msg.includes('AuthKeyUnregistered') || msg.includes('AuthKeyNotFound') || msg.includes('SESSION_REVOKED')) {
        lastAuthFailureAt = Date.now();
        throw new Error(`not_authorized: ${msg} — session invalid, regenerate via npm run login:qr`);
      }
      throw new Error(`not_authorized: ${msg}`);
    }
    if (!authorized) {
      logger.warn('Userbot not authorized — session invalid/expired, regenerate via npm run login:qr');
      await c.disconnect().catch(() => undefined);
      lastAuthFailureAt = Date.now();
      throw new Error('not_authorized: session invalid');
    }
    try {
      const me = await c.getMe();
      logger.info(`Userbot connected as ${(me as unknown as { username?: string })?.username || (me as unknown as { id: number })?.id}`);
    } catch {}
    try {
      const saved = (c.session as StringSession).save() as unknown as string;
      if (saved && saved !== sessionStr) saveEncryptedSession(saved);
    } catch {}
    client = c;
    lastAuthFailureAt = 0;
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
      const err = e as { message?: string; seconds?: number; errorMessage?: string };
      const msg = String(err.message || err.errorMessage || e);
      // teleproto FloodWaitError often has .seconds property
      let secs: number | null = null;
      if (typeof err.seconds === 'number' && Number.isFinite(err.seconds)) {
        secs = err.seconds;
      } else {
        const m = msg.match(/FLOOD_WAIT_(\d+)|retry after (\d+) seconds|wait of (\d+) seconds/i);
        if (m) secs = parseInt(m[1] || m[2] || m[3] || '30', 10);
        else if (msg.includes('FloodWaitError') || msg.includes('FLOOD_WAIT')) {
          secs = 30;
        }
      }
      if (secs !== null) {
        // Telegram can ask to wait up to 24h for FRESH_CHANGE_ADMINS_FORBIDDEN etc.; cap at 300s for initial retries but respect larger for final
        const capped = Math.min(secs, 300);
        const jitter = Math.floor(Math.random() * 2000);
        logger.warn(`FloodWait — sleeping ${secs}s (capped ${capped}s + jitter, attempt ${i + 1}/${retries})`);
        await new Promise((r) => setTimeout(r, capped * 1000 + jitter));
        lastErr = e;
        continue;
      }
      // Map known non-retryable errors to user-friendly messages
      if (msg.includes('CHANNELS_TOO_MUCH')) {
        throw new Error('CHANNELS_TOO_MUCH: bot has joined too many channels/supergroups — leave some or use another account');
      }
      if (msg.includes('AUTH_KEY_DUPLICATED') || msg.includes('AuthKeyDuplicated')) {
        throw new Error('AUTH_KEY_DUPLICATED: session duplicated — generate a new session');
      }
      throw e;
    }
  }
  throw lastErr;
}

export function isAuthorized(): boolean {
  return !!client;
}

export async function checkAuthorized(): Promise<boolean> {
  if (!client) return false;
  try {
    return await client.checkAuthorization();
  } catch {
    return false;
  }
}
