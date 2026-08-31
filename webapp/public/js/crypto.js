/* crypto.js — E2E AES-256-GCM per-deal encryption for seller-buyer chat
 * Compatible with backend Node.js format: base64( iv(12) + tag(16) + ciphertext )
 * Uses Web Crypto API (AES-GCM) when available, falls back to plaintext warning if not.
 */
(function () {
  'use strict';

  var ALGO = 'AES-GCM';
  var keyCache = {}; // dealId -> CryptoKey

  function b64ToBytes(b64) {
    var bin = atob(b64);
    var out = new Uint8Array(bin.length);
    for (var i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out;
  }

  function bytesToB64(bytes) {
    var bin = '';
    for (var i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
    return btoa(bin);
  }

  function hasWebCrypto() {
    return !!(window.crypto && window.crypto.subtle && window.isSecureContext !== false);
    // Note: Telegram WebView on HTTPS has isSecureContext true; localhost may be false but still works in modern browsers
  }

  async function importKey(b64Key) {
    var raw = b64ToBytes(b64Key);
    if (raw.length !== 32) throw new Error('invalid_key_length');
    if (!hasWebCrypto()) throw new Error('webcrypto_unavailable');
    return await window.crypto.subtle.importKey('raw', raw, { name: ALGO }, false, ['encrypt', 'decrypt']);
  }

  async function getKeyCached(dealId, b64Key) {
    var cacheKey = String(dealId);
    if (keyCache[cacheKey] && keyCache[cacheKey]._b64 === b64Key) return keyCache[cacheKey].key;
    var k = await importKey(b64Key);
    keyCache[cacheKey] = { key: k, _b64: b64Key };
    return k;
  }

  // Encrypt plaintext -> base64(iv+tag+enc) compatible with backend Node
  async function encrypt(plaintext, b64Key) {
    if (!plaintext) return '';
    var key = await importKey(b64Key);
    var iv = window.crypto.getRandomValues(new Uint8Array(12));
    var enc = new TextEncoder().encode(plaintext);
    var cipherBuf = await window.crypto.subtle.encrypt({ name: ALGO, iv: iv, tagLength: 128 }, key, enc);
    var cipherBytes = new Uint8Array(cipherBuf);
    // cipherBytes = ciphertext + tag(16)
    var tagLen = 16;
    var encLen = cipherBytes.length - tagLen;
    var tag = cipherBytes.slice(encLen);
    var ct = cipherBytes.slice(0, encLen);
    var out = new Uint8Array(12 + 16 + ct.length);
    out.set(iv, 0);
    out.set(tag, 12);
    out.set(ct, 28);
    return bytesToB64(out);
  }

  // Decrypt base64(iv+tag+enc) -> plaintext
  async function decrypt(b64Cipher, b64Key) {
    if (!b64Cipher) return '';
    var key = await importKey(b64Key);
    var combined = b64ToBytes(b64Cipher);
    if (combined.length < 28) throw new Error('ciphertext_too_short');
    var iv = combined.slice(0, 12);
    var tag = combined.slice(12, 28);
    var ct = combined.slice(28);
    // Reconstruct WebCrypto input: ct + tag
    var cipherInput = new Uint8Array(ct.length + tag.length);
    cipherInput.set(ct, 0);
    cipherInput.set(tag, ct.length);
    var plainBuf = await window.crypto.subtle.decrypt({ name: ALGO, iv: iv, tagLength: 128 }, key, cipherInput);
    return new TextDecoder().decode(plainBuf);
  }

  // Synchronous try for environments without WebCrypto — returns null so caller can warn
  function isAvailable() {
    try {
      return !!(window.crypto && window.crypto.subtle);
    } catch (e) { return false; }
  }

  window.ChatCrypto = {
    isAvailable: isAvailable,
    encrypt: encrypt,
    decrypt: decrypt,
    getKeyCached: getKeyCached,
    importKey: importKey,
    b64ToBytes: b64ToBytes,
    bytesToB64: bytesToB64,
    clearCache: function (dealId) {
      if (dealId) delete keyCache[String(dealId)];
      else keyCache = {};
    }
  };
})();
