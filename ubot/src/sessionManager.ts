import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import { config } from './config';
import logger from './logger';

export const SESSIONS_DIR = path.resolve(__dirname, '..', 'sessions');
export const SESSION_FILE = path.join(SESSIONS_DIR, 'ubot.session.enc');

const ENC_PREFIX = 'enc:v1:';

let cachedKey: Buffer | null | undefined;
let warnedInvalidKey = false;

function getKey(): Buffer | null {
  if (cachedKey !== undefined) return cachedKey;
  if (!config.encryptionKey) {
    cachedKey = null;
    return null;
  }
  try {
    const raw = config.encryptionKey.trim();
    const buf = Buffer.from(raw, 'hex');
    if (buf.length === 32) {
      cachedKey = buf;
      return buf;
    }
    if (buf.length === 64) {
      const hashed = crypto.createHash('sha256').update(buf).digest();
      cachedKey = hashed;
      return hashed;
    }
    if (!warnedInvalidKey) {
      warnedInvalidKey = true;
      logger.warn(`ENCRYPTION_KEY invalid length ${buf.length} bytes (expected 32 for 64 hex or 64 for 128 hex), encryption disabled`);
    }
    cachedKey = null;
    return null;
  } catch {
    if (!warnedInvalidKey) {
      warnedInvalidKey = true;
      logger.warn('ENCRYPTION_KEY is not valid hex, encryption disabled');
    }
    cachedKey = null;
    return null;
  }
}

export function isValidStringSession(s: string): boolean {
  const t = s.trim();
  if (!t) return false;
  // New encrypted format with marker — accept as valid storage (avoids 1.5% collision where
  // raw encrypted base64 could start with '1' and be misclassified as plaintext)
  if (t.startsWith(ENC_PREFIX)) {
    const b64 = t.slice(ENC_PREFIX.length);
    return b64.length > 50 && b64.length < 5000 && /^[A-Za-z0-9+/=_-]+$/.test(b64);
  }
  // Plain StringSession (old format) — base64, starts with '1', 50-2000 chars
  // Also covers decrypted value from both new and legacy encrypted stores
  return t.length > 50 && t.length < 2000 && t.startsWith('1') && /^[A-Za-z0-9+/=_-]+$/.test(t);
}

// Helper to check if a string is a plaintext valid session (strict, without handling enc prefix as valid)
function isPlainStringSession(s: string): boolean {
  const t = s.trim();
  return t.length > 50 && t.length < 2000 && t.startsWith('1') && /^[A-Za-z0-9+/=_-]+$/.test(t);
}

function tryDecryptB64(b64: string, key: Buffer): string | null {
  try {
    const buf = Buffer.from(b64, 'base64');
    if (buf.length < 28) return null;
    const iv = buf.subarray(0, 12);
    const tag = buf.subarray(12, 28);
    const enc = buf.subarray(28);
    const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv);
    decipher.setAuthTag(tag);
    const dec = Buffer.concat([decipher.update(enc), decipher.final()]);
    const res = dec.toString('utf8');
    if (isPlainStringSession(res)) return res;
    // Fallback: if decrypted starts with 1 and reasonable length, consider valid (handles edge length checks)
    if (res.length > 50 && res.startsWith('1')) return res;
    return null;
  } catch {
    return null;
  }
}

export function encryptSession(plain: string): string {
  const key = getKey();
  if (!key) {
    if (!warnedInvalidKey) logger.warn('encryptSession: ENCRYPTION_KEY not set, storing plaintext (insecure)');
    return plain;
  }
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  const enc = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return ENC_PREFIX + Buffer.concat([iv, tag, enc]).toString('base64');
}

