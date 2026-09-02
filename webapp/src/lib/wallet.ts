import { Api } from './api';

let tc: any = null;
let restorePromise: Promise<any> | null = null;

function getTonConnectClass(): any {
  return (window as any).TonConnectUI || ((window as any).TON_CONNECT_UI && (window as any).TON_CONNECT_UI.TonConnectUI) || (window as any).TON_CONNECT_UI || null;
}
let fallbackInjected = false;
function injectFallbackSdk() {
  if (fallbackInjected || getTonConnectClass()) return;
  fallbackInjected = true;
  try {
    const s = document.createElement('script');
    s.src = 'https://cdn.jsdelivr.net/npm/@tonconnect/ui@2/dist/tonconnect-ui.min.js';
    (s as any).async = false;
    s.onload = () => console.log('[Wallet] fallback CDN loaded');
    s.onerror = () => console.warn('[Wallet] fallback CDN failed');
    document.head.appendChild(s);
  } catch (e) { console.warn('[Wallet] fallback inject error', e); }
  setTimeout(() => {
    if (!getTonConnectClass()) {
      try {
        const s2 = document.createElement('script');
        s2.src = 'https://unpkg.com/@tonconnect/ui@2/dist/tonconnect-ui.min.js';
        (s2 as any).async = false;
        document.head.appendChild(s2);
      } catch {}
    }
  }, 3000);
}
function loadSdk(timeoutMs = 15000): Promise<any> {
  return new Promise((resolve, reject) => {
    const cls = getTonConnectClass();
    if (cls) return resolve(cls);
    const started = Date.now();
    const timeout = timeoutMs;
    setTimeout(() => { if (!getTonConnectClass()) injectFallbackSdk(); }, 1500);
    const poll = () => {
      const c = getTonConnectClass();
      if (c) return resolve(c);
      if (Date.now() - started > timeout) return reject(new Error('wallet_sdk_unavailable'));
      setTimeout(poll, 150);
    };
    poll();
  });
}
function getManifestUrl(): string {
  const cfg = (window as any).TONCONNECT_MANIFEST_URL || ((window as any).APP_CONFIG && (window as any).APP_CONFIG.manifestUrl) || '';
  if (typeof cfg === 'string' && cfg.trim() && cfg.indexOf('YOUR_USERNAME') === -1) return cfg.trim();
  return location.origin + '/tonconnect-manifest.json';
}
function getTwaReturnUrl(): string | undefined {
  const cfg = (window as any).TONCONNECT_TWA_RETURN_URL || ((window as any).APP_CONFIG && (window as any).APP_CONFIG.twaReturnUrl) || '';
  if (typeof cfg === 'string' && cfg.trim() && cfg.indexOf('YOUR_') === -1) return cfg.trim();
  try {
    if ((window as any).Telegram?.WebApp?.initData) return 'https://t.me/uzsavdochibot/app';
  } catch {}
  return undefined;
}
function getAccount(): any {
  if (!tc) return null;
  const acc = tc.account || (tc.wallet && tc.wallet.account) || null;
  if (acc && acc.address) return acc;
  if (tc.wallet?.account?.address) return tc.wallet.account;
  return null;
}
function ensure(): Promise<any> {
  if (restorePromise) return restorePromise;
  restorePromise = loadSdk().then(TC => {
    if (!tc) {
      const opts: any = { manifestUrl: getManifestUrl() };
      const twa = getTwaReturnUrl();
      if (twa) opts.twaReturnUrl = twa;
      tc = new TC(opts);
      if (tc.restoreConnection) { try { tc.restoreConnection(); } catch {} }
    }
    return tc;
  });
  return restorePromise;
}
setTimeout(() => {
  if (getTonConnectClass()) { ensure().catch(()=>{}); }
  else { loadSdk(8000).then(()=> ensure()).catch(()=>{}); }
}, 300);

export const Wallet = {
  available(): boolean { return !!getTonConnectClass(); },
  whenReady: ensure,
  connected(): boolean { return !!getAccount(); },
  address(): string | null { const acc = getAccount(); return acc ? acc.address : null; },
  addressFriendly(): string | null {
    const addr = (this as any).address();
    if (!addr) return null;
    try {
      const UI = (window as any).UI;
      if (UI?.toFriendly) { const f = UI.toFriendly(addr); return f || addr; }
    } catch {}
    return addr;
  },
  chain(): number | null { const acc = getAccount(); return acc && acc.chain != null ? acc.chain : null; },
  walletName(): string { return tc?.wallet ? (tc.wallet.name || tc.wallet.appName || '') : ''; },
  walletInfo(): any { return tc ? tc.wallet : null; },
  connect(): Promise<any> { return ensure().then(w => w.connectWallet()); },
  disconnect(): Promise<any> { if (!tc) return Promise.resolve(); return tc.disconnect ? tc.disconnect() : Promise.resolve(); },
  onStatus(cb: (acc: any)=>void) {
    ensure().then(w => {
      try { cb(getAccount()); } catch {}
      const unsub = w.onStatusChange((wallet: any) => {
        const acc = wallet?.account ? wallet.account : getAccount();
        try { cb(acc || getAccount()); } catch {}
      });
      return unsub;
    }).catch(()=> { try { cb(null); } catch {} });
  },
  getBalance(): Promise<any> {
    const addr = (this as any).address();
    if (!addr) return Promise.reject(new Error('wallet_not_connected'));
    const qAddr = String(addr).trim();
    if ((window as any).Api?.balance) return (window as any).Api.balance(qAddr);
    return Api.balance(qAddr);
  },
  commentPayload(comment: string): Promise<string> {
    const c = String(comment || '').trim();
    if (!c) return Promise.reject(new Error('memo_required'));
    if (c.length > 120) return Promise.reject(new Error('memo_too_long'));
    const url = '/api/ton/payload?comment=' + encodeURIComponent(c);
    return fetch(url, { headers: { 'Accept': 'application/json' } as any }).then(r => {
      if (!r.ok) throw new Error('payload_encode_failed');
      return r.json();
    }).then(j => { if (j?.payload) return j.payload; throw new Error('payload_encode_failed'); });
  },
  pay(to: string, amountTon: number, comment: string): Promise<any> {
    return ensure().then(w => {
      const amt = Number(amountTon);
      if (!isFinite(amt) || amt <= 0) return Promise.reject(new Error('invalid_amount'));
      if (!comment || !String(comment).trim()) return Promise.reject(new Error('memo_required: comment escrow# mandatory'));
      const nano = String(Math.round(amt * 1e9));
      return (Wallet as any).commentPayload(comment).then((payload: string) => w.sendTransaction({
        validUntil: Math.floor(Date.now() / 1000) + 600,
        messages: [{ address: to, amount: nano, payload }],
      }));
    });
  },
};

export default Wallet;
