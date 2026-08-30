import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import { config } from './config';
import logger from './logger';

const SESSIONS_DIR = path.resolve(process.cwd(), 'sessions');
const SESSION_FILE = path.join(SESSIONS_DIR, 'ubot.session.enc');

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
  try {
    const buf = Buffer.from(encB64, 'base64');
    if (buf.length < 28) return encB64; // not encrypted? return as-is
    const iv = buf.subarray(0, 12);
    const tag = buf.subarray(12, 28);
    const enc = buf.subarray(28);
    const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv);
    decipher.setAuthTag(tag);
    const dec = Buffer.concat([decipher.update(enc), decipher.final()]);
    return dec.toString('utf8');
  } catch (e) {
    // If decryption fails, assume plain session
    logger.warn('decryptSession failed, treating as plain', e);
    return encB64;
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
