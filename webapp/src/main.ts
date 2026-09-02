import './styles/app.css';
import './styles/tokens.css';

import { TG } from './lib/tg';
import { Api } from './lib/api';
import { UI } from './lib/ui';
import { ChatCrypto } from './lib/crypto';
import { Wallet } from './lib/wallet';

// expose globals for legacy app.js (expects window.TG, Api, UI, ChatCrypto, Wallet)
(window as any).TG = TG;
(window as any).Api = Api;
(window as any).UI = UI;
(window as any).ChatCrypto = ChatCrypto;
(window as any).Wallet = Wallet;

// TON Connect config (GitHub raw, no cloudflared)
(window as any).TONCONNECT_MANIFEST_URL = "https://raw.githubusercontent.com/Hamroqulovv/raw-ton-m/main/tonconnect-manifest.json";
(window as any).TONCONNECT_TWA_RETURN_URL = "https://t.me/uzsavdochibot/app";
(window as any).APP_CONFIG = {
  manifestUrl: (window as any).TONCONNECT_MANIFEST_URL,
  twaReturnUrl: (window as any).TONCONNECT_TWA_RETURN_URL,
};

// Ensure Vite HMR for CSS works
TG.init();

// Dynamic import legacy after globals are set (avoid hoisting where bare TG would be undefined in ES module)
await import('./legacy/app.js');

const { patchApp } = await import('./patches');
patchApp();

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
