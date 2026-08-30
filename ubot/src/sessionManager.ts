import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import { config } from './config';
import logger from './logger';

const SESSIONS_DIR = path.resolve(process.cwd(), 'sessions');
const SESSION_FILE = path.join(SESSIONS_DIR, 'ubot.session.enc');

function getKey(): Buffer | null {
  if (!config.encryptionKey) return null;
  // Enforce 32 bytes (64 hex chars) for aes-256-gcm; handle 64-byte (128 hex) by hashing
  try {
    const buf = Buffer.from(config.encryptionKey.trim(), 'hex');
    if (buf.length === 32) return buf;
    if (buf.length === 64) {
      // Old key was 64 bytes (128 hex) — hash to 32 bytes for compatibility
      return require('crypto').createHash('sha256').update(buf).digest();
    }
    if (buf.length !== 32) {
      logger.warn(`ENCRYPTION_KEY invalid length ${buf.length} bytes (expected 32), encryption disabled`);
      return null;
    }
    return buf;
  } catch {
    return null;
  }
}

export function encryptSession(plain: string): string {
  const key = getKey();
  if (!key) return plain; // no encryption if key not set (warn)
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  const enc = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  // iv:12 + tag:16 + enc
  return Buffer.concat([iv, tag, enc]).toString('base64');
}

export function decryptSession(encB64: string): string {
  const key = getKey();
  if (!key) return encB64;
  // Heuristic: plain StringSession (teleproto) starts with '1' and is long base64, not our iv+tag+enc
  // If it looks like plain, skip decrypt attempt to avoid noisy warn every healthcheck
  const trimmed = encB64.trim();
  if (trimmed.startsWith('1') && trimmed.length > 50 && !trimmed.includes(' ')) {
    // Try base64 decode; if it decodes to something that is not our encrypted format, treat as plain
    // Our encrypted format is iv(12)+tag(16)+cipher, base64 length will be different, but plain StringSession is also base64
    // To avoid false decrypt, check if decrypt would fail — we do a quick check: if trimmed is a valid StringSession, return plain
    // StringSessions are base64 of auth key, typically ~200-300 chars, starting with '1'
    // Encrypted sessions from encryptSession are also base64 but will decrypt to a StringSession starting with '1'
    // We try decrypt, but on failure return plain without warn
    try {
      const buf = Buffer.from(trimmed, 'base64');
      if (buf.length < 28) return trimmed;
      const iv = buf.subarray(0, 12);
      const tag = buf.subarray(12, 28);
      const enc = buf.subarray(28);
      const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv);
      decipher.setAuthTag(tag);
      const dec = Buffer.concat([decipher.update(enc), decipher.final()]);
      const res = dec.toString('utf8');
      if (res && res.length > 10) return res;
      return trimmed;
    } catch {
      // Not encrypted or invalid tag — treat as plain without warn (expected for plain StringSession)
      return trimmed;
    }
  }
  try {
    const buf = Buffer.from(trimmed, 'base64');
    if (buf.length < 28) return trimmed;
    const iv = buf.subarray(0, 12);
    const tag = buf.subarray(12, 28);
    const enc = buf.subarray(28);
    const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv);
    decipher.setAuthTag(tag);
    const dec = Buffer.concat([decipher.update(enc), decipher.final()]);
    return dec.toString('utf8');
  } catch {
    return trimmed;
  }
}

export function saveEncryptedSession(sessionStr: string): void {
  const enc = encryptSession(sessionStr);
  if (!fs.existsSync(SESSIONS_DIR)) fs.mkdirSync(SESSIONS_DIR, { recursive: true });
  fs.writeFileSync(SESSION_FILE, enc, { mode: 0o600 });
  // Also try to set tight perms on dir
  try {
    fs.chmodSync(SESSION_FILE, 0o600);
  } catch {}
  logger.info('Session saved (encrypted)');
}

export function loadEncryptedSession(): string | null {
  // Priority: env UBOT_SESSION_STRING (decrypt if encrypted), then file
  if (config.sessionString) {
    const dec = decryptSession(config.sessionString.trim());
    if (dec) return dec;
  }
  if (fs.existsSync(SESSION_FILE)) {
    const enc = fs.readFileSync(SESSION_FILE, 'utf8').trim();
    if (enc) return decryptSession(enc);
  }
  return null;
}

export function hasEncryption(): boolean {
  return !!getKey();
}
