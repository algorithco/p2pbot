// src/auth/initData.ts
import { createHmac, timingSafeEqual } from 'node:crypto';

export interface TgUser {
  id: number;
  username?: string;
  first_name?: string;
  last_name?: string;
}

export interface InitDataValidation {
  ok: boolean;
  user?: TgUser;
  reason?: string;
}

/** Parse a raw Telegram initData (urlencoded) into a decoded key->value map. */
export function parseInitData(initData: string): Map<string, string> {
  const params = new Map<string, string>();
  if (!initData) return params;
  for (const pair of initData.split('&')) {
    if (!pair) continue;
    const eq = pair.indexOf('=');
    const rawKey = eq === -1 ? pair : pair.slice(0, eq);
    const rawValue = eq === -1 ? '' : pair.slice(eq + 1);
    try {
      params.set(decodeURIComponent(rawKey), decodeURIComponent(rawValue));
    } catch {
      // best-effort: keep raw pair on malformed encoding; signature check still decides.
      params.set(rawKey, rawValue);
    }
  }
  return params;
}

/**
 * Exact Telegram Mini App initData validation:
 *  1. extract `hash`, build data_check_string from the remaining pairs sorted
 *     alphabetically and joined by '\n'
 *  2. secret_key = HMAC_SHA256(key='WebAppData', msg=botToken)
 *  3. computed   = hex(HMAC_SHA256(key=secret_key, msg=data_check_string))
 *  4. timing-safe compare, then enforce auth_date freshness (maxAgeSec)
 */
export function validateInitData(initData: string, botToken: string, maxAgeSec = 86400): InitDataValidation {
  if (!initData) return { ok: false, reason: 'empty_init_data' };
  if (!botToken) return { ok: false, reason: 'bot_token_not_configured' };

  const params = parseInitData(initData);
  const hash = params.get('hash');
  if (!hash) return { ok: false, reason: 'missing_hash' };

  const pairs: string[] = [];
  for (const [key, value] of params.entries()) {
    if (key === 'hash') continue;
    pairs.push(`${key}=${value}`);
  }
  pairs.sort();
  const dataCheckString = pairs.join('\n');

  const secretKey = createHmac('sha256', 'WebAppData').update(botToken).digest();
  const computedHex = createHmac('sha256', secretKey).update(dataCheckString).digest('hex');

  const expected = Buffer.from(computedHex, 'utf8');
  const received = Buffer.from(hash.trim().toLowerCase(), 'utf8');
  if (expected.length !== received.length || !timingSafeEqual(expected, received)) {
    return { ok: false, reason: 'bad_signature' };
  }

  const authDateSec = Number(params.get('auth_date'));
  if (!Number.isFinite(authDateSec) || authDateSec <= 0) {
    return { ok: false, reason: 'missing_auth_date' };
  }
  const nowSec = Math.floor(Date.now() / 1000);
  const ageSec = nowSec - authDateSec;
  // Reject future auth_date beyond 5min clock skew (prevents indefinite replay).
  if (ageSec < -300) return { ok: false, reason: 'future_auth_date' };
  if (ageSec > maxAgeSec) return { ok: false, reason: 'stale_auth_date' };

  let user: TgUser | undefined;
  const rawUser = params.get('user');
  if (rawUser) {
    try {
      const parsed: unknown = JSON.parse(rawUser);
      if (parsed && typeof parsed === 'object' && typeof (parsed as Record<string, unknown>).id !== 'undefined') {
        const obj = parsed as Record<string, unknown>;
        user = {
          id: Number(obj.id),
          username: typeof obj.username === 'string' ? obj.username : undefined,
          first_name: typeof obj.first_name === 'string' ? obj.first_name : undefined,
          last_name: typeof obj.last_name === 'string' ? obj.last_name : undefined,
        };
      }
    } catch {
      // best-effort: malformed user JSON means "no verified user", not a crash.
      user = undefined;
    }
  }

  return user ? { ok: true, user } : { ok: true };
}