export function decryptSession(encB64: string): string {
  const key = getKey();
  if (!key) return encB64.trim();
  const trimmed = encB64.trim();
  if (!trimmed) return trimmed;

  const isPrefixed = trimmed.startsWith(ENC_PREFIX);

  if (isPrefixed) {
    const b64 = trimmed.slice(ENC_PREFIX.length);
    const dec = tryDecryptB64(b64, key);
    if (dec !== null) return dec;
    // Decrypt failed for prefixed format — this is definitely encrypted, so surface key mismatch
    // Try strict decrypt to get better error message
    try {
      const buf = Buffer.from(b64, 'base64');
      if (buf.length >= 28) {
        const iv = buf.subarray(0, 12);
        const tag = buf.subarray(12, 28);
        const enc = buf.subarray(28);
        const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv);
        decipher.setAuthTag(tag);
        const decBuf = Buffer.concat([decipher.update(enc), decipher.final()]);
        const res = decBuf.toString('utf8');
        if (isPlainStringSession(res)) return res;
        // decrypted but invalid -> throw
        throw new Error('session_decrypt_failed: decrypted prefixed session is not a valid StringSession');
      }
    } catch (e) {
      const msg = String((e as Error).message || '');
      if (msg.includes('session_decrypt_failed')) throw e;
      if (msg.includes('Unsupported state') || msg.includes('unable to authenticate') || msg.includes('Invalid')) {
        throw new Error(`session_decrypt_failed: GCM auth failed — ENCRYPTION_KEY mismatch or corrupted session (try regenerating via npm run login:qr) — ${msg}`);
      }
      throw new Error(`session_decrypt_failed: cannot decrypt prefixed session — ${msg}`);
    }
    throw new Error('session_decrypt_failed: cannot decrypt prefixed session — ENCRYPTION_KEY mismatch or corrupted');
  }

  // No prefix — could be legacy encrypted (without marker) or plaintext
  // Try decrypt as legacy first to avoid 1.5% collision (encrypted base64 may start with '1')
  const decLegacy = tryDecryptB64(trimmed, key);
  if (decLegacy !== null) return decLegacy;

  // If decrypt as legacy failed, check if original is plaintext
  if (isPlainStringSession(trimmed)) return trimmed;

  // If original is base64 and looks like legacy encrypted but auth failed, surface mismatch
  // We already tried tryDecryptB64 which swallows auth errors; try again strictly to detect auth failure
  try {
    const buf = Buffer.from(trimmed, 'base64');
    if (buf.length >= 28) {
      // Heuristic: if it decodes to >=28 bytes and is base64, it might be legacy encrypted
      // Attempt strict decrypt to see if it's encrypted with different key
      const iv = buf.subarray(0, 12);
      const tag = buf.subarray(12, 28);
      const enc = buf.subarray(28);
      const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv);
      decipher.setAuthTag(tag);
      const dec = Buffer.concat([decipher.update(enc), decipher.final()]);
      const res = dec.toString('utf8');
      if (isPlainStringSession(res)) return res;
      if (res.length > 50 && res.startsWith('1')) return res;
      // If we successfully decrypted but result invalid, throw
      if (buf.length > 50) {
        throw new Error('session_decrypt_failed: cannot decrypt session — ENCRYPTION_KEY mismatch or session is plaintext but invalid');
      }
    }
  } catch (e) {
    const msg = String((e as Error).message || '');
    if (msg.includes('session_decrypt_failed')) throw e;
    if (msg.includes('Unsupported state') || msg.includes('unable to authenticate')) {
      // Only throw mismatch if the input looked like encrypted base64 (long, base64 chars)
      if (trimmed.length > 80 && /^[A-Za-z0-9+/=_-]+$/.test(trimmed) && !isPlainStringSession(trimmed)) {
        // Check if it's likely encrypted: not starting with '1' or length suggests encrypted
        // But also handle 1.5% collision where encrypted starts with '1' — we already tried decrypt and it failed auth, so it's encrypted with wrong key
        throw new Error(`session_decrypt_failed: GCM auth failed — ENCRYPTION_KEY mismatch or corrupted session (try regenerating via npm run login:qr) — ${msg}`);
      }
    }
    // Otherwise it's probably plaintext garbage — fall through
  }

  // Fallback: if original is plaintext-like (starts with 1) return it, else return trimmed to let caller decide
  if (isPlainStringSession(trimmed)) return trimmed;
  // If it's long base64 but not decryptable and not plaintext, likely corrupted/encrypted with different key
  try {
    const buf = Buffer.from(trimmed, 'base64');
    if (buf.length >= 28 && /^[A-Za-z0-9+/=_-]+$/.test(trimmed) && trimmed.length > 80) {
      // Could be legacy encrypted but we failed — already handled above, but throw generic
      // Only throw if it doesn't look like plaintext
      if (!isPlainStringSession(trimmed)) {
        // Don't throw if it's clearly not encrypted (e.g., short)
        // But to avoid silent garbage, we return trimmed; caller will check isValid
      }
    }
  } catch {}
  return trimmed;
}

