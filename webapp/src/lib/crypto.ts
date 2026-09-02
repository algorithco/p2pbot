const ALGO = 'AES-GCM';
const keyCache: Record<string, { key: CryptoKey; _b64: string }> = {};

function b64ToBytes(b64: string): Uint8Array {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}
function bytesToB64(bytes: Uint8Array): string {
  let bin = '';
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
  return btoa(bin);
}
function hasWebCrypto(): boolean {
  return !!(window.crypto && (window.crypto as any).subtle);
}
async function importKey(b64Key: string): Promise<CryptoKey> {
  const raw = b64ToBytes(b64Key);
  if (raw.length !== 32) throw new Error('invalid_key_length');
  if (!hasWebCrypto()) throw new Error('webcrypto_unavailable');
  return await window.crypto.subtle.importKey('raw', raw, { name: ALGO }, false, ['encrypt', 'decrypt']);
}
async function encrypt(plaintext: string, b64Key: string): Promise<string> {
  if (!plaintext) return '';
  const key = await importKey(b64Key);
  const iv = window.crypto.getRandomValues(new Uint8Array(12));
  const enc = new TextEncoder().encode(plaintext);
  const cipherBuf = await window.crypto.subtle.encrypt({ name: ALGO, iv, tagLength: 128 } as any, key, enc);
  const cipherBytes = new Uint8Array(cipherBuf);
  const tagLen = 16;
  const encLen = cipherBytes.length - tagLen;
  const tag = cipherBytes.slice(encLen);
  const ct = cipherBytes.slice(0, encLen);
  const out = new Uint8Array(12 + 16 + ct.length);
  out.set(iv, 0);
  out.set(tag, 12);
  out.set(ct, 28);
  return bytesToB64(out);
}
async function decrypt(b64Cipher: string, b64Key: string): Promise<string> {
  if (!b64Cipher) return '';
  const key = await importKey(b64Key);
  const combined = b64ToBytes(b64Cipher);
  if (combined.length < 28) throw new Error('ciphertext_too_short');
  const iv = combined.slice(0, 12);
  const tag = combined.slice(12, 28);
  const ct = combined.slice(28);
  const cipherInput = new Uint8Array(ct.length + tag.length);
  cipherInput.set(ct, 0);
  cipherInput.set(tag, ct.length);
  const plainBuf = await window.crypto.subtle.decrypt({ name: ALGO, iv, tagLength: 128 } as any, key, cipherInput);
  return new TextDecoder().decode(plainBuf);
}
function isAvailable(): boolean {
  try { return !!(window.crypto && (window.crypto as any).subtle); } catch { return false; }
}
export const ChatCrypto = {
  isAvailable,
  encrypt,
  decrypt,
  b64ToBytes,
  bytesToB64,
  clearCache(dealId?: string | number) {
    if (dealId) delete keyCache[String(dealId)];
    else for (const k in keyCache) delete keyCache[k];
  },
};
export default ChatCrypto;
