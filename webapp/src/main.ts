import './styles/app.css';
import './styles/tokens.css';
import './styles/gooey-nav.css';
import './styles/true-focus.css';

import { TG } from './lib/tg';
import { Api } from './lib/api';
import { UI } from './lib/ui';
import { ChatCrypto } from './lib/crypto';
import { Wallet } from './lib/wallet';
import { FX } from './lib/motion';
import { mountLoader } from './lib/loader';

// expose globals for legacy app.js (expects window.TG, Api, UI, ChatCrypto, Wallet, FX)
(window as any).TG = TG;
(window as any).Api = Api;
(window as any).UI = UI;
(window as any).ChatCrypto = ChatCrypto;
(window as any).Wallet = Wallet;
(window as any).FX = FX;
// Home hero uses a CSS aurora backdrop (Three.js removed) — same mount API
// so legacy viewHome keeps working unchanged.
(window as any).HeroFX = {
  mount: (host: HTMLElement) => {
    try {
      host.classList.add('hero-aurora');
    } catch {}
    return () => {
      try {
        host.classList.remove('hero-aurora');
      } catch {}
    };
  },
};

// TON Connect config (GitHub raw, no cloudflared)
(window as any).TONCONNECT_MANIFEST_URL =
  'https://raw.githubusercontent.com/Hamroqulovv/raw-ton-m/main/tonconnect-manifest.json';
(window as any).TONCONNECT_TWA_RETURN_URL = 'https://t.me/savdochi_uzbot/app';
(window as any).APP_CONFIG = {
  manifestUrl: (window as any).TONCONNECT_MANIFEST_URL,
  twaReturnUrl: (window as any).TONCONNECT_TWA_RETURN_URL,
};

// TrueFocus 4.5s loader — starts immediately, runs in parallel with app boot
const loaderDone = mountLoader();

// Ensure Vite HMR for CSS works
TG.init();

// Dynamic import legacy after globals are set (avoid hoisting where bare TG would be undefined in ES module)
await import('./legacy/app.js');

const { patchApp } = await import('./patches');
patchApp();

// Keep app hidden until loader completes its 2s reveal (avoids flash)
try {
  const appEl = document.getElementById('app') as HTMLElement | null;
  if (appEl) {
    appEl.style.opacity = '0';
    appEl.style.transition = 'opacity .38s ease';
    loaderDone.then(() => {
      // Reveal: overrides the inline critical CSS (#app{visibility:hidden})
      // that kept the home shell out of the first paint before JS ran.
      appEl.style.visibility = 'visible';
      appEl.style.opacity = '1';
      // trigger hero entrance after loader
      setTimeout(() => {
        try {
          (window as any).FX?.fadeUp?.(document.querySelector('.hero') as any);
        } catch {}
      }, 80);
    });
  } else {
    await loaderDone;
  }
} catch {
  await loaderDone;
}

// Join intent resolution — the bot button carries the invite THREE ways
// (hash route, ?startapp= query, Telegram start_param) because some clients
// drop the URL fragment when opening a web_app. First hit wins; the hash
// route is canonical and we navigate to it when it isn't already set.
function parseJoinParam(sp: string): { id: string; token: string } | null {
  try {
    if (!sp) return null;
    if (sp.indexOf('.') !== -1) {
      const [id, token] = sp.split('.');
      if (id && /^\d+$/.test(id) && token) return { id, token };
      return null;
    }
    if (sp.startsWith('join_')) {
      const parts = sp.split('_');
      if (parts.length >= 3) {
        const dealId = parts[1];
        const token = parts.slice(2).join('_');
        if (/^\d+$/.test(dealId) && token) return { id: dealId, token };
      }
    }
  } catch {}
  return null;
}

function resolveJoinIntent(): { id: string; token: string } | null {
  try {
    // 1. Canonical hash route #/deal/<id>/join/<token> (already where we need to be)
    const hm = (location.hash || '').match(/^#\/deal\/(\d+)\/join\/([A-Za-z0-9_-]+)/);
    if (hm) return { id: hm[1], token: hm[2] };
    // 2. Query redundancy from the bot button: ?startapp=join_<id>_<token>
    const qs = new URLSearchParams(location.search || '');
    const q = parseJoinParam(qs.get('startapp') || qs.get('start_param') || '');
    if (q) return q;
    // 3. Explicit ?deal=<id>&token=<token> (or ?join=<id>.<token>)
    const qd = qs.get('deal');
    const qt = qs.get('token');
    if (qd && /^\d+$/.test(qd) && qt) return { id: qd, token: qt };
    const qj = parseJoinParam(qs.get('join') || '');
    if (qj) return qj;
    // 4. Path form /join/<id>/<token> or /deal/<id>/join/<token> (nginx SPA fallback)
    const pm = location.pathname.match(/^\/(?:join\/(\d+)\/([A-Za-z0-9_-]+)|deal\/(\d+)\/join\/([A-Za-z0-9_-]+))\/?$/);
    if (pm) {
      const id = pm[1] || pm[3];
      const token = pm[2] || pm[4];
      if (id && token) return { id, token };
    }
    // 5. Telegram start_param (t.me/<bot>/app?startapp=...)
    return parseJoinParam(TG.startParam());
  } catch {}
  return null;
}

function applyJoinIntent(): boolean {
  try {
    const intent = resolveJoinIntent();
    if (!intent) return false;
    const want = `#/deal/${intent.id}/join/${intent.token}`;
    if ((location.hash || '') !== want) location.hash = want;
    return true;
  } catch {}
  return false;
}

// Apply immediately (before the legacy router boots) so the first paint is the
// join page, then re-check late (Telegram can inject start_param after load).
applyJoinIntent();
setTimeout(() => {
  applyJoinIntent();
}, 600);
setTimeout(() => {
  applyJoinIntent();
}, 2500);
