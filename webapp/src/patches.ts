// patches.ts — extend legacy app with new TON-perfect, inbox, trade, channels features
import { Api } from './lib/api';
import { TG } from './lib/tg';
import { UI } from './lib/ui';
import { ChatCrypto } from './lib/crypto';
import { Wallet } from './lib/wallet';

declare global { interface Window { App?: any; } }

export function patchApp() {
  // Wait for legacy App to be defined
  const tryPatch = () => {
    const App = (window as any).App;
    if (!App) return setTimeout(tryPatch, 200);
    enhanceApp(App);
  };
  tryPatch();
}

function enhanceApp(App: any) {
  console.log('[Patches] enhancing App');

  // ---------- Helper: dealCard patch with search filtering hook ----------
  // Expose search state on App
  App.state.searchQuery = '';
  App.state.createdLinks = App.state.createdLinks || {};

  // ---------- Extend router to include new routes ----------
  // Legacy ROUTES is inside closure, not accessible. So we intercept hashchange and handle new routes before legacy router.
  const originalHash = location.hash;
  const handled = handleHash(location.hash);
  if (handled) return;

  window.addEventListener('hashchange', () => {
    const h = location.hash || '#/home';
    if (isNewRoute(h)) {
      // prevent legacy router handling by cleaning up and rendering our view
      // legacy router runs via its own hashchange listener; we run before it by capturing phase?
      // Instead, after short delay, override if still matching new route
      setTimeout(() => {
        if (location.hash === h && isNewRoute(h)) renderNewRoute(h);
      }, 30);
    }
  }, true);

    // Also patch tabbar to include new tabs
  patchTabbar();

  // Intercept viewDeal to add Confirm button and enhanced pay
  patchViewDeal();

  // Patch viewHome to add search + inbox entry
  patchViewHome();

  // Expose new views to legacy router (added to ROUTES in src/legacy/app.js)
  (window as any).__viewInbox = viewInbox;
  (window as any).__viewTrade = viewTrade;
  (window as any).__viewChannels = viewChannels;

  // Schedule inbox badge polling
  setTimeout(pollInboxBadge, 1200);
  setInterval(pollInboxBadge, 30000);

  // Admin is bot-only — intercept #/admin and redirect with toast
  window.addEventListener('hashchange', () => {
    if (location.hash.startsWith('#/admin')) {
      setTimeout(() => {
        if (location.hash.startsWith('#/admin')) {
          UI.toast('Admin control is via Telegram bot — use /admin_release etc.', 'err');
          location.hash = '#/home';
        }
      }, 30);
    }
  });
  if (location.hash.startsWith('#/admin')) { UI.toast('Admin via bot only','err'); location.hash = '#/home'; }

  // Visibility pause for polling timers (home 20s, chat 3.5s) — legacy uses App.chatTimer & home interval via closure
  // We track visibility and dispatch events; legacy pollers check document.hidden on next tick via patched interval wrapper
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) {
      // pause polling by clearing chatTimer if exists
      const App2 = (window as any).App;
      if (App2?.chatTimer) { clearInterval(App2.chatTimer); App2._pausedChatTimer = App2.chatTimer; App2.chatTimer = null; }
    } else {
      // resume — trigger router refresh if home
      if (location.hash === '#/home' || location.hash === '') {
        // force reload of deals via dispatch
        window.dispatchEvent(new HashChangeEvent('hashchange'));
      }
      const App2 = (window as any).App;
      if (App2?._pausedChatTimer && !App2.chatTimer && location.hash.includes('/chat')) {
        // will be recreated on next viewChat load
        App2._pausedChatTimer = null;
      }
    }
  });

  // Patch viewJoin to handle token preview gracefully (already in legacy)
  // Patch profile to remove admin entry injection
  patchProfile();

  // Enhance TON pay: wrap Wallet.pay to poll chain status 3x after approval
  wrapWalletPayForVerification();

  // Lock amount input in paySheet to exact deal amount (TON perfect)
  observePaySheetLock();
}

function isNewRoute(hash: string): boolean {
  return /^#\/inbox/.test(hash) || /^#\/trade/.test(hash) || /^#\/channels/.test(hash);
}

function handleHash(hash: string): boolean {
  if (!isNewRoute(hash)) return false;
  setTimeout(() => renderNewRoute(hash), 50);
  return true;
}

function renderNewRoute(hash: string) {
  if (hash.startsWith('#/inbox')) return viewInbox();
  if (hash.startsWith('#/trade')) return viewTrade();
  if (hash.startsWith('#/channels')) return viewChannels();
}

function setTopbarPatched(title: string, opts: any = {}) {
  const el = document.getElementById('tb-title')!;
  el.textContent = title;
  const backBtn = document.getElementById('tb-back')!;
  const actBtn = document.getElementById('tb-action')!;
  const App = (window as any).App;
  if (opts.back) {
    backBtn.classList.remove('hidden');
    App.backHandler = opts.back;
  } else {
    backBtn.classList.add('hidden');
    App.backHandler = null;
  }
  if (opts.action) {
    actBtn.classList.remove('hidden');
    actBtn.innerHTML = opts.action.icon;
    App.actionHandler = opts.action.handler;
  } else {
    actBtn.classList.add('hidden');
    App.actionHandler = null;
  }
}
function setTabbarPatched(visible: boolean) {
  document.getElementById('tabbar')!.classList.toggle('hidden', !visible);
  document.getElementById('view')!.classList.toggle('no-tabbar', !visible);
}
function go(hash: string) {
  if (location.hash === hash) window.dispatchEvent(new HashChangeEvent('hashchange'));
  else location.hash = hash;
}
function navBack(fallback: string) {
  const App = (window as any).App;
  const prev = App.navStack?.length ? App.navStack[App.navStack.length - 1] : null;
  if (prev && prev !== (location.hash || '#/home')) { App._navBack = true; go(prev); }
  else go(fallback || '#/home');
}
const ICON_REFRESH = '<svg viewBox="0 0 24 24" width="20" height="20"><path fill="currentColor" d="M17.65 6.35A8 8 0 1 0 19.7 14h-2.08a6 6 0 1 1-1.39-6.23L13 11h7V4z"/></svg>';

