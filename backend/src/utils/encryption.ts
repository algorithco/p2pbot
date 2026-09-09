import * as crypto from 'crypto';
import { config } from '../config';

/**
 * Master key for at-rest encryption (AES-256-GCM).
 * - Reuses ubot/utradebot pattern: 64 hex chars = 32 bytes.
 * - Supports 128 hex (64 bytes) by hashing to 32 bytes for compatibility.
 * - If ENCRYPTION_KEY not set, helpers become no-ops (plaintext) with warning.
 */
export function getMasterKey(): Buffer | null {
  const raw = (config.encryptionKey || '').trim();
  if (!raw) return null;
  try {
    const buf = Buffer.from(raw, 'hex');
    if (buf.length === 32) return buf;
    if (buf.length === 64) {
      return crypto.createHash('sha256').update(buf).digest();
    }
    if (buf.length === 0) return null;
    return null;
  } catch {
    return null;
  }
}

export function isEncryptionEnabled(): boolean {
  return !!getMasterKey();
}

/**
 * Strict mode: production, or explicit opt-in via STRICT_ENCRYPTION=true (for
 * staging hosts where NODE_ENV is not reliably set — the backend Dockerfile sets
 * NODE_ENV=production, but a bare `node dist/index.js` run may not).
 */
export function isStrictEncryptionEnv(): boolean {
  return process.env.NODE_ENV === 'production' || process.env.STRICT_ENCRYPTION === 'true';
}

/**
 * Fail-closed gate for boot: in strict mode a missing/malformed ENCRYPTION_KEY
 * must refuse to start instead of silently falling back to plaintext.
 * Non-strict envs keep the warn-and-fallback path so local dev isn't blocked.
 */
export function assertEncryptionForStrictEnv(): void {
  if (!isStrictEncryptionEnv()) return;
  if (!getMasterKey()) {
    throw new Error(
      'ENCRYPTION_KEY missing or malformed (need 64 or 128 hex chars) — refusing to boot with NODE_ENV=production / STRICT_ENCRYPTION=true (would store chat keys + memos in plaintext)'
    );
  }
}

let encryptionStatusWarned = false;
/** Loud once-only startup banner for non-strict envs running without encryption. */
export function warnIfEncryptionDisabledOnce(): void {
  if (encryptionStatusWarned) return;
  encryptionStatusWarned = true;
  if (!getMasterKey()) {
    console.warn(
      '[encryption] WARNING: ENCRYPTION_KEY not set or invalid — chat keys, memos and phone fields FALL BACK TO PLAINTEXT. Dev-only posture; production refuses to boot like this.'
    );
  }
}

/** At-rest field encryption: iv(12) + tag(16) + ciphertext -> base64 */
export function encryptField(plain: string): string {
  const key = getMasterKey();
  if (!key) return plain;
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  const enc = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return Buffer.concat([iv, tag, enc]).toString('base64');
}

export function decryptField(b64: string): string {
  const key = getMasterKey();
  if (!key) return b64;
  try {
    const buf = Buffer.from(b64, 'base64');
    if (buf.length < 28) return b64;
    const iv = buf.subarray(0, 12);
    const tag = buf.subarray(12, 28);
    const enc = buf.subarray(28);
    const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv);
    decipher.setAuthTag(tag);
    const dec = Buffer.concat([decipher.update(enc), decipher.final()]);
    return dec.toString('utf8');
  } catch {
    return b64;
  }
}

/** Per-deal chat key: 32 random bytes -> base64 (44 chars) */
export function generateDealChatKey(): string {
  return crypto.randomBytes(32).toString('base64');
}

export function encryptDealKey(plainKeyB64: string): string {
  const key = getMasterKey();
  if (!key) return plainKeyB64;
  return encryptField(plainKeyB64);
}

export function decryptDealKey(stored: string): string {
  const key = getMasterKey();
  if (!key) return stored;
  if (!stored) return stored;
  // Heuristic: stored as base64 encrypted field will be longer than 44 chars and decrypt to base64
  try {
    const dec = decryptField(stored);
    // Validate that decrypted looks like base64 32 bytes
    if (dec && Buffer.from(dec, 'base64').length === 32) return dec;
    // If decryptField returned input unchanged (not encrypted), fallback
    if (dec === stored && Buffer.from(stored, 'base64').length === 32) return stored;
    return dec || stored;
  } catch {
    return stored;
  }
}

/** Hash a one-time link token for storage (hex sha256). */
export function hashToken(token: string): string {
  return crypto.createHash('sha256').update(token).digest('hex');
}

/** E2E per-deal message encryption: same format iv+tag+enc base64, key is per-deal base64 */
export function encryptWithDealKey(plaintext: string, dealKeyB64: string): string {
  const key = Buffer.from(dealKeyB64, 'base64');
  if (key.length !== 32) throw new Error('invalid_deal_key');
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  const enc = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return Buffer.concat([iv, tag, enc]).toString('base64');
}

export function decryptWithDealKey(b64: string, dealKeyB64: string): string {
  const key = Buffer.from(dealKeyB64, 'base64');
  if (key.length !== 32) throw new Error('invalid_deal_key');
  const buf = Buffer.from(b64, 'base64');
  if (buf.length < 28) throw new Error('ciphertext_too_short');
  const iv = buf.subarray(0, 12);
  const tag = buf.subarray(12, 28);
  const enc = buf.subarray(28);
  const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv);
  decipher.setAuthTag(tag);
  const dec = Buffer.concat([decipher.update(enc), decipher.final()]);
  return dec.toString('utf8');
}

/** Timing-safe token comparison (hashes first). */
export function safeTokenEqual(a: string, b: string): boolean {
  const ha = crypto.createHash('sha256').update(String(a)).digest();
  const hb = crypto.createHash('sha256').update(String(b)).digest();
  return crypto.timingSafeEqual(ha, hb);
}
