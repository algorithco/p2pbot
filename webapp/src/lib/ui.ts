export function h(tag: string, attrs: Record<string, any> | null, children?: any): HTMLElement {
  const el = document.createElement(tag);
  if (attrs) {
    Object.keys(attrs).forEach(k => {
      const v = attrs[k];
      if (v === null || v === undefined || v === false) return;
      if (k === 'class') el.className = v;
      else if (k === 'text') el.textContent = v;
      else if (k === 'html') el.innerHTML = v;
      else if (k.slice(0, 2) === 'on' && typeof v === 'function') el.addEventListener(k.slice(2).toLowerCase(), v);
      else if (k === 'dataset') Object.assign(el.dataset, v);
      else el.setAttribute(k, v === true ? '' : String(v));
    });
  }
  if (children !== undefined && children !== null) {
    const arr = Array.isArray(children) ? children : [children];
    arr.forEach(c => {
      if (c === null || c === undefined || c === false) return;
      el.appendChild(typeof c === 'string' ? document.createTextNode(c) : c);
    });
  }
  return el;
}

export function fmtAmount(v: any): string {
  const n = Number(v);
  if (!isFinite(n)) return String(v == null ? '0' : v);
  const abs = Math.abs(n);
  const digits = abs >= 1000 ? 0 : abs >= 1 ? 4 : 6;
  let s = n.toFixed(digits);
  s = s.replace(/(\.\d*?[1-9])0+$/, '$1').replace(/\.0+$/, '');
  return s;
}
export function fmtDate(iso: string): string {
  const d = new Date(iso);
  if (isNaN(d.getTime())) return '—';
  return d.toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' });
}
export function fmtDateTime(iso: string): string {
  const d = new Date(iso);
  if (isNaN(d.getTime())) return '—';
  return d.toLocaleString(undefined, { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });
}
export function fmtTime(iso: string): string {
  const d = new Date(iso);
  if (isNaN(d.getTime())) return '';
  return d.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });
}
export function timeAgo(iso: string): string {
  const d = new Date(iso);
  if (isNaN(d.getTime())) return '';
  const s = Math.floor((Date.now() - d.getTime()) / 1000);
  if (s < 45) return 'just now';
  if (s < 3600) return Math.max(1, Math.floor(s / 60)) + 'm ago';
  if (s < 86400) return Math.floor(s / 3600) + 'h ago';
  if (s < 86400 * 30) return Math.floor(s / 86400) + 'd ago';
  return fmtDate(iso);
}
export function countdown(iso: string): { expired: boolean; text: string } | null {
  const t = new Date(iso).getTime();
  if (!iso || isNaN(t)) return null;
  const diff = t - Date.now();
  if (diff <= 0) return { expired: true, text: 'Expired' };
  const mins = Math.floor(diff / 60000);
  if (mins < 60) return { expired: false, text: mins + 'm left' };
  const hours = Math.floor(mins / 60);
  if (hours < 48) return { expired: false, text: hours + 'h left' };
  return { expired: false, text: Math.floor(hours / 24) + 'd left' };
}
export function truncate(s: string, head: number, tail: number): string {
  s = String(s || '');
  if (s.length <= head + tail + 3) return s;
  return s.slice(0, head) + '…' + s.slice(-tail);
}
export function toFriendly(raw: string): string {
  try {
    const parts = String(raw).split(':');
    if (parts.length !== 2 || !/^[0-9a-fA-F]{64}$/.test(parts[1])) return String(raw || '');
    const wc = parseInt(parts[0], 10);
    const bytes = [0x51, wc < 0 ? 255 : wc];
    for (let i = 0; i < 64; i += 2) bytes.push(parseInt(parts[1].substr(i, 2), 16));
    let bin = '';
    for (let j = 0; j < bytes.length; j++) bin += String.fromCharCode(bytes[j]);
    return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  } catch { return String(raw || ''); }
}
export function shortAddr(a: string): string {
  a = String(a || '');
  return a.length > 12 ? a.slice(0, 6) + '…' + a.slice(-4) : a;
}