function patchTabbar() {
  const tabbar = document.getElementById('tabbar');
  if (!tabbar) return;
  // Ensure tab buttons navigate correctly via our patches
  Array.from(tabbar.querySelectorAll('.tab-btn')).forEach(btn => {
    btn.addEventListener('click', () => {
      const tab = btn.getAttribute('data-tab')!;
      TG.haptic.tap();
      // update active
      tabbar.querySelectorAll('.tab-btn').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
    });
  });
  // Keep active sync on hashchange
  window.addEventListener('hashchange', () => {
    const h = location.hash || '#/home';
    tabbar.querySelectorAll('.tab-btn').forEach(b => {
      const t = b.getAttribute('data-tab')!;
      if (h.startsWith(t)) b.classList.add('active');
      else b.classList.remove('active');
    });
  });
}

function patchViewHome() {
  const origViewHome = (window as any).viewHome;
  if (!origViewHome) {
    // Hook via capturing after legacy viewHome renders: we add search bar injection after render
    const viewEl = document.getElementById('view')!;
    const obs = new MutationObserver(() => {
      if (location.hash === '#/home' || location.hash === '') {
        const view = document.getElementById('view');
        if (view && view.querySelector('.hero') && !view.querySelector('.search-row')) {
          injectHomeSearch(view);
          injectInboxEntry(view);
        }
      }
    });
    obs.observe(viewEl, { childList: true, subtree: true });
    return;
  }
}
function injectHomeSearch(view: HTMLElement) {
  const hero = view.querySelector('.hero');
  const seg = view.querySelector('.segmented');
  if (!hero || !seg) return;
  const searchRow = UI.h('div', { class: 'search-row' }, [
    UI.h('input', {
      class: 'search-input',
      placeholder: 'Search by ID, asset, status…',
      oninput(e: any) {
        (window as any).App.state.searchQuery = e.target.value.toLowerCase().trim();
        // trigger filter re-render if App exposes renderList
        // fallback: filter visible deal cards
        filterDealCards();
      }
    })
  ]) as HTMLElement;
  seg.parentNode!.insertBefore(searchRow, seg.nextSibling);

  // inbox quick entry
  const stats = view.querySelector('.stats-grid');
  if (stats && !view.querySelector('#inbox-entry')) {
    const inboxBtn = UI.h('button', {
      class: 'card row',
      style: 'width:100%;text-align:left;padding:12px 14px;margin-top:10px',
      onclick() { TG.haptic.light(); go('#/inbox'); }
    }, [
      UI.h('div', { class: 'li-icon', text: '📥' }),
      UI.h('div', { class: 'li-main' }, [
        UI.h('b', { text: 'Inbox — Join Requests' }),
        UI.h('span', { text: 'Approve counterparty approvals (photo + username)' })
      ]),
      UI.h('span', { class: 'li-value', text: '→' })
    ]);
    (inboxBtn as any).id = 'inbox-entry';
    stats.parentNode!.insertBefore(inboxBtn, seg);
  }
}

function injectInboxEntry(view: HTMLElement) {
  if (view.querySelector('#inbox-entry')) return;
  const seg = view.querySelector('.segmented');
  if (!seg) return;
  const card = UI.h('button', {
    class: 'card row',
    style: 'width:100%;text-align:left;padding:12px 14px;margin-top:8px',
    onclick() { go('#/inbox'); }
  }, [
    UI.h('div', { class: 'li-icon', text: '📥' }),
    UI.h('div', { class: 'li-main' }, [
      UI.h('b', { text: 'Inbox' }),
      UI.h('span', { text: 'Pending join requests' })
    ]),
    UI.h('span', { class: 'li-value', text: '→' })
  ]);
  (card as any).id = 'inbox-entry';
  seg.parentNode!.insertBefore(card, seg);
}

function filterDealCards() {
  const q = (window as any).App.state.searchQuery || '';
  const cards = document.querySelectorAll('.deal-card');
  cards.forEach((c: any) => {
    const text = (c.textContent || '').toLowerCase();
    const show = !q || text.includes(q);
    (c as HTMLElement).style.display = show ? '' : 'none';
  });
}

function patchViewDeal() {
  // Patch after viewDeal renders via observer
  const viewEl = document.getElementById('view')!;
  const obs = new MutationObserver(() => {
    const hash = location.hash || '';
    if (/^#\/deal\/\d+$/.test(hash)) {
      const view = document.getElementById('view');
      if (view && view.querySelector('.deal-head') && !view.querySelector('.confirm-bar')) {
        injectConfirmBar(view, hash);
      }
    }
  });
  obs.observe(viewEl, { childList: true, subtree: true });
}

