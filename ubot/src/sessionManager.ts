import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import { config } from './config';
import logger from './logger';

const SESSIONS_DIR = path.resolve(__dirname, '..', 'sessions');
const SESSION_FILE = path.join(SESSIONS_DIR, 'ubot.session.enc');

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

function isValidStringSession(s: string): boolean {
  const t = s.trim();
  // teleproto StringSession is base64, starts with '1', 200-600 chars, no spaces
  return t.length > 50 && t.length < 2000 && t.startsWith('1') && /^[A-Za-z0-9+/=_-]+$/.test(t);
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
  return Buffer.concat([iv, tag, enc]).toString('base64');
}

export function decryptSession(encB64: string): string {
  const key = getKey();
  if (!key) return encB64.trim();
  const trimmed = encB64.trim();
  if (!trimmed) return trimmed;
  // If it's clearly plaintext StringSession and not our encrypted format, return as-is
  // Our encrypted format is base64 of iv(12)+tag(16)+cipher, typically >100 chars and NOT starting with '1' in many cases, but can start with '1' ~1.5% due to iv randomness
  // So we try decrypt first; if it yields a valid StringSession, we assume it was encrypted
  try {
    const buf = Buffer.from(trimmed, 'base64');
    if (buf.length >= 28) {
      const iv = buf.subarray(0, 12);
      const tag = buf.subarray(12, 28);
      const enc = buf.subarray(28);
      const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv);
      decipher.setAuthTag(tag);
      const dec = Buffer.concat([decipher.update(enc), decipher.final()]);
      const res = dec.toString('utf8');
      if (isValidStringSession(res)) return res;
      // If decrypted result is not a valid StringSession, it may be plaintext that coincidentally decrypts to garbage — treat as plain only if original was plaintext
      // Fall through to check if original is plaintext
    }
  } catch (e) {
    // Decrypt failed — could be plaintext or wrong key; fall through to plaintext check
    const msg = String((e as Error).message || '');
    if (msg.includes('Unsupported state') || msg.includes('unable to authenticate')) {
      // GCM tag failure — likely wrong key or corrupted data; do NOT silently return ciphertext as plain
      // If original looks like plaintext StringSession, return it; otherwise throw to surface key mismatch
      if (isValidStringSession(trimmed)) return trimmed;
      throw new Error(`session_decrypt_failed: GCM auth failed — ENCRYPTION_KEY mismatch or corrupted session (try regenerating via npm run login:qr) — ${msg}`);
    }
  }
  // If we reach here, decrypt either produced invalid result or was not attempted
  // If original is plaintext StringSession, return it (handles unencrypted legacy)
  if (isValidStringSession(trimmed)) return trimmed;
  // If original is base64 but not decryptable and not plaintext, it's likely corrupted/encrypted with different key
  // Throw to make the error visible rather than feeding garbage to StringSession
  try {
    const buf = Buffer.from(trimmed, 'base64');
    if (buf.length >= 28) {
      throw new Error('session_decrypt_failed: cannot decrypt session — ENCRYPTION_KEY mismatch or session is plaintext but invalid');
    }
  } catch {}
  return trimmed;
}

export function saveEncryptedSession(sessionStr: string): void {
  if (!isValidStringSession(sessionStr)) {
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
        if (isValidStringSession(dec)) return dec;
        // If env value is plaintext but invalid, fall through to file
        if (isValidStringSession(raw)) return raw;
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
        if (isValidStringSession(dec)) return dec;
        if (isValidStringSession(enc)) return enc; // plaintext file
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
