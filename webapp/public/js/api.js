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

    /** GET /api/deals -> deal[] (private: only own deals, admin sees all) */
    deals: function () {
      return request('GET', '/api/deals').then(function (d) {
        return Array.isArray(d) ? d : [];
      }).catch(function (err) {
        // Fallback to /api/deals/mine for old servers
        if (err && err.status === 404) {
          return request('GET', '/api/deals/mine').then(function (d) { return Array.isArray(d) ? d : []; });
        }
        throw err;
      });
    },

    /** GET /api/deals/:id -> deal | null (party-only, token preview allowed) */
    deal: function (id, token) {
      var path = '/api/deals/' + encodeURIComponent(id);
      if (token) path += '?token=' + encodeURIComponent(token);
      return request('GET', path);
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
          link: d.botLink || d.link || d.webappLink || '',
          botLink: d.botLink || d.link || '',
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

    /** GET /api/deals/:id/payload -> { depositPayload, releasePayload, jettonPayload, ... } (party-only, token preview) */
    dealPayload: function (dealId, token) {
      var path = '/api/deals/' + encodeURIComponent(dealId) + '/payload';
      if (token) path += '?token=' + encodeURIComponent(token);
      return request('GET', path);
    },

    /** POST /api/deals/:id/ship — seller marks item sent (DEPOSIT_CONFIRMED -> ITEM_SENT) */
    shipDeal: function (id) {
      return request('POST', '/api/deals/' + encodeURIComponent(id) + '/ship', {});
    },

    /** POST /api/deals/:id/approve — buyer confirms receipt (ITEM_SENT -> RELEASED minus fee) */
    approveDeal: function (id) {
      return request('POST', '/api/deals/' + encodeURIComponent(id) + '/approve', {});
    },

    /** POST /api/deals/:id/confirm — deprecated alias to approveDeal (buyer-only) */
    confirmDeal: function (id) {
      return request('POST', '/api/deals/' + encodeURIComponent(id) + '/approve', {}).catch(function(e){
        if(e && e.status===404) return request('POST','/api/deals/'+encodeURIComponent(id)+'/confirm',{});
        throw e;
      });
    },

    /** GET /api/users/me -> { telegram_id, username, ton_address } */
    getMyProfile: function () {
      return request('GET', '/api/users/me');
    },

    /** POST /api/users/me/ton-address {tonAddress} */
    setMyTonAddress: function (tonAddress) {
      return request('POST', '/api/users/me/ton-address', { tonAddress: tonAddress });
    },

    /** POST /api/deals/:id/payout-address {tonAddress} — per-deal override */
    setPayoutAddress: function (dealId, tonAddress) {
      return request('POST', '/api/deals/' + encodeURIComponent(dealId) + '/payout-address', { tonAddress: tonAddress });
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
    },

    // CHANNEL/GROUP escrow via @gramchioka (additive)
    channelVerify: function (dealId) { return request('POST', '/api/deals/' + encodeURIComponent(dealId) + '/channel/verify', {}); },
    channelRequestEscrow: function (dealId) { return request('POST', '/api/deals/' + encodeURIComponent(dealId) + '/channel/request-escrow', {}); },
    channelConfirmEscrow: function (dealId) { return request('POST', '/api/deals/' + encodeURIComponent(dealId) + '/channel/confirm-escrow', {}); },
    channelPayout: function (dealId, tonAddress) { return request('POST', '/api/deals/' + encodeURIComponent(dealId) + '/channel/payout', tonAddress ? { tonAddress: tonAddress } : {}); },
    channelSetNewOwner: function (dealId, newOwner) { return request('POST', '/api/deals/' + encodeURIComponent(dealId) + '/channel/set-new-owner', { newOwner: newOwner }); },
    channelTransferToBuyer: function (dealId, newOwner) { return request('POST', '/api/deals/' + encodeURIComponent(dealId) + '/channel/transfer-to-buyer', newOwner ? { newOwner: newOwner } : {}); }
  };
})();