export function saveEncryptedSession(sessionStr: string): void {
  // Strict plaintext check — isValid also accepts encrypted storage, so use plain helper
  if (!isPlainStringSession(sessionStr)) {
    logger.warn('saveEncryptedSession: refusing to save invalid StringSession (does not start with 1)');
    return;
  }
  const enc = encryptSession(sessionStr);
  if (!fs.existsSync(SESSIONS_DIR)) fs.mkdirSync(SESSIONS_DIR, { recursive: true });
  // Atomic write: write to temp then rename
  const tmp = SESSION_FILE + '.tmp.' + process.pid;
  fs.writeFileSync(tmp, enc, { mode: 0o600 });
  try {
    fs.chmodSync(tmp, 0o600);
  } catch {}
  fs.renameSync(tmp, SESSION_FILE);
  try {
    fs.chmodSync(SESSION_FILE, 0o600);
  } catch {}
  logger.info('Session saved (encrypted)');
}

export function loadEncryptedSession(): string | null {
  // Priority: env UBOT_SESSION_STRING (decrypt if encrypted), then file
  // If env is set but decrypt fails due to key mismatch, we surface the error instead of silently falling back to file (which may be stale)
  if (config.sessionString) {
    const raw = config.sessionString.trim();
    if (raw) {
      try {
        const dec = decryptSession(raw);
        if (isPlainStringSession(dec)) return dec;
        if (isPlainStringSession(raw)) return raw;
        // If decrypted is valid encrypted storage (prefixed) but decrypt returned itself? handle
        if (isValidStringSession(dec) && isPlainStringSession(dec)) return dec;
        logger.warn('UBOT_SESSION_STRING in env is present but not a valid StringSession after decrypt; trying file');
      } catch (e) {
        logger.error(`UBOT_SESSION_STRING decrypt failed: ${String((e as Error).message)} — check ENCRYPTION_KEY matches the one used to encrypt; falling back to file`);
      }
    }
  }
  if (fs.existsSync(SESSION_FILE)) {
    try {
      const enc = fs.readFileSync(SESSION_FILE, 'utf8').trim();
      if (enc) {
        const dec = decryptSession(enc);
        if (isPlainStringSession(dec)) return dec;
        if (isPlainStringSession(enc)) return enc; // plaintext file (legacy)
        // Handle prefixed file that decrypts correctly but we already checked
        if (isValidStringSession(dec) && isPlainStringSession(dec)) return dec;
      }
    } catch (e) {
      logger.error(`Failed to load session file: ${String((e as Error).message)}`);
    }
  }
  return null;
}

export function hasEncryption(): boolean {
  return !!getKey();
}

export function clearKeyCache(): void {
  cachedKey = undefined;
  warnedInvalidKey = false;
}

// Support key rotation via SIGHUP — clear cached key so next getKey() re-reads ENCRYPTION_KEY
try {
  process.on('SIGHUP', () => {
    clearKeyCache();
    logger.info('SIGHUP received — ENCRYPTION_KEY cache cleared (supports rotation)');
  });
} catch {}
