import './styles/app.css';
import './styles/tokens.css';

import { TG } from './lib/tg';
import { Api } from './lib/api';
import { UI } from './lib/ui';
import { ChatCrypto } from './lib/crypto';
import { Wallet } from './lib/wallet';
import { FX } from './lib/motion';
import { mountHeroScene } from './lib/hero-scene';
import { mountLoader } from './lib/loader';

// expose globals for legacy app.js (expects window.TG, Api, UI, ChatCrypto, Wallet, FX)
(window as any).TG = TG;
(window as any).Api = Api;
(window as any).UI = UI;
(window as any).ChatCrypto = ChatCrypto;
(window as any).Wallet = Wallet;
(window as any).FX = FX;
(window as any).HeroFX = { mount: mountHeroScene };

// TON Connect config (GitHub raw, no cloudflared)
(window as any).TONCONNECT_MANIFEST_URL = "https://raw.githubusercontent.com/Hamroqulovv/raw-ton-m/main/tonconnect-manifest.json";
(window as any).TONCONNECT_TWA_RETURN_URL = "https://t.me/uzsavdochibot/app";
(window as any).APP_CONFIG = {
  manifestUrl: (window as any).TONCONNECT_MANIFEST_URL,
  twaReturnUrl: (window as any).TONCONNECT_TWA_RETURN_URL,
};

// Premium 2s loader — starts immediately, runs in parallel with app boot
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
      appEl.style.opacity = '1';
      // trigger hero entrance after loader
      setTimeout(() => { try { (window as any).FX?.fadeUp?.(document.querySelector('.hero') as any); } catch {} }, 80);
    });
  } else {
    await loaderDone;
  }
} catch { await loaderDone; }

// Boot handling for start_param deep links
setTimeout(() => {
  try {
    const sp = TG.startParam();
    if (sp && sp.indexOf('.') !== -1) {
      const [id, token] = sp.split('.');
      if (id && token) location.hash = `#/deal/${id}/join/${token}`;
    } else if (sp && sp.startsWith('join_')) {
      // bot deep link join_<id>_<token>
      const parts = sp.split('_');
      if (parts.length >= 3) {
        const dealId = parts[1];
        const token = parts.slice(2).join('_');
        location.hash = `#/deal/${dealId}/join/${token}`;
      }
    }
  } catch {}
}, 600);
