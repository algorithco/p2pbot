/* wallet.js — TON Connect wrapper for the Mini App (lazy-loading, graceful degradation) */
(function () {
  'use strict';

  var tc = null;

  function loadSdk(timeoutMs) {
    return new Promise(function (resolve, reject) {
      if (window.TonConnectUI) return resolve(window.TonConnectUI);
      var started = Date.now();
      (function poll() {
        if (window.TonConnectUI) return resolve(window.TonConnectUI);
        if (Date.now() - started > (timeoutMs || 10000)) return reject(new Error('wallet_sdk_unavailable'));
        setTimeout(poll, 150);
      })();
    });
  }

  function ensure() {
    return loadSdk().then(function (TC) {
      if (!tc) tc = new TC({ manifestUrl: location.origin + '/tonconnect-manifest.json' });
      return tc;
    });
  }

  window.Wallet = {
    available: function () { return !!window.TonConnectUI; },

    whenReady: ensure,

    connected: function () { return !!(tc && tc.account); },

    address: function () { return (tc && tc.account) ? tc.account.address : null; },

    walletName: function () { return (tc && tc.wallet) ? (tc.wallet.name || tc.wallet.appName || '') : ''; },

    connect: function () {
      return ensure().then(function (w) { return w.connectWallet(); });
    },

    disconnect: function () {
      if (!tc) return Promise.resolve();
      return tc.disconnect ? tc.disconnect() : Promise.resolve();
    },

    onStatus: function (cb) {
      ensure().then(function (w) {
        w.onStatusChange(function (wallet) {
          cb(wallet && wallet.account ? wallet.account : null);
        });
      }).catch(function () { /* SDK unavailable */ });
    },

    /** Send `amountTon` native TON to `to`. Resolves {boc} after in-wallet approval. */
    pay: function (to, amountTon) {
      return ensure().then(function (w) {
        return w.sendTransaction({
          validUntil: Math.floor(Date.now() / 1000) + 600,
          messages: [
            { address: to, amount: String(Math.round(Number(amountTon) * 1e9)) }
          ]
        });
      });
    }
  };
})();
