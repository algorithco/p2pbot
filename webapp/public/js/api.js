/* api.js — HTTP client for the escrow backend (same origin by default) */
(function () {
  'use strict';

  var BASE = '';
  try {
    BASE = window.localStorage.getItem('tonescrow:apiBase') || '';
    if (BASE && BASE.charAt(BASE.length - 1) === '/') BASE = BASE.slice(0, -1);
  } catch (e) { /* storage unavailable */ }

  function ApiError(status, message, payload) {
    this.name = 'ApiError';
    this.status = status || 0;
    this.message = message || 'Request failed';
    this.payload = payload || null;
  }
  ApiError.prototype = Object.create(Error.prototype);

  function authHeaders() {
    var h = {};
    try {
      if (window.TG && TG.initData()) h['x-init-data'] = TG.initData();
      // Use real Telegram user when available, fallback to preview id only for public reads
      var uid = 0;
      try { uid = (window.TG && TG.realUser && TG.realUser() ? TG.realUser().id : (TG.user().id || 0)); } catch (e) { uid = 0; }
      h['x-telegram-user-id'] = String(uid || (window.TG ? TG.user().id : 0) || 0);
    } catch (e) { /* ignore */ }
    return h;
  }

  function request(method, path, body, opts) {
    opts = opts || {};
    var ctrl = typeof AbortController !== 'undefined' ? new AbortController() : null;
    var timer = setTimeout(function () { if (ctrl) ctrl.abort(); }, opts.timeoutMs || 15000);

    return fetch(BASE + path, {
      method: method,
      headers: Object.assign(
        { 'Accept': 'application/json' },
        body ? { 'Content-Type': 'application/json' } : {},
        authHeaders()
      ),
      body: body ? JSON.stringify(body) : undefined,
      signal: ctrl ? ctrl.signal : undefined
    })
      .then(function (res) {
        clearTimeout(timer);
        return res.text().then(function (txt) {
          var data = null;
          if (txt) {
            try { data = JSON.parse(txt); } catch (e) { data = txt; }
          }
          if (!res.ok) {
            var msg = (data && data.error) ? String(data.error) : ('HTTP ' + res.status);
            throw new ApiError(res.status, msg, data);
          }
          return data;
        });
      })
      .catch(function (err) {
        clearTimeout(timer);
        if (err instanceof ApiError) throw err;
        throw new ApiError(0, 'Network unreachable', null);
      });
  }

  window.Api = {
    ApiError: ApiError,

    /** GET /api/info -> { adminTelegramIds: [] } */
    info: function () {
      return request('GET', '/api/info').then(function (d) {
        return { adminTelegramIds: (d && d.adminTelegramIds) || [] };
      });
    },

    /** GET /api/deals -> deal[] */
    deals: function () {
      return request('GET', '/api/deals').then(function (d) {
        return Array.isArray(d) ? d : [];
      });
    },

    /** GET /api/deals/:id -> deal | null */
    deal: function (id) {
      return request('GET', '/api/deals/' + encodeURIComponent(id));
    },

    /**
     * POST /api/deals
     * payload: { buyerId?, sellerId!, asset!, amount!, terms?, deadline? }
     * resolves -> { deal, link }
     */
    createDeal: function (payload) {
      return request('POST', '/api/deals', payload).then(function (d) {
        d = d || {};
        return {
          deal: d.deal || d,
          link: d.link || d.webappLink || '',
          webappLink: d.webappLink || d.link || '',
          encryption: d.encryption || ''
        };
      });
    },

    /** POST /api/deals/:id/join/:token */
    joinDeal: function (id, token) {
      return request('POST', '/api/deals/' + encodeURIComponent(id) + '/join/' + encodeURIComponent(token), {});
    },

    /** GET /api/deals/:id/key -> {key} (per-deal E2E key, party-only) */
    dealKey: function (dealId) {
      return request('GET', '/api/deals/' + encodeURIComponent(dealId) + '/key').then(function (d) {
        return d && d.key ? d.key : null;
      });
    },

    /** GET /api/deals/:id/chat -> message[] (ciphertext when encrypted) */
    chat: function (dealId) {
      return request('GET', '/api/deals/' + encodeURIComponent(dealId) + '/chat').then(function (d) {
        return Array.isArray(d) ? d : [];
      });
    },

    /** POST /api/deals/:id/chat — E2E: sends ciphertext (preferred) */
    sendChatEncrypted: function (dealId, senderTelegramId, ciphertext) {
      return request('POST', '/api/deals/' + encodeURIComponent(dealId) + '/chat', {
        senderTelegramId: senderTelegramId,
        ciphertext: ciphertext
      });
    },

    /** POST /api/deals/:id/chat — legacy plaintext (server will E2E-encrypt before storing) */
    sendChat: function (dealId, senderTelegramId, content) {
      return request('POST', '/api/deals/' + encodeURIComponent(dealId) + '/chat', {
        senderTelegramId: senderTelegramId,
        content: content
      });
    },

    /** GET /api/status/:address -> { status: number } (on-chain escrow state) */
    chainStatus: function (address) {
      return request('GET', '/api/status/' + encodeURIComponent(address));
    },

    /** GET /api/balance/:address -> { balance (nanotons), balanceTon, state, address } */
    balance: function (address) {
      return request('GET', '/api/balance/' + encodeURIComponent(address));
    },

    /** GET /api/ton/payload?comment=xxx -> { payload: base64, comment } — memo for TON */
    tonPayload: function (comment) {
      return request('GET', '/api/ton/payload?comment=' + encodeURIComponent(comment)).then(function (d) {
        return d && d.payload ? d.payload : null;
      });
    },

    /** GET /api/deals/:id/payload -> { depositPayload, releasePayload, jettonPayload, ... } */
    dealPayload: function (dealId) {
      return request('GET', '/api/deals/' + encodeURIComponent(dealId) + '/payload');
    },

    /** Admin: POST /api/notify */
    notify: function (chatId, message) {
      return request('POST', '/api/notify', { chatId: Number(chatId), message: message });
    },

    /** Admin: GET /api/notifications -> notification[] */
    notifications: function () {
      return request('GET', '/api/notifications').then(function (d) {
        return Array.isArray(d) ? d : [];
      });
    }
  };
})();