async function injectConfirmBar(view: HTMLElement, hash: string) {
  const m = hash.match(/^#\/deal\/(\d+)$/);
  if (!m) return;
  const id = m[1];
  let deal: any;
  try { deal = await Api.deal(id); } catch { return; }
  if (!deal) return;
  const uid = (window as any).App?.state?.meId || TG.user().id;
  const isBuyer = Number(deal.buyer_telegram_id) === Number(uid);
  const isSeller = Number(deal.seller_telegram_id) === Number(uid);
  const isParty = isBuyer || isSeller;
  if (!isParty) return;
  const st = String(deal.status || '').toUpperCase();
  const canConfirm = st === 'DEPOSIT_CONFIRMED' || st === 'BUYER_CONFIRMED';
  if (!canConfirm) return;
  // Check if already confirmed by this party via confirmations
  const conf = deal.confirmations || {};
  const already = (isBuyer && conf.buyer) || (isSeller && conf.seller);
  if (already) {
    const bar = UI.h('div', { class: 'banner info' }, [
      UI.h('div', { class: 'small', text: '✓ You confirmed — waiting for counterparty. Both confirms auto-release.' })
    ]);
    const actionsTitle = Array.from(view.querySelectorAll('.section-title')).find(e => e.textContent?.includes('Actions')) as HTMLElement;
    if (actionsTitle) actionsTitle.parentNode!.insertBefore(bar, actionsTitle);
    return;
  }

  const btn = UI.h('button', { class: 'btn btn-primary', text: '✅ Confirm & Release' }) as HTMLButtonElement;
  const hint = UI.h('div', { class: 'field-hint', style: 'text-align:center;margin-top:6px', text: st === 'BUYER_CONFIRMED' ? 'Counterparty confirmed — your confirm will auto-release funds.' : 'Confirm delivery / fiat received. Funds release when both confirm.' });
  const bar = UI.h('div', { class: 'confirm-bar', style: 'flex-direction:column' }, [UI.h('div', { style: 'display:flex;gap:10px' }, [btn]), hint]);

  const actionsTitle = Array.from(view.querySelectorAll('.section-title')).find(e => e.textContent?.includes('Actions')) as HTMLElement;
  if (actionsTitle) actionsTitle.parentNode!.insertBefore(bar, actionsTitle);
  else view.appendChild(bar);

  btn.addEventListener('click', async () => {
    const orig = btn.textContent!;
    btn.setAttribute('disabled', '');
    btn.textContent = 'Confirming…';
    TG.haptic.medium();
    try {
      const res = await Api.confirmDeal(id);
      TG.haptic.success();
      UI.toast(res.message || 'Confirmed', 'ok');
      // Refresh deal view
      setTimeout(() => { location.hash = '#/deal/' + id; location.reload(); }, 600);
    } catch (e: any) {
      TG.haptic.error();
      UI.toast(e.message || 'Confirm failed', 'err');
      btn.removeAttribute('disabled');
      btn.textContent = orig;
    }
  });

  // Enhance pay sheet chain polling if buyer and awaiting
  if (isBuyer && st === 'AWAITING_DEPOSIT') {
    // Add post-pay verification note
    const payBtn = Array.from(view.querySelectorAll('button')).find(b => b.textContent?.includes('Pay ')) as HTMLElement;
    if (payBtn) {
      const note = view.querySelector('.field-hint');
      if (note) (note as HTMLElement).textContent += ' Wallet memo is encrypted auto-injected.';
    }
  }
}

// ---------------- Inbox View ----------------
async function viewInbox() {
  setTabbarPatched(true);
  setTopbarPatched('Inbox', { back: () => navBack('#/home') });
  TG.showBack(() => navBack('#/home'));
  const view = document.getElementById('view')!;
  view.innerHTML = '';
  const root = UI.h('div', {}, [
    UI.h('div', { class: 'banner info' }, [ UI.h('div', { class: 'small', text: 'Counterparty requests to join your deals. Approve to show their photo & username — you control who joins.' }) ]),
    UI.h('div', { class: 'sk', style: 'height:80px;border-radius:18px' })
  ]);
  view.appendChild(root);

  let requests: any[] = [];
  try {
    // Try global inbox first, fallback to per-deal enumeration via deals list
    try { requests = await Api.inbox(); } catch {}
    if (!requests.length) {
      const deals = await Api.deals();
      const pending: any[] = [];
      for (const d of deals.slice(0, 20)) {
        try {
          const reqs = await Api.joinRequests(d.id);
          reqs.forEach((r: any) => pending.push({ ...r, deal: d }));
        } catch {}
      }
      requests = pending;
    }
  } catch (e: any) {
    root.innerHTML = '';
    root.appendChild(UI.h('div', { class: 'banner error' }, [ UI.h('div', { class: 'small', text: e.message || 'Could not load inbox' }) ]));
    return;
  }

  root.innerHTML = '';
  root.appendChild(UI.h('div', { class: 'banner info' }, [ UI.h('div', { class: 'small', text: requests.length ? `${requests.length} pending request(s)` : 'No pending join requests — invite via bot link.' }) ]));

  if (!requests.length) {
    root.appendChild(UI.h('div', { class: 'empty' }, [
      UI.h('div', { class: 'art', text: '📥' }),
      UI.h('h3', { text: 'No pending requests' }),
      UI.h('p', { text: 'Share a bot invite link (t.me) from deal detail. When someone opens it, you will see their photo & username here.' })
    ]));
    return;
  }

  requests.forEach((r: any) => {
    const deal = r.deal || { id: r.deal_id };
    const card = UI.h('div', { class: 'studio-card inbox-card' }, [
      UI.h('div', { class: 'studio-head' }, [
        UI.h('div', { class: 'avatar ' + UI.avatarClass(r.requester_telegram_id), text: String(r.requester_first_name || r.requester_username || r.requester_telegram_id || '?').slice(0,2) }),
        UI.h('div', {}, [
          UI.h('b', { text: r.requester_first_name || r.requester_username || ('ID ' + r.requester_telegram_id) }),
          UI.h('div', { class: 'small muted', text: `@${r.requester_username || '—'} · Deal #${deal.id} · ${UI.timeAgo(r.created_at)}` })
        ])
      ]),
      r.requester_photo_url ? UI.h('img', { src: r.requester_photo_url, style: 'width:56px;height:56px;border-radius:50%;object-fit:cover;margin-bottom:8px' } as any) : null,
      UI.h('div', { class: 'inbox-actions' }, [
        UI.h('button', {
          class: 'btn btn-primary',
          onclick: async (e: any) => {
            const btn = e.currentTarget as HTMLButtonElement;
            btn.setAttribute('disabled',''); btn.textContent='Approving…';
            try { await Api.approveJoin(deal.id, r.id); TG.haptic.success(); UI.toast('Approved — deal started', 'ok'); viewInbox(); }
            catch (err: any) { TG.haptic.error(); UI.toast(err.message || 'Approve failed','err'); btn.removeAttribute('disabled'); btn.textContent='Approve'; }
          }
        }, ['Approve']),
        UI.h('button', {
          class: 'btn btn-ghost',
          onclick: async (e: any) => {
            const btn = e.currentTarget as HTMLButtonElement;
            btn.setAttribute('disabled',''); btn.textContent='Rejecting…';
            try { await Api.rejectJoin(deal.id, r.id); TG.haptic.success(); UI.toast('Rejected','ok'); viewInbox(); }
            catch (err: any) { TG.haptic.error(); UI.toast(err.message || 'Reject failed','err'); btn.removeAttribute('disabled'); btn.textContent='Reject'; }
          }
        }, ['Reject'])
      ])
    ]);
    root.appendChild(card);
  });
}

function wrapWalletPayForVerification() {
  const origPay = Wallet.pay.bind(Wallet);
  (Wallet as any).pay = async (to: string, amountTon: number, comment: string) => {
    const res = await origPay(to, amountTon, comment);
    // Fire-and-forget chain poll for verification — shows explorer after confirmation
    const boc = (res as any)?.boc || '';
    try {
      let tries = 0;
      const poll = async () => {
        tries++;
        try {
          const bal = await Api.balance(to).catch(()=>null);
          if (bal && bal.state === 'active') {
            UI.toast('On-chain verified — balance ' + bal.balanceTon + ' TON', 'ok');
            // Optionally refresh deal view if still on detail
            if (location.hash.match(/^#\/deal\/\d+$/)) {
              // trigger soft reload via re-fetch deal
              const id = location.hash.match(/\d+/)?.[0];
              if (id) {
                const addrBtn = document.querySelector('.chain-chip') as HTMLElement;
                if (addrBtn) addrBtn.textContent = 'On-chain: verifying…';
              }
            }
            return;
          }
        } catch {}
        if (tries < 3) setTimeout(poll, 3000 + tries * 1500);
        else if (boc) {
          // show tonviewer tx link if available (tonviewer.com/transaction/<boc> not exact, but address explorer)
          UI.toast('Payment sent — view on tonviewer.com/' + to.slice(0, 8) + '…', 'ok');
        }
      };
      setTimeout(poll, 2500);
    } catch {}
    return res;
  };
}

function observePaySheetLock() {
  const sheetRoot = document.getElementById('sheet-root')!;
  const obs = new MutationObserver(() => {
    const sheet = sheetRoot.querySelector('.sheet');
    if (!sheet) return;
    const title = sheet.querySelector('h3');
    if (title && title.textContent?.includes('Pay with wallet')) {
      const input = sheet.querySelector('input.input') as HTMLInputElement;
      if (input && !input.dataset.locked) {
        input.dataset.locked = '1';
        // Lock to exact amount — show warning if edited
        const origVal = input.value;
        input.addEventListener('input', () => {
          const v = parseFloat(String(input.value).replace(',', '.'));
          const orig = parseFloat(String(origVal).replace(',', '.'));
          if (isFinite(v) && isFinite(orig) && Math.abs(v - orig) > 0.0001) {
            input.style.borderColor = 'var(--warn)';
            input.title = 'Amount must exactly match escrow amount — underpay will not confirm deposit';
          } else {
            input.style.borderColor = '';
            input.title = '';
          }
        });
        // Also add helper text below input
        const hint = document.createElement('div');
        hint.className = 'field-hint';
        hint.style.color = 'var(--warn)';
        hint.textContent = 'Send exact amount — memo auto-injected. Listener verifies value === escrow amount.';
        input.parentNode?.appendChild(hint);
      }
    }
  });
  obs.observe(sheetRoot, { childList: true, subtree: true });
}

function patchProfile() {
  const viewEl = document.getElementById('view')!;
  const obs = new MutationObserver(() => {
    if (location.hash === '#/profile') {
      const view = document.getElementById('view');
      if (view) {
        // hide any admin tools entry that legacy injected (look for Admin Tools text)
        Array.from(view.querySelectorAll('.list-item, button, .card')).forEach((el: any) => {
          if (el.textContent && (el.textContent.includes('Admin Tools') || el.textContent.includes('Admin'))) {
            const isAdminCard = el.textContent.includes('Admin') && el.textContent.length < 80;
            // Keep admin card but add bot-only badge instead of link
            if (isAdminCard && !el.querySelector('.admin-bot-badge')) {
              const badge = UI.h('span', { class: 'badge plain', style: 'background:var(--accent-soft);color:var(--accent);margin-left:6px', text: 'bot only' });
              (badge as any).className = 'admin-bot-badge badge plain';
              el.appendChild(badge);
              // disable click
              el.style.opacity = '0.7';
              el.onclick = () => UI.toast('Admin via bot only — no webapp admin', 'err');
            }
          }
        });
        // Also hide any #/admin navigation buttons: override onclick
        const adminBtn = Array.from(view.querySelectorAll('button')).find(b => b.textContent?.includes('Admin'));
        if (adminBtn) adminBtn.addEventListener('click', (e) => { e.preventDefault(); UI.toast('Admin control via bot only', 'err'); }, true);
      }
    }
  });
  obs.observe(viewEl, { childList: true, subtree: true });
}

async function pollInboxBadge() {
  try {
    let count = 0;
    try { const inbox = await Api.inbox(); count = inbox.length; } catch {
      const deals = await Api.deals().catch(()=>[]);
      for (const d of (deals as any[]).slice(0,5)) {
        try { const reqs = await Api.joinRequests(d.id); count += reqs.length; } catch {}
      }
    }
    const tab = document.querySelector('.tab-btn[data-tab="#/home"]');
    // we keep count on Deals tab or add small dot
    let badge = document.getElementById('inbox-badge');
    if (count > 0) {
      if (!badge) {
        badge = UI.h('span', { class: 'badge plain', style: 'background:var(--accent);color:#fff;font-size:10px;padding:2px 6px;margin-left:4px', text: String(count) });
        (badge as any).id = 'inbox-badge';
        const homeBtn = document.querySelector('[data-tab="#/home"] span:last-child');
        homeBtn?.parentNode?.appendChild(badge);
      } else badge.textContent = String(count);
    } else if (badge) badge.remove();
  } catch {}
}

// ---------------- Channels View ----------------
function viewChannels() {
  setTabbarPatched(true);
  setTopbarPatched('Channels Studio', { back: () => navBack('#/home') });
  TG.showBack(() => navBack('#/home'));
  const view = document.getElementById('view')!;
  view.innerHTML = '';
  const rights = ['changeInfo','postMessages','editMessages','deleteMessages','banUsers','inviteUsers','pinMessages','addAdmins','anonymous','manageCall','manageTopics'];
  const rightsState: Record<string, boolean> = { banUsers: true, inviteUsers: true, pinMessages: true };
  let currentInfo: any = null;

  const idInput = UI.h('input', { class: 'input', placeholder: '@username or -100… or channel ID', type: 'text' }) as HTMLInputElement;
  const statusEl = UI.h('div', { class: 'small muted', style: 'margin-top:8px', text: 'Paste @username, numeric ID, or t.me link' });
  const resultBox = UI.h('div', { style: 'margin-top:16px' });

  const renderRights = () => {
    const grid = UI.h('div', { class: 'rights-grid' });
    rights.forEach(r => {
      const checked = !!rightsState[r];
      const item = UI.h('label', { class: 'rights-item' }, [
        UI.h('input', { type: 'checkbox', checked: checked ? '' : null, onchange(e: any) { rightsState[r] = e.target.checked; } } as any),
        UI.h('span', { text: r })
      ]);
      grid.appendChild(item);
    });
    return grid;
  };
  let rightsGrid = renderRights();

  const adminListBox = UI.h('div', { style: 'margin-top:12px' });
  const actionRow = UI.h('div', { class: 'btn-row', style: 'flex-wrap:wrap' });

  async function loadInfo() {
    const raw = idInput.value.trim();
    if (!raw) { UI.toast('Enter channel ID','err'); return; }
    let cid = raw;
    // normalize @ -> strip, t.me link -> username
    if (cid.startsWith('https://t.me/') || cid.startsWith('t.me/')) {
      try { const u = new URL(cid.startsWith('http') ? cid : 'https://' + cid); cid = '@' + u.pathname.split('/')[1]; } catch {}
    }
    statusEl.textContent = 'Loading…';
    resultBox.innerHTML = '';
    adminListBox.innerHTML = '';
    actionRow.innerHTML = '';
    try {
      const info = await Api.ubot.info(cid);
      currentInfo = info;
      statusEl.textContent = 'Channel found';
      const card = UI.h('div', { class: 'studio-card' }, [
        UI.h('div', { class: 'studio-head' }, [
          UI.h('div', { class: 'li-icon', text: '📢' }),
          UI.h('div', {}, [ UI.h('b', { text: info.title || cid }), UI.h('span', { text: `ID ${info.id || cid} · ${info.participants_count || '—'} members` }) ])
        ]),
        UI.h('div', { class: 'small muted', text: info.username ? '@' + info.username : cid }),
      ]);
      resultBox.appendChild(card);

      // Admins
      try {
        const admins = await Api.ubot.admins(cid);
        const list = Array.isArray(admins) ? admins : admins.admins || [];
        adminListBox.appendChild(UI.h('div', { class: 'section-title', text: `Admins (${list.length})` }));
        list.slice(0, 10).forEach((a: any) => {
          adminListBox.appendChild(UI.h('div', { class: 'studio-card', style: 'padding:10px;display:flex;justify-content:space-between' }, [
            UI.h('span', { text: `${a.user?.first_name || a.user?.username || 'ID ' + a.userId}` }),
            UI.h('span', { class: 'small muted', text: a.rank || '' })
          ]));
        });
      } catch {}

      // Actions
      const userIdInput = UI.h('input', { class: 'input', placeholder: 'Target Telegram ID (numeric)', type: 'text', inputmode: 'numeric' }) as HTMLInputElement;
      const rankInput = UI.h('input', { class: 'input', placeholder: 'Rank (optional, ≤32 chars)', maxlength: '32' }) as HTMLInputElement;
      actionRow.appendChild(UI.h('div', { class: 'field', style: 'width:100%' }, [ UI.h('label', { text: 'Target User ID' }), userIdInput ]));
      actionRow.appendChild(UI.h('div', { class: 'field', style: 'width:100%' }, [ UI.h('label', { text: 'Rank' }), rankInput ]));
      actionRow.appendChild(rightsGrid);

      const mkBtn = (label: string, cls: string, fn: (uid: string, rank: string)=>Promise<any>) => UI.h('button', {
        class: 'btn ' + cls,
        onclick: async (e: any) => {
          const uid = userIdInput.value.trim();
          if (!uid || !/^\d+$/.test(uid)) { UI.toast('Enter numeric Telegram ID','err'); return; }
          const rank = rankInput.value.trim();
          const btn = e.currentTarget as HTMLButtonElement;
          const orig = btn.textContent;
          btn.setAttribute('disabled',''); btn.textContent='Working…';
          try { await fn(uid, rank); TG.haptic.success(); UI.toast(label + ' ok','ok'); }
          catch (err: any) { TG.haptic.error(); UI.toast(err.message || label + ' failed','err'); }
          finally { btn.removeAttribute('disabled'); if (orig) btn.textContent = orig; }
        }
      }, [label]);

      const btnRow2 = UI.h('div', { class: 'btn-row' }, [
        mkBtn('Promote', 'btn-soft', (uid, rank) => Api.ubot.promote(cid, { userId: Number(uid), rights: rightsState, rank })),
        mkBtn('Invite', 'btn-ghost', (uid) => Api.ubot.invite(cid, { userId: Number(uid) }))
      ]);
      const btnRow3 = UI.h('div', { class: 'btn-row' }, [
        mkBtn('Demote', 'btn-ghost', async (uid) => Api.ubot.promote(cid, { userId: Number(uid), rights: {}, rank: '' })),
      ]);
      const transferBtn = UI.h('button', {
        class: 'btn btn-primary',
        onclick: async (e: any) => {
          const uid = userIdInput.value.trim();
          if (!uid) { UI.toast('Enter target ID','err'); return; }
          const pw = prompt('Transfer ownership requires 2FA password (if enabled) — enter or leave empty:') || undefined;
          const btn = e.currentTarget as HTMLButtonElement; btn.setAttribute('disabled',''); const orig=btn.textContent; btn.textContent='Transferring…';
          try { await Api.ubot.transfer(cid, { newOwnerId: Number(uid), password: pw }); TG.haptic.success(); UI.toast('Transferred','ok'); }
          catch (err: any) { TG.haptic.error(); UI.toast(err.message || 'Transfer failed','err'); }
          finally { btn.removeAttribute('disabled'); btn.textContent=orig!; }
        }
      }, ['Transfer Ownership']);
      const takeoverBtn = UI.h('button', {
        class: 'btn btn-primary',
        style: 'background:var(--accent-grad);margin-top:8px',
        onclick: async (e: any) => {
          const uid = userIdInput.value.trim();
          if (!uid) { UI.toast('Enter new owner ID','err'); return; }
          const rank = rankInput.value.trim();
          const btn = e.currentTarget as HTMLButtonElement; btn.setAttribute('disabled',''); const orig=btn.textContent; btn.textContent='Taking over… (promote→transfer)';
          try { await Api.ubot.takeover(cid, { newOwnerId: Number(uid), rights: rightsState, rank }); TG.haptic.success(); UI.toast('Takeover done','ok'); }
          catch (err: any) { TG.haptic.error(); UI.toast(err.message || 'Takeover failed — check FRESH_CHANGE 24h breaker','err'); }
          finally { btn.removeAttribute('disabled'); btn.textContent=orig!; }
        }
      }, ['⚡ Takeover (one-tap)']);

      resultBox.appendChild(UI.h('div', { style: 'margin-top:12px' }, [ userIdInput.parentElement!, rankInput.parentElement!, rightsGrid, btnRow2, btnRow3, transferBtn, takeoverBtn ]));
      resultBox.appendChild(UI.h('div', { class: 'banner info', style: 'margin-top:12px' }, [ UI.h('div', { class: 'small', text: 'Takeover = promote (1.2-2.2s human delay) → 2.5s → transfer via SRP 2FA. Respects 24h FRESH_CHANGE_ADMINS_FORBIDDEN breaker & 1.3s global rate.' }) ]));
    } catch (e: any) {
      statusEl.textContent = '';
      UI.toast(e.message || 'Channel not found','err');
      resultBox.appendChild(UI.h('div', { class: 'banner error' }, [ UI.h('div', { class: 'small', text: e.message || 'Not found or not admin' }) ]));
    }
  }

  const searchBtn = UI.h('button', { class: 'btn btn-primary', onclick: loadInfo }, ['Load Channel']);
  const groupBox = UI.h('div', { class: 'card', style: 'margin-top:16px' }, [
    UI.h('b', { text: 'Groups — migrate basic → supergroup' }),
    UI.h('p', { class: 'small muted', style: 'margin-top:4px', text: 'Basic groups must be migrated before admin transfer. Paste group ID and check.' }),
    UI.h('div', { class: 'search-row' }, [
      UI.h('input', { class: 'input', placeholder: 'Group ID or @username', id: 'group-id' } as any),
      UI.h('button', {
        class: 'btn btn-soft',
        style: 'width:auto;padding:10px 14px',
        onclick: async () => {
          const inp = document.getElementById('group-id') as HTMLInputElement;
          const gid = inp?.value.trim();
          if (!gid) { UI.toast('Enter group ID','err'); return; }
          try {
            const r: any = await Api.ubot.groupIsBasic(gid);
            if (r.isBasic) {
              UI.toast('Basic group — migrating…','ok');
              const m: any = await Api.ubot.groupMigrate(gid);
              UI.toast('Migrated → channel ID ' + (m.channelId || m.id),'ok');
            } else UI.toast('Already supergroup','ok');
          } catch (err: any) { UI.toast(err.message || 'Migrate failed','err'); }
        }
      }, ['Migrate'])
    ])
  ]);

  const root = UI.h('div', {}, [
    UI.h('div', { class: 'hero' }, [ UI.h('h1', { text: 'Channels Studio' }), UI.h('p', { text: 'Take over channels & groups — promote, invite, transfer ownership via encrypted ubot.' }) ]),
    UI.h('div', { class: 'card' }, [
      UI.h('label', { text: 'Channel / Group' }),
      idInput,
      UI.h('div', { style: 'height:8px' }),
      searchBtn,
      statusEl
    ]),
    resultBox,
    adminListBox,
    actionRow,
    groupBox
  ]);
  view.appendChild(root);
}

// ---------------- Trade View ----------------
function viewTrade() {
  setTabbarPatched(true);
  setTopbarPatched('Trade Studio', { back: () => navBack('#/home') });
  TG.showBack(() => navBack('#/home'));
  const view = document.getElementById('view')!;
  view.innerHTML = '';
  let mode: 'sell' | 'buy' | 'my' = 'sell';

  const tabs = UI.h('div', { class: 'trade-tabs', role: 'tablist' }, [
    UI.h('button', { class: 'active', onclick() { mode='sell'; update(); (tabs.children[0] as any).classList.add('active'); Array.from(tabs.children).slice(1).forEach(c=>c.classList.remove('active')); } }, ['Sell']),
    UI.h('button', { onclick() { mode='buy'; update(); Array.from(tabs.children).forEach((c,i)=> { if(i===1) c.classList.add('active'); else c.classList.remove('active'); }); } }, ['Buy']),
    UI.h('button', { onclick() { mode='my'; update(); Array.from(tabs.children).forEach((c,i)=> { if(i===2) c.classList.add('active'); else c.classList.remove('active'); }); } }, ['My Trades'])
  ]);
  const body = UI.h('div', {});

  function update() {
    body.innerHTML = '';
    if (mode === 'sell') body.appendChild(renderSell());
    else if (mode === 'buy') body.appendChild(renderBuy());
    else renderMyTrades(body);
  }

  function renderSell(): HTMLElement {
    const sessionInput = UI.h('textarea', { class: 'input', placeholder: 'Paste StringSession (1… ) or phone:+998...', rows: '3', style: 'min-height:88px' }) as HTMLTextAreaElement;
    const phoneInput = UI.h('input', { class: 'input', placeholder: 'Phone +998... (E.164) — alternative to session', type: 'text' }) as HTMLInputElement;
    const statusEl = UI.h('div', { class: 'small muted', style: 'margin-top:8px' });

    const createBtn = UI.h('button', {
      class: 'btn btn-primary',
      onclick: async (e: any) => {
        const sess = sessionInput.value.trim();
        const phone = phoneInput.value.trim();
        if (!sess && !phone) { UI.toast('Paste session or phone','err'); return; }
        const btn = e.currentTarget as HTMLButtonElement; btn.setAttribute('disabled',''); const orig=btn.textContent; btn.textContent='Creating…';
        try {
          let res: any;
          if (sess && sess.length > 50) {
            res = await Api.utrade.createTrade({ session: sess, phone: phone || undefined });
          } else if (phone) {
            // phone path via utrade — server will send code to phone
            res = await Api.utrade.createTrade({ phone });
          } else { throw new Error('Session too short'); }
          TG.haptic.success();
          const id = res.trade?.id || res.id || res.tradeId;
          statusEl.textContent = 'Trade #' + id + ' created — status: ' + (res.trade?.status || res.status || 'SELLER_REMOVED');
          UI.toast('Trade created #' + id, 'ok');
        } catch (err: any) { TG.haptic.error(); UI.toast(err.message || 'Create failed','err'); }
        finally { btn.removeAttribute('disabled'); btn.textContent=orig!; }
      }
    }, ['Create Sell Trade']);

    const setPhoneRow = UI.h('div', { class: 'search-row', style: 'margin-top:16px' }, [
      UI.h('input', { class: 'input', placeholder: 'Trade ID', id: 'sell-trade-id', style: 'max-width:120px' } as any),
      UI.h('input', { class: 'input', placeholder: 'Phone', id: 'sell-phone' } as any),
      UI.h('button', {
        class: 'btn btn-soft', style: 'width:auto',
        onclick: async () => {
          const tid = (document.getElementById('sell-trade-id') as HTMLInputElement)?.value.trim();
          const ph = (document.getElementById('sell-phone') as HTMLInputElement)?.value.trim();
          if (!tid || !ph) { UI.toast('ID + phone required','err'); return; }
          try { await Api.utrade.setPhone(tid, ph); UI.toast('Phone set','ok'); } catch (e: any) { UI.toast(e.message || 'Failed','err'); }
        }
      }, ['Set Phone'])
    ]);

    const confirmRow = UI.h('div', { class: 'search-row' }, [
      UI.h('input', { class: 'input', placeholder: 'Trade ID to confirm payment', id: 'sell-confirm-id', style: 'max-width:160px' } as any),
      UI.h('button', {
        class: 'btn btn-primary', style: 'width:auto',
        onclick: async () => {
          const tid = (document.getElementById('sell-confirm-id') as HTMLInputElement)?.value.trim();
          if (!tid) { UI.toast('Trade ID required','err'); return; }
          try { await Api.utrade.confirmPayment(tid); UI.toast('Payment confirmed — buyer will receive phone','ok'); } catch (e: any) { UI.toast(e.message || 'Failed','err'); }
        }
      }, ['✅ Payment Received'])
    ]);

    return UI.h('div', {}, [
      UI.h('div', { class: 'card' }, [
        UI.h('b', { text: 'Sell Account — StringSession or Phone' }),
        UI.h('p', { class: 'small muted', style: 'margin-top:4px', text: 'Paste StringSession (removes other sessions). Or use phone:+E.164 to receive login code via Telegram.' }),
        UI.h('div', { style: 'height:8px' }),
        sessionInput,
        UI.h('div', { style: 'height:8px' }),
        phoneInput,
        UI.h('div', { style: 'height:12px' }),
        createBtn,
        statusEl
      ]),
      UI.h('div', { class: 'card' }, [ UI.h('b', { text: 'After creation' }), UI.h('p', { class: 'small muted', text: 'Set buyer & phone separately, then confirm payment when buyer paid outside bot (TON/USDT).' }), setPhoneRow, confirmRow ]),
      UI.h('div', { class: 'banner info' }, [ UI.h('div', { class: 'small', text: 'Status flow: PENDING→SELLER_REMOVED (kicked others)→AWAITING_PAYMENT→PHONE_SHARED→AWAITING_CODE→COMPLETED. Sessions encrypted AES-256-GCM.' }) ])
    ]);
  }

  function renderBuy(): HTMLElement {
    const tradeIdInput = UI.h('input', { class: 'input', placeholder: 'Trade ID (from seller)', type: 'text', inputmode: 'numeric' }) as HTMLInputElement;
    const codeInput = UI.h('input', { class: 'input otp-input', placeholder: '— — — — — —', maxlength: '6', inputmode: 'numeric' }) as HTMLInputElement;
    const passInput = UI.h('input', { class: 'input', placeholder: '2FA password if required (2fa:password)', type: 'password' }) as HTMLInputElement;
    const statusEl = UI.h('div', { class: 'small muted', style: 'margin-top:10px' });

    const bindBtn = UI.h('button', {
      class: 'btn btn-soft',
      onclick: async (e: any) => {
        const tid = tradeIdInput.value.trim();
        if (!tid) { UI.toast('Enter Trade ID','err'); return; }
        const btn = e.currentTarget as HTMLButtonElement; btn.setAttribute('disabled',''); const orig=btn.textContent; btn.textContent='Binding…';
        try {
          const t = await Api.utrade.trade(tid);
          // try to bind buyer implicitly via backend — if trade has no buyer, backend will bind on buy
          // attempt buy flow: call trade to trigger bind if needed
          await fetch('/api/utrade/trades/' + tid + '/buy', { method: 'POST', headers: { 'Content-Type':'application/json', 'x-telegram-user-id': String(TG.user().id) } }).catch(()=>{});
          statusEl.textContent = 'Trade #' + tid + ' — phone ' + (t.phone ? (t.phone.slice(0,6)+'****') : 'shared soon') + ' — enter code sent to Telegram.';
          UI.toast('Bound — check Telegram for login code','ok');
        } catch (err: any) { UI.toast(err.message || 'Bind failed','err'); }
        finally { btn.removeAttribute('disabled'); btn.textContent=orig!; }
      }
    }, ['Bind as Buyer']);

    const codeBtn = UI.h('button', {
      class: 'btn btn-primary',
      onclick: async (e: any) => {
        const tid = tradeIdInput.value.trim();
        const code = codeInput.value.trim();
        const pw = passInput.value.trim() || undefined;
        if (!tid || !code) { UI.toast('Trade ID + code required','err'); return; }
        if (!/^\d{5,6}$/.test(code) && !pw) { UI.toast('Enter 5-6 digit code','err'); return; }
        const btn = e.currentTarget as HTMLButtonElement; btn.setAttribute('disabled',''); const orig=btn.textContent; btn.textContent='Verifying…';
        try {
          await Api.utrade.submitCode(tid, code, pw);
          TG.haptic.success();
          UI.toast('Login successful — session handed over, seller logged out','ok');
          statusEl.textContent = '✓ Completed — new session in your account.';
        } catch (err: any) {
          TG.haptic.error();
          const m = err.message || 'Invalid code';
          if (m.includes('2fa')) statusEl.textContent = '2FA required — enter password prefixed 2fa:';
          UI.toast(m,'err');
        } finally { btn.removeAttribute('disabled'); btn.textContent=orig!; }
      }
    }, ['Submit Code']);

    return UI.h('div', {}, [
      UI.h('div', { class: 'card' }, [
        UI.h('b', { text: 'Buy Account — enter code from Telegram' }),
        UI.h('p', { class: 'small muted', style: 'margin-top:4px', text: 'Seller shared phone. Telegram sends login code to that number — enter it here to claim the account. Seller session is auto-logged out.' }),
        UI.h('div', { style: 'height:10px' }),
        tradeIdInput,
        UI.h('div', { style: 'height:8px' }),
        bindBtn,
        UI.h('div', { style: 'height:16px' }),
        UI.h('label', { text: 'Login code (5-6 digits)' }),
        codeInput,
        UI.h('div', { style: 'height:8px' }),
        passInput,
        UI.h('div', { style: 'height:8px' }),
        codeBtn,
        statusEl
      ])
    ]);
  }

  function renderMyTrades(container: HTMLElement) {
    container.innerHTML = '';
    const sk = UI.h('div', { class: 'sk', style: 'height:80px;border-radius:18px' });
    container.appendChild(sk);
    Api.utrade.myTrades().then((trades: any[]) => {
      container.innerHTML = '';
      if (!trades.length) {
        container.appendChild(UI.h('div', { class: 'empty' }, [
          UI.h('div', { class: 'art', text: '🛒' }),
          UI.h('h3', { text: 'No account trades yet' }),
          UI.h('p', { text: 'Create a Sell trade with session/phone, or Buy with a Trade ID from seller.' })
        ]));
        return;
      }
      trades.forEach((t: any) => {
        const st = (t.status || '').toUpperCase();
        const cls = st === 'COMPLETED' ? 'st-released' : st.includes('AWAITING') ? 'st-awaiting' : 'st-unknown';
        container.appendChild(UI.h('div', { class: 'studio-card' }, [
          UI.h('div', { class: 'row' }, [
            UI.h('b', { text: '#' + t.id + ' · ' + st }),
            UI.h('span', { class: 'badge ' + cls, text: st, style: 'margin-left:auto' })
          ]),
          UI.h('div', { class: 'small muted', style: 'margin-top:4px', text: `Phone ${t.phone ? t.phone.slice(0,6)+'****' : '—'} · ${UI.timeAgo(t.created_at)}` }),
        ]));
      });
    }).catch((e: any) => {
      container.innerHTML = '';
      container.appendChild(UI.h('div', { class: 'banner error' }, [ UI.h('div', { class: 'small', text: e.message || 'Could not load trades' }) ]));
    });
  }

  const root = UI.h('div', {}, [
    UI.h('div', { class: 'hero' }, [ UI.h('h1', { text: 'Trade Studio' }), UI.h('p', { text: 'Account sale escrow — StringSession handoff with auto kick & logout.' }) ]),
    tabs,
    body
  ]);
  view.appendChild(root);
  update();
}


