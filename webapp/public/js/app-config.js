/* app-config.js — TON Connect manifest URL configuration
 *
 * For local dev, leave TONCONNECT_MANIFEST_URL empty to use the local backend manifest:
 *   location.origin + '/tonconnect-manifest.json'  (served by backend/src/index.ts:142)
 *
 * For production WITHOUT cloudflared (GitHub raw hosting):
 *   1. Push `tonconnect-manifest.json` at repo root to your GitHub repo.
 *   2. Replace YOUR_USERNAME / YOUR_REPO below with your own GitHub account.
 *   3. This URL will be used by TON Connect wallets — no cloudflare tunnel needed.
 *
 * When you "deploy fully" (custom domain + HTTPS), switch this back to "" to use local manifest
 * served via https://your-domain/tonconnect-manifest.json
 */
window.TONCONNECT_MANIFEST_URL = "https://raw.githubusercontent.com/Hamroqulovv/raw-ton-m/main/tonconnect-manifest.json";
// Alternative CDN (jsDelivr) — also works, better CORS/caching:
// window.TONCONNECT_MANIFEST_URL = "https://cdn.jsdelivr.net/gh/Hamroqulovv/raw-ton-m@main/tonconnect-manifest.json";

// TWA return URL — where wallet should return after approving in Telegram
// For local dev, leave as undefined (SDK uses 'back'). For prod Mini App, set to https://t.me/<bot_username>/<app_shortname>
// Known bot: @uzsavdochibot — adjust app shortname if different (check @BotFather -> /myapps)
window.TONCONNECT_TWA_RETURN_URL = "https://t.me/uzsavdochibot/app";
