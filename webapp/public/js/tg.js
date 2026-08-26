/* tg.js — Telegram WebApp bridge with graceful fallbacks (works in plain browser too) */
(function () {
  'use strict';

  var wa = (window.Telegram && window.Telegram.WebApp) || null;

  function isAtLeast(ver) {
    if (!wa || typeof wa.isVersionAtLeast !== 'function') return false;
    try { return !!wa.isVersionAtLeast(ver); } catch (e) { return false; }
  }

  function safe(fn) {
    try { fn(); } catch (e) { /* no-op outside Telegram */ }
  }

  var TG = {
    available: !!wa,

    init: function () {
      if (!wa) return;
      safe(function () { wa.ready(); });
      safe(function () { wa.expand(); });
      safe(function () {
        if (typeof wa.setHeaderColor === 'function') wa.setHeaderColor('bg_color');
        if (typeof wa.setBackgroundColor === 'function') wa.setBackgroundColor('bg_color');
      });

      // Keep --app-height in sync with the Telegram viewport (iOS keyboard etc.)
      var applyVh = function () {
        var h = (wa.viewportStableHeight && wa.viewportStableHeight > 0)
          ? wa.viewportStableHeight
          : window.innerHeight;
        document.documentElement.style.setProperty('--app-height', h + 'px');
      };
      applyVh();
      safe(function () { wa.onEvent('viewportChanged', applyVh); });
      window.addEventListener('resize', applyVh);

      // Mirror color scheme onto <body data-scheme>
      var applyScheme = function () {
        document.body.setAttribute('data-scheme', TG.colorScheme());
      };
      applyScheme();
      safe(function () { wa.onEvent('themeChanged', applyScheme); });
    },

    version: function () { return wa ? String(wa.version || '0') : '0'; },

    colorScheme: function () {
      return (wa && wa.colorScheme === 'light') ? 'light' : 'dark';
    },

    /** Current Telegram user or a preview fallback */
    user: function () {
      var u = wa && wa.initDataUnsafe && wa.initDataUnsafe.user;
      if (u) return u;
      return { id: 777000001, first_name: 'Preview', username: 'preview_user' };
    },

    realUser: function () {
      return (wa && wa.initDataUnsafe && wa.initDataUnsafe.user) ? wa.initDataUnsafe.user : null;
    },

    initData: function () { return (wa && wa.initData) || ''; },

    startParam: function () {
      try { return (wa && wa.initDataUnsafe && wa.initDataUnsafe.start_param) || ''; }
      catch (e) { return ''; }
    },

    /* ---------- Haptics ---------- */
    haptic: {
      tap: function () { safe(function () { if (isAtLeast(6.1)) wa.HapticFeedback.selectionChanged(); }); },
      light: function () { safe(function () { if (isAtLeast(6.1)) wa.HapticFeedback.impactOccurred('light'); }); },
      medium: function () { safe(function () { if (isAtLeast(6.1)) wa.HapticFeedback.impactOccurred('medium'); }); },
      success: function () { safe(function () { if (isAtLeast(6.1)) wa.HapticFeedback.notificationOccurred('success'); }); },
      error: function () { safe(function () { if (isAtLeast(6.1)) wa.HapticFeedback.notificationOccurred('error'); }); },
      warning: function () { safe(function () { if (isAtLeast(6.1)) wa.HapticFeedback.notificationOccurred('warning'); }); }
    },

    /* ---------- Back button ---------- */
    showBack: function (cb) {
      safe(function () {
        if (isAtLeast(6.1) && wa.BackButton) {
          TG._backCb = cb;
          wa.BackButton.onClick(cb);
          wa.BackButton.show();
        }
      });
    },
    hideBack: function () {
      safe(function () {
        if (isAtLeast(6.1) && wa.BackButton) {
          if (TG._backCb) wa.BackButton.offClick(TG._backCb);
          TG._backCb = null;
          wa.BackButton.hide();
        }
      });
    },

    /* ---------- Main button ---------- */
    main: {
      show: function (text, onClick, opts) {
        opts = opts || {};
        safe(function () {
          if (!wa || !wa.MainButton || !isAtLeast(6.0)) return;
          var mb = wa.MainButton;
          mb.setParams({
            text: text,
            color: opts.color || (TG.colorScheme() === 'light' ? '#3390ec' : '#3390ec'),
            is_active: true,
            is_visible: true
          });
          TG.main._off();
          mb.onClick(TG.main._cb = onClick);
          if (opts.progress) mb.showProgress(false);
          mb.show();
        });
      },
      hideProgress: function () { safe(function () { if (wa && wa.MainButton) wa.MainButton.hideProgress(); }); },
      hide: function () {
        safe(function () {
          if (wa && wa.MainButton) { TG.main._off(); wa.MainButton.hide(); }
        });
      },
      _cb: null,
      _off: function () {
        safe(function () {
          if (wa && wa.MainButton && TG.main._cb) wa.MainButton.offClick(TG.main._cb);
          TG.main._cb = null;
        });
      }
    },

    /* ---------- Dialogs ---------- */
    alert: function (message, cb) {
      safe(function () {
        if (isAtLeast(6.2) && wa.showAlert) { wa.showAlert(String(message)); if (cb) setTimeout(cb, 350); return; }
        window.alert(String(message)); if (cb) cb();
      });
    },
    confirm: function (message, onYes) {
      safe(function () {
        if (isAtLeast(6.2) && wa.showConfirm) { wa.showConfirm(String(message), function (ok) { if (ok && onYes) onYes(); }); return; }
        if (window.confirm(String(message)) && onYes) onYes();
      });
    },

    /* ---------- Closing behavior / misc ---------- */
    preventClose: function (on) {
      safe(function () { if (isAtLeast(7.0) && wa.enableClosingConfirmation) { on ? wa.enableClosingConfirmation() : wa.disableClosingConfirmation(); } });
    },
    openLink: function (url) { safe(function () { if (wa && wa.openLink) wa.openLink(url); else window.open(url, '_blank'); }); },
    openTelegramLink: function (url) {
      safe(function () {
        if (wa && wa.openTelegramLink) wa.openTelegramLink(url);
        else window.open(url, '_blank');
      });
    },
    share: function (url, text) {
      this.openTelegramLink('https://t.me/share/url?url=' + encodeURIComponent(url) + '&text=' + encodeURIComponent(text || ''));
    },
    close: function () { safe(function () { if (wa) wa.close(); }); }
  };

  window.TG = TG;
})();
