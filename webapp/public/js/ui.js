/* ui.js — DOM helpers, formatting, toasts, sheets */
(function () {
  'use strict';

  var UI = {};

  /** Hyperscript helper: h('div', {class:'x', onclick:fn}, [children]) */
  UI.h = function (tag, attrs, children) {
    var el = document.createElement(tag);
    if (attrs) {
      Object.keys(attrs).forEach(function (k) {
        var v = attrs[k];
        if (v === null || v === undefined || v === false) return;
        if (k === 'class') el.className = v;
        else if (k === 'text') el.textContent = v;
        else if (k === 'html') el.innerHTML = v;
        else if (k.slice(0, 2) === 'on' && typeof v === 'function') el.addEventListener(k.slice(2).toLowerCase(), v);
        else if (k === 'dataset') Object.assign(el.dataset, v);
        else el.setAttribute(k, v === true ? '' : String(v));
      });
    }
    if (children) {
      if (!Array.isArray(children)) children = [children];
      children.forEach(function (c) {
        if (c === null || c === undefined || c === false) return;
        el.appendChild(typeof c === 'string' ? document.createTextNode(c) : c);
      });
    }
    return el;
  };

  /* ---------- Formatting ---------- */

  UI.fmtAmount = function (v) {
    var n = Number(v);
    if (!isFinite(n)) return String(v == null ? '0' : v);
    var abs = Math.abs(n);
    var digits = abs >= 1000 ? 0 : abs >= 1 ? 4 : 6;
    var s = n.toFixed(digits);
    s = s.replace(/(\.\d*?[1-9])0+$/, '$1').replace(/\.0+$/, '');
    return s;
  };

  UI.fmtDate = function (iso) {
    var d = new Date(iso);
    if (isNaN(d.getTime())) return '—';
    return d.toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' });
  };

  UI.fmtDateTime = function (iso) {
    var d = new Date(iso);
    if (isNaN(d.getTime())) return '—';
    return d.toLocaleString(undefined, { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });
  };

  UI.timeAgo = function (iso) {
    var d = new Date(iso);
    if (isNaN(d.getTime())) return '';
    var s = Math.floor((Date.now() - d.getTime()) / 1000);
    if (s < 45) return 'just now';
    if (s < 3600) return Math.max(1, Math.floor(s / 60)) + 'm ago';
    if (s < 86400) return Math.floor(s / 3600) + 'h ago';
    if (s < 86400 * 30) return Math.floor(s / 86400) + 'd ago';
    return UI.fmtDate(iso);
  };

  UI.countdown = function (iso) {
    var t = new Date(iso).getTime();
    if (!iso || isNaN(t)) return null;
    var diff = t - Date.now();
    if (diff <= 0) return { expired: true, text: 'Expired' };
    var mins = Math.floor(diff / 60000);
    if (mins < 60) return { expired: false, text: mins + 'm left' };
    var hours = Math.floor(mins / 60);
    if (hours < 48) return { expired: false, text: hours + 'h left' };
    return { expired: false, text: Math.floor(hours / 24) + 'd left' };
  };

  UI.truncate = function (s, head, tail) {
    s = String(s || '');
    if (s.length <= head + tail + 3) return s;
    return s.slice(0, head) + '…' + s.slice(-tail);
  };

  /* ---------- Domain meta ---------- */

  var STATUSES = {
    AWAITING_DEPOSIT:  { label: 'Awaiting deposit', cls: 'st-awaiting',  step: 0 },
    DEPOSIT_CONFIRMED: { label: 'Funded',           cls: 'st-funded',    step: 1 },
    BUYER_CONFIRMED:   { label: 'Buyer confirmed',  cls: 'st-confirmed', step: 2 },
    RELEASED:          { label: 'Released',         cls: 'st-released',  step: 3 },
    REFUNDED:          { label: 'Refunded',         cls: 'st-refunded',  step: 3 }
  };

  UI.statusMeta = function (status) {
    var m = STATUSES[String(status || '').toUpperCase()];
    return m || { label: String(status || 'Unknown'), cls: 'st-unknown', step: -1 };
  };

  UI.isFinalStatus = function (status) {
    var u = String(status || '').toUpperCase();
    return u === 'RELEASED' || u === 'REFUNDED';
  };

  UI.assetMeta = function (asset) {
    var a = String(asset || '').toUpperCase();
    if (a === 'TON')  return { name: 'Toncoin', symbol: 'TON',  glyph: '\u25C8', cls: 'asset-ton' };
    if (a === 'USDT') return { name: 'Tether',  symbol: 'USDT', glyph: '\u20AE', cls: 'asset-usdt' };
    return { name: a || 'Asset', symbol: a || '?', glyph: '\u25C6', cls: 'asset-any' };
  };

  UI.feeBpsEstimate = 100; // display-only estimate; backend default FEE_BPS=100

  UI.avatarClass = function (seed) {
    return 'av-' + (Math.abs(Number(seed) || 0) % 4);
  };

  UI.counterpartyLabel = function (deal) {
    try {
      var uid = Number(window.TG && TG.user().id);
      if (Number(deal.buyer_telegram_id) === uid) return 'You are the Buyer';
      if (Number(deal.seller_telegram_id) === uid) return 'You are the Seller';
    } catch (e) { /* ignore */ }
    return '';
  };

  /* ---------- Toast ---------- */

  UI.toast = function (message, type) {
    var root = document.getElementById('toast-root');
    while (root.children.length > 2) root.removeChild(root.firstChild);
    var cls = type === 'ok' ? 'ok' : (type === 'err' ? 'err' : '');
    var t = UI.h('div', { class: 'toast ' + cls, text: String(message) });
    root.appendChild(t);
    setTimeout(function () {
      t.classList.add('out');
      setTimeout(function () { t.remove(); }, 260);
    }, type === 'err' ? 3400 : 2200);
  };

  /* ---------- Clipboard ---------- */

  UI.copy = function (text, label) {
    label = label || 'Copied to clipboard';
    function fallbackCopy(t) {
      var ta = document.createElement('textarea');
      ta.value = t;
      ta.style.cssText = 'position:fixed;opacity:0;top:0;left:0;';
      document.body.appendChild(ta);
      ta.select();
      try { document.execCommand('copy'); } catch (e) { /* ignore */ }
      ta.remove();
    }
    function done() { UI.toast(label, 'ok'); if (window.TG) TG.haptic.success(); }
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(text).then(done, function () { fallbackCopy(text); done(); });
    } else {
      fallbackCopy(text);
      done();
    }
  };

  /* ---------- Skeleton loaders ---------- */

  UI.skeletonDeals = function (n) {
    var frag = document.createDocumentFragment();
    for (var i = 0; i < (n || 4); i++) frag.appendChild(UI.h('div', { class: 'sk sk-deal' }));
    return frag;
  };

  /* ---------- Bottom sheet ---------- */

  UI.sheetClose = function () {
    var root = document.getElementById('sheet-root');
    root.classList.remove('open');
    root.innerHTML = '';
    if (window.TG && TG.available) TG.preventClose(false);
  };

  UI.sheetOpen = function (contentEl, opts) {
    opts = opts || {};
    var root = document.getElementById('sheet-root');
    root.innerHTML = '';

    var sheet = UI.h('div', { class: 'sheet' }, [
      UI.h('div', { class: 'sheet-grabber' }),
      contentEl
    ]);
    var backdrop = UI.h('div', {
      class: 'sheet-backdrop',
      onclick: function () { if (!opts.locked) UI.sheetClose(); }
    });

    root.appendChild(backdrop);
    root.appendChild(sheet);
    root.classList.add('open');

    if (window.TG && TG.available) {
      TG.showBack(function () { if (!opts.locked) UI.sheetClose(); });
      TG.preventClose(!!opts.locked);
    }
    return { close: UI.sheetClose, el: sheet };
  };

  window.UI = UI;
})();
