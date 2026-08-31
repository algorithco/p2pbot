/* wallet.js — TON Connect wrapper for the Mini App (lazy-loading, graceful degradation) */
(function () {
  'use strict';

  var tc = null;
  var restorePromise = null;

  function getTonConnectClass() {
    // SDK v2.4.4 UMD exposes TON_CONNECT_UI.TonConnectUI, some builds also TonConnectUI
    return window.TonConnectUI || (window.TON_CONNECT_UI && window.TON_CONNECT_UI.TonConnectUI) || window.TON_CONNECT_UI || null;
  }

  var fallbackInjected = false;
  function injectFallbackSdk() {
    if (fallbackInjected || getTonConnectClass()) return;
    fallbackInjected = true;
    try {
      var s = document.createElement('script');
      s.src = 'https://cdn.jsdelivr.net/npm/@tonconnect/ui@2/dist/tonconnect-ui.min.js';
      s.async = false;
      s.onload = function () { console.log('[Wallet] fallback CDN loaded'); };
      s.onerror = function () { console.warn('[Wallet] fallback CDN failed'); };
      document.head.appendChild(s);
      console.log('[Wallet] injected fallback CDN');
    } catch (e) { console.warn('[Wallet] fallback inject error', e); }
    // Second fallback: unpkg
    setTimeout(function () {
      if (!getTonConnectClass()) {
        try {
          var s2 = document.createElement('script');
          s2.src = 'https://unpkg.com/@tonconnect/ui@2/dist/tonconnect-ui.min.js';
          s2.async = false;
          document.head.appendChild(s2);
          console.log('[Wallet] injected fallback unpkg');
        } catch (e2) {}
      }
    }, 3000);
  }

  function loadSdk(timeoutMs) {
    return new Promise(function (resolve, reject) {
      var cls = getTonConnectClass();
      if (cls) return resolve(cls);
      var started = Date.now();
      var timeout = timeoutMs || 15000;
      setTimeout(function () { if (!getTonConnectClass()) injectFallbackSdk(); }, 1500);
      (function poll() {
        var c = getTonConnectClass();
        if (c) {
          console.log('[Wallet] SDK ready after ' + (Date.now() - started) + 'ms');
          return resolve(c);
        }
        if (Date.now() - started > timeout) {
          console.error('[Wallet] SDK not loaded after ' + timeout + 'ms. window.TonConnectUI=' + !!window.TonConnectUI + ' window.TON_CONNECT_UI=' + !!window.TON_CONNECT_UI);
          return reject(new Error('wallet_sdk_unavailable'));
        }
        setTimeout(poll, 150);
      })();
    });
  }

  function getManifestUrl() {
    var cfg = window.TONCONNECT_MANIFEST_URL || (window.APP_CONFIG && window.APP_CONFIG.manifestUrl) || "";
    if (typeof cfg === "string" && cfg.trim() && cfg.indexOf("YOUR_USERNAME") === -1) {
      return cfg.trim();
    }
    return location.origin + '/tonconnect-manifest.json';
  }

  function getTwaReturnUrl() {
    // 1) Explicit from app-config.js
    var cfg = window.TONCONNECT_TWA_RETURN_URL || (window.APP_CONFIG && window.APP_CONFIG.twaReturnUrl) || "";
    if (typeof cfg === "string" && cfg.trim() && cfg.indexOf("YOUR_") === -1) return cfg.trim();
    // 2) Try to derive from Telegram WebApp
    try {
      if (window.Telegram && window.Telegram.WebApp && window.Telegram.WebApp.initData) {
        // Use bot username if known, else current origin
        // For uzsavdochibot, the Mini App short name is likely 'app' — fallback to t.me link
        var bot = (window.Telegram.WebApp.initDataUnsafe && window.Telegram.WebApp.initDataUnsafe.user) ? null : null;
        // Default to t.me link for this bot (known from logs: @uzsavdochibot)
        return 'https://t.me/uzsavdochibot/app';
      }
    } catch (e) {}
    // 3) Fallback to current page — works for browser testing and when wallet supports 'back' strategy
    return undefined; // let SDK use default 'back'
  }

  function getAccount() {
    if (!tc) return null;
    // TON Connect UI v2 may expose account as tc.account or tc.wallet.account
    var acc = tc.account || (tc.wallet && tc.wallet.account) || null;
    if (acc && acc.address) return acc;
    // Also check wallet object directly
    if (tc.wallet && tc.wallet.account && tc.wallet.account.address) return tc.wallet.account;
    return null;
  }

  function ensure() {
    if (restorePromise) return restorePromise;
    restorePromise = loadSdk().then(function (TC) {
      if (!tc) {
        var opts = { manifestUrl: getManifestUrl() };
        var twa = getTwaReturnUrl();
        if (twa) opts.twaReturnUrl = twa;
        // Optional: set returnStrategy to back for better UX
        // opts.actionsConfiguration = { twaReturnUrl: twa }
        try {
          tc = new TC(opts);
          console.log('[Wallet] TonConnectUI created with manifest:', opts.manifestUrl, 'twaReturnUrl:', twa || '(default)');
          // Eager restore — some wallets need explicit restore
          if (tc.restoreConnection) {
            try { tc.restoreConnection(); } catch (e) { console.warn('[Wallet] restoreConnection failed', e); }
          }
        } catch (e) {
          console.error('[Wallet] TonConnectUI creation failed', e);
          throw e;
        }
      }
      return tc;
    }).catch(function (e) {
      console.error('[Wallet] ensure failed', e);
      throw e;
    });
    return restorePromise;
  }

  // Eager init on load — ensures session restore happens before router
  // Defer slightly to allow app-config.js to set globals
  setTimeout(function () {
    if (getTonConnectClass()) {
      ensure().catch(function () {});
    } else {
      // Wait for SDK to load, then ensure
      loadSdk(8000).then(function () { return ensure(); }).catch(function () {});
    }
  }, 300);

  window.Wallet = {
    available: function () { return !!getTonConnectClass(); },

    whenReady: ensure,

    connected: function () {
      var acc = getAccount();
      return !!acc;
    },

    // Raw address as returned by SDK (usually 0:hex or EQ... depending on wallet)
    address: function () {
      var acc = getAccount();
      return acc ? acc.address : null;
    },

    // Friendly base64url (UQ/EQ) — uses UI.toFriendly if available, else raw
    addressFriendly: function () {
      var addr = this.address();
      if (!addr) return null;
      try {
        if (window.UI && window.UI.toFriendly) {
          var f = window.UI.toFriendly(addr);
          // UI.toFriendly may return same if already friendly; ensure it looks friendly
          return f || addr;
        }
      } catch (e) {}
      return addr;
    },

    // Chain: -239 = mainnet, -3 = testnet
    chain: function () {
      var acc = getAccount();
      return acc && acc.chain != null ? acc.chain : null;
    },

    walletName: function () { return (tc && tc.wallet) ? (tc.wallet.name || tc.wallet.appName || '') : ''; },

    walletInfo: function () { return tc ? tc.wallet : null; },

    connect: function () {
      return ensure().then(function (w) { return w.connectWallet(); });
    },

    disconnect: function () {
      if (!tc) return Promise.resolve();
      try {
        // Clear any cached balance
        _balanceCache = null;
      } catch (e) {}
      return tc.disconnect ? tc.disconnect() : Promise.resolve();
    },

    onStatus: function (cb) {
      ensure().then(function (w) {
        // Fire immediately with current state
        try {
          var cur = getAccount();
          cb(cur);
        } catch (e) { console.warn('[Wallet] onStatus immediate cb failed', e); }
        var unsub = w.onStatusChange(function (wallet) {
          var acc = wallet && wallet.account ? wallet.account : (wallet && wallet.account ? wallet.account : null);
          // wallet param is the new wallet object; also check tc.account
          var effective = acc || getAccount();
          try { cb(effective); } catch (e) { console.warn('[Wallet] onStatus cb failed', e); }
        });
        // Allow caller to unsubscribe if needed — not used currently but return for completeness
        return unsub;
      }).catch(function (e) {
        console.warn('[Wallet] onStatus ensure failed', e);
        try { cb(null); } catch (e2) {}
      });
    },

    // Fetch TON balance via backend proxy /api/balance/:address
    // Returns Promise<{balance: string (nanotons), balanceTon: string, state: string}>
    // NOTE: send raw address as-is — backend handles both raw (0:hex) and friendly (EQ/UQ).
    // Do NOT use UI.toFriendly here — the hand-rolled UI.toFriendly lacks CRC and produces invalid addresses.
    getBalance: function () {
      var addr = this.address();
      if (!addr) return Promise.reject(new Error('wallet_not_connected'));
      var qAddr = String(addr).trim();
      // Prefer window.Api if available (handles auth, baseUrl)
      if (window.Api && typeof window.Api.balance === 'function') {
        return window.Api.balance(qAddr);
      }
      // Fallback direct fetch
      var url = '/api/balance/' + encodeURIComponent(qAddr);
      return fetch(url, { headers: { 'Accept': 'application/json' } }).then(function (r) {
        if (!r.ok) return r.json().then(function (j) { throw new Error(j.error || 'balance_fetch_failed'); });
        return r.json();
      });
    },

    // Convenience: fetch and format as "X.XXXX TON"
    getBalanceFormatted: function () {
      return this.getBalance().then(function (r) {
        var ton = r.balanceTon || (Number(r.balance) / 1e9).toString();
        // Keep 4 decimals for display
        var n = Number(ton);
        if (!isFinite(n)) return ton + ' TON';
        return n.toFixed(4).replace(/\.?0+$/, '') + ' TON';
      });
    },

    /** Send `amountTon` native TON to `to`. Resolves {boc} after in-wallet approval. */
    pay: function (to, amountTon) {
      return ensure().then(function (w) {
        var amt = Number(amountTon);
        if (!isFinite(amt) || amt <= 0) return Promise.reject(new Error('invalid_amount'));
        // TON Connect expects amount as string in nanotons, no decimals
        var nano = String(Math.round(amt * 1e9));
        return w.sendTransaction({
          validUntil: Math.floor(Date.now() / 1000) + 600,
          messages: [
            { address: to, amount: nano }
          ]
        });
      });
    }
  };

  // Internal balance cache for UI polling
  var _balanceCache = null;
  window.Wallet._getBalanceCache = function () { return _balanceCache; };
  window.Wallet._setBalanceCache = function (v) { _balanceCache = v; };
})();