const STATUSES: Record<string, { label: string; cls: string; step: number }> = {
  AWAITING_DEPOSIT: { label: 'Awaiting deposit', cls: 'st-awaiting', step: 0 },
  DEPOSIT_CONFIRMED: { label: 'Funded — send item', cls: 'st-funded', step: 1 },
  ITEM_SENT: { label: 'Item sent — await buyer', cls: 'st-sent', step: 2 },
  BUYER_CONFIRMED: { label: 'Buyer confirmed', cls: 'st-confirmed', step: 2 },
  RELEASED: { label: 'Released', cls: 'st-released', step: 3 },
  REFUNDED: { label: 'Refunded', cls: 'st-refunded', step: 3 },
};
export function statusMeta(status: string) {
  const m = STATUSES[String(status || '').toUpperCase()];
  return m || { label: String(status || 'Unknown'), cls: 'st-unknown', step: -1 };
}
export function isFinalStatus(status: string) {
  const u = String(status || '').toUpperCase();
  return u === 'RELEASED' || u === 'REFUNDED';
}
export function assetMeta(asset: string) {
  const a = String(asset || '').toUpperCase();
  if (a === 'TON') return { name: 'Toncoin', symbol: 'TON', glyph: '◈', cls: 'asset-ton' };
  if (a === 'USDT') return { name: 'Tether', symbol: 'USDT', glyph: '₮', cls: 'asset-usdt' };
  return { name: a || 'Asset', symbol: a || '?', glyph: '◆', cls: 'asset-any' };
}
export const feeBpsEstimate = 100;
export function avatarClass(seed: any): string { return 'av-' + (Math.abs(Number(seed) || 0) % 4); }
export function counterpartyLabel(deal: any): string {
  try {
    const uid = Number((window as any).TG?.user()?.id);
    if (Number(deal.buyer_telegram_id) === uid) return 'You are the Buyer';
    if (Number(deal.seller_telegram_id) === uid) return 'You are the Seller';
  } catch {}
  return '';
}

export function toast(message: string, type?: 'ok' | 'err') {
  const root = document.getElementById('toast-root')!;
  while (root.children.length > 2) root.removeChild(root.firstChild);
  const cls = type === 'ok' ? 'ok' : type === 'err' ? 'err' : '';
  const t = h('div', { class: 'toast ' + cls, text: String(message) });
  root.appendChild(t);
  setTimeout(() => {
    t.classList.add('out');
    setTimeout(() => t.remove(), 260);
  }, type === 'err' ? 3400 : 2200);
}
export function copy(text: string, label = 'Copied to clipboard') {
  function fallbackCopy(t: string) {
    const ta = document.createElement('textarea');
    ta.value = t;
    ta.style.cssText = 'position:fixed;opacity:0;top:0;left:0;';
    document.body.appendChild(ta);
    ta.select();
    try { document.execCommand('copy'); } catch {}
    ta.remove();
  }
  function done() { toast(label, 'ok'); (window as any).TG?.haptic?.success?.(); }
  if (navigator.clipboard && navigator.clipboard.writeText) {
    navigator.clipboard.writeText(text).then(done, () => { fallbackCopy(text); done(); });
  } else { fallbackCopy(text); done(); }
}
export function skeletonDeals(n = 4): DocumentFragment {
  const frag = document.createDocumentFragment();
  for (let i = 0; i < (n || 4); i++) frag.appendChild(h('div', { class: 'sk sk-deal' }));
  return frag;
}
export function sheetClose() {
  const root = document.getElementById('sheet-root')!;
  root.classList.remove('open');
  root.innerHTML = '';
  (window as any).TG?.preventClose?.(false);
}
export function sheetOpen(contentEl: HTMLElement, opts: any = {}) {
  const root = document.getElementById('sheet-root')!;
  root.innerHTML = '';
  const sheet = h('div', { class: 'sheet', role: 'dialog' } as any, [h('div', { class: 'sheet-grabber' }), contentEl]);
  const backdrop = h('div', { class: 'sheet-backdrop', onclick: () => { if (!opts.locked) sheetClose(); } });
  root.appendChild(backdrop);
  root.appendChild(sheet);
  root.classList.add('open');
  if ((window as any).TG?.available) {
    (window as any).TG.showBack(() => { if (!opts.locked) sheetClose(); });
    (window as any).TG.preventClose(!!opts.locked);
  }
  return { close: sheetClose, el: sheet };
}

export const UI = {
  h, fmtAmount, fmtDate, fmtDateTime, fmtTime, timeAgo, countdown, truncate, toFriendly, shortAddr,
  statusMeta, isFinalStatus, assetMeta, feeBpsEstimate, avatarClass, counterpartyLabel,
  toast, copy, skeletonDeals, sheetOpen, sheetClose,
};
export default UI;
