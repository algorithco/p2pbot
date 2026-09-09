type TGUser = { id: number; first_name?: string; username?: string; photo_url?: string; last_name?: string };

declare global {
  interface Window {
    Telegram?: { WebApp?: any };
  }
}

const wa: any = (typeof window !== 'undefined' && (window as any).Telegram?.WebApp) || null;

function isAtLeast(ver: string): boolean {
  if (!wa || typeof wa.isVersionAtLeast !== 'function') return false;
  try { return !!wa.isVersionAtLeast(ver); } catch { return false; }
}
function safe(fn: () => void) { try { fn(); } catch {} }

export const TG = {
  available: !!wa,
  init() {
    if (!wa) return;
    safe(() => wa.ready());
    safe(() => wa.expand());
    safe(() => {
      if (typeof wa.setHeaderColor === 'function') wa.setHeaderColor('bg_color');
      if (typeof wa.setBackgroundColor === 'function') wa.setBackgroundColor('bg_color');
    });
    const applyVh = () => {
      const h = wa.viewportStableHeight && wa.viewportStableHeight > 0 ? wa.viewportStableHeight : window.innerHeight;
      document.documentElement.style.setProperty('--app-height', h + 'px');
    };
    applyVh();
    safe(() => wa.onEvent('viewportChanged', applyVh));
    window.addEventListener('resize', applyVh);
    const applyScheme = () => {
      document.body.setAttribute('data-scheme', TG.colorScheme());
      // Respect saved profile preference; fall back to Telegram scheme (dark default).
      try {
        const saved = window.localStorage.getItem('tonescrow:theme');
        if (saved === 'light' || saved === 'dark') document.body.setAttribute('data-theme-mode', saved);
        else document.body.setAttribute('data-theme-mode', TG.colorScheme() === 'light' ? 'light' : 'dark');
      } catch {
        document.body.setAttribute('data-theme-mode', TG.colorScheme() === 'light' ? 'light' : 'dark');
      }
    };
    applyScheme();
    safe(() => wa.onEvent('themeChanged', applyScheme));
  },
  version(): string { return wa ? String(wa.version || '0') : '0'; },
  colorScheme(): string { return wa && wa.colorScheme === 'light' ? 'light' : 'dark'; },
  user(): TGUser {
    const u = wa?.initDataUnsafe?.user;
    if (u) return u;
    return { id: 777000001, first_name: 'Preview', username: 'preview_user' };
  },
  realUser(): TGUser | null {
    return wa?.initDataUnsafe?.user ? wa.initDataUnsafe.user : null;
  },
  initData(): string { return (wa && wa.initData) || ''; },
  startParam(): string {
    try { return (wa?.initDataUnsafe?.start_param) || ''; } catch { return ''; }
  },
  haptic: {
    tap() { safe(() => { if (isAtLeast('6.1')) wa.HapticFeedback.selectionChanged(); }); },
    light() { safe(() => { if (isAtLeast('6.1')) wa.HapticFeedback.impactOccurred('light'); }); },
    medium() { safe(() => { if (isAtLeast('6.1')) wa.HapticFeedback.impactOccurred('medium'); }); },
    success() { safe(() => { if (isAtLeast('6.1')) wa.HapticFeedback.notificationOccurred('success'); }); },
    error() { safe(() => { if (isAtLeast('6.1')) wa.HapticFeedback.notificationOccurred('error'); }); },
    warning() { safe(() => { if (isAtLeast('6.1')) wa.HapticFeedback.notificationOccurred('warning'); }); },
  },
  showBack(cb: () => void) {
    safe(() => {
      if (isAtLeast('6.1') && wa.BackButton) {
        (TG as any)._backCb = cb;
        wa.BackButton.onClick(cb);
        wa.BackButton.show();
      }
    });
  },
  hideBack() {
    safe(() => {
      if (isAtLeast('6.1') && wa.BackButton) {
        if ((TG as any)._backCb) wa.BackButton.offClick((TG as any)._backCb);
        (TG as any)._backCb = null;
        wa.BackButton.hide();
      }
    });
  },
  main: {
    show(text: string, onClick: () => void, opts: any = {}) {
      safe(() => {
        if (!wa || !wa.MainButton || !isAtLeast('6.0')) return;
        const mb = wa.MainButton;
        mb.setParams({ text, color: opts.color || '#3b82f6', is_active: true, is_visible: true });
        (TG.main as any)._off();
        mb.onClick((TG.main as any)._cb = onClick);
        if (opts.progress) mb.showProgress(false);
        mb.show();
      });
    },
    hideProgress() { safe(() => { if (wa?.MainButton) wa.MainButton.hideProgress(); }); },
    hide() { safe(() => { if (wa?.MainButton) { (TG.main as any)._off(); wa.MainButton.hide(); } }); },
    _cb: null as any,
    _off() { safe(() => { if (wa?.MainButton && (TG.main as any)._cb) wa.MainButton.offClick((TG.main as any)._cb); (TG.main as any)._cb = null; }); },
  },
  alert(message: string, cb?: () => void) {
    safe(() => {
      if (isAtLeast('6.2') && wa.showAlert) { wa.showAlert(String(message)); if (cb) setTimeout(cb, 350); return; }
      window.alert(String(message)); if (cb) cb();
    });
  },
  confirm(message: string, onYes?: () => void) {
    safe(() => {
      if (isAtLeast('6.2') && wa.showConfirm) { wa.showConfirm(String(message), (ok: boolean) => { if (ok && onYes) onYes(); }); return; }
      if (window.confirm(String(message)) && onYes) onYes();
    });
  },
  preventClose(on: boolean) { safe(() => { if (isAtLeast('7.0') && wa.enableClosingConfirmation) { on ? wa.enableClosingConfirmation() : wa.disableClosingConfirmation(); } }); },
  openLink(url: string) { safe(() => { if (wa?.openLink) wa.openLink(url); else window.open(url, '_blank'); }); },
  openTelegramLink(url: string) { safe(() => { if (wa?.openTelegramLink) wa.openTelegramLink(url); else window.open(url, '_blank'); }); },
  share(url: string, text?: string) { (TG as any).openTelegramLink('https://t.me/share/url?url=' + encodeURIComponent(url) + '&text=' + encodeURIComponent(text || '')); },
  close() { safe(() => { if (wa) wa.close(); }); },
  _backCb: null as any,
};

export default TG;
