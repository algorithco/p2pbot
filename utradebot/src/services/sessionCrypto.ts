import * as crypto from 'crypto';
import { config } from '../config';

function getKey(): Buffer | null {
  if (!config.encryptionKey) return null;
  try {
    return Buffer.from(config.encryptionKey, 'hex');
  } catch {
    return null;
  }
}

export function encryptSession(plain: string): string {
  const key = getKey();
  if (!key) {
    // Fail-closed in production: never silently persist a plaintext session.
    if (process.env.NODE_ENV === 'production' || process.env.STRICT_ENCRYPTION === 'true') {
      throw new Error('encryption_not_configured: ENCRYPTION_KEY missing or invalid — refusing to store plaintext session in production');
    }
    // No key: return plain with warning marker (caller should ensure key is set in prod)
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
  if (!key) return encB64;
  // Try to detect if already plain (not base64 of iv+tag+enc)
  try {
    const buf = Buffer.from(encB64, 'base64');
    if (buf.length < 28) return encB64;
    // Heuristic: plain StringSessions start with "1" and are longer than 100 chars but our enc is also base64; try decrypt
    const iv = buf.subarray(0, 12);
    const tag = buf.subarray(12, 28);
    const enc = buf.subarray(28);
    const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv);
    decipher.setAuthTag(tag);
    const dec = Buffer.concat([decipher.update(enc), decipher.final()]);
    const res = dec.toString('utf8');
    // If decrypted looks like session (or at least non-empty), return it; else fallback to original
    if (res && res.length > 10) return res;
    return encB64;
  } catch {
    return encB64;
  }
}

export function hasEncryption(): boolean {
  return !!getKey();
}

export function maskPhone(phone: string): string {
  if (!phone || phone.length < 4) return '****';
  return phone.slice(0, 3) + '****' + phone.slice(-2);
}
