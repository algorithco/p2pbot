/* app.js — TonEscrow Mini App: router, views, controllers */
(function () {
  'use strict';

  var App = {
    state: {
      user: null,
      meId: 0,
      admins: [],
      deals: [],
      filter: 'active',
      apiOk: null,
      createdLinks: {}
    },
    navStack: [],
    currentHash: null,
    _navBack: false,
    cleanupFns: [],
    backHandler: null,
    actionHandler: null,
    wz: null,
    chatTimer: null
  };

  /* ================= Router ================= */

  var ROUTES = [
    { re: /^#\/home$/, fn: viewHome },
    { re: /^#\/create$/, fn: viewCreate },
    { re: /^#\/deal\/(\d+)\/join\/([A-Za-z0-9_\-]+)$/, fn: viewJoin },
    { re: /^#\/deal\/(\d+)\/chat$/, fn: viewChat },
    { re: /^#\/deal\/(\d+)$/, fn: viewDeal },
    { re: /^#\/profile$/, fn: viewProfile },
    { re: /^#\/admin$/, fn: viewAdmin }
  ];

  function cleanup() {
    App.cleanupFns.forEach(function (fn) { try { fn(); } catch (e) {} });
    App.cleanupFns = [];
    if (App.chatTimer) { clearInterval(App.chatTimer); App.chatTimer = null; }
    TG.main.hide();
    TG.hideBack();
    UI.sheetClose();
  }

  function router() {
    cleanup();
    App.backHandler = null;
    App.actionHandler = null;

    var hash = location.hash || '#/home';
    if (App._navBack) { App._navBack = false; App.navStack.pop(); }
    else if (App.currentHash && App.currentHash !== hash) App.navStack.push(App.currentHash);
    if (App.navStack.length > 25) App.navStack.shift();
    App.currentHash = hash;

    var matched = null, m = null;
    for (var i = 0; i < ROUTES.length; i++) {
      m = hash.match(ROUTES[i].re);
      if (m) { matched = ROUTES[i]; break; }
    }

    var root = document.getElementById('view');
    root.classList.remove('view-enter');
    void root.offsetWidth;

    if (!matched) { location.hash = '#/home'; return; }
    matched.fn.apply(null, m.slice(1));
    root.classList.add('view-enter');
    root.scrollTop = 0;
  }

  function go(hash) {
    if (location.hash === hash) router();
    else location.hash = hash;
  }

  function navBack(fallbackHash) {
    var prev = App.navStack.length ? App.navStack[App.navStack.length - 1] : null;
    if (prev && prev !== (location.hash || '#/home')) { App._navBack = true; go(prev); }
    else go(fallbackHash || '#/home');
  }

  /* ================= Chrome (topbar / tabs) ================= */

  function setTopbar(title, opts) {
    opts = opts || {};
    document.getElementById('tb-title').textContent = title;

    var backBtn = document.getElementById('tb-back');
    var actBtn = document.getElementById('tb-action');

    if (opts.back) {
      backBtn.classList.remove('hidden');
      App.backHandler = opts.back;
    } else {
      backBtn.classList.add('hidden');
      App.backHandler = null;
    }

    if (opts.action) {
      actBtn.classList.remove('hidden', 'spin');
      actBtn.innerHTML = opts.action.icon;
      App.actionHandler = opts.action.handler;
    } else {
      actBtn.classList.add('hidden');
      App.actionHandler = null;
    }
  }

  function setTabbar(visible) {
    document.getElementById('tabbar').classList.toggle('hidden', !visible);
    document.getElementById('view').classList.toggle('no-tabbar', !visible);
  }

  function bindChrome() {
    document.getElementById('tb-back').addEventListener('click', function () {
      TG.haptic.light();
      if (App.backHandler) App.backHandler();
    });
    document.getElementById('tb-action').addEventListener('click', function () {
      TG.haptic.tap();
      if (App.actionHandler) App.actionHandler();
    });
    Array.prototype.forEach.call(document.querySelectorAll('.tab-btn'), function (btn) {
      btn.addEventListener('click', function () {
        TG.haptic.tap();
        go(btn.getAttribute('data-tab'));
      });
    });
  }

  var ICON_REFRESH = '<svg viewBox="0 0 24 24" width="20" height="20"><path fill="currentColor" d="M17.65 6.35A8 8 0 1 0 19.7 14h-2.08a6 6 0 1 1-1.39-6.23L13 11h7V4z"/></svg>';

  /* ================= Shared components ================= */

  function dealCard(deal) {
    var am = UI.assetMeta(deal.asset);
    var sm = UI.statusMeta(deal.status);
    var uid = App.state.meId;
    var iAmBuyer = Number(deal.buyer_telegram_id) === uid;
    var otherRole = iAmBuyer ? 'Seller' : 'Buyer';
    var otherId = iAmBuyer ? deal.seller_telegram_id : deal.buyer_telegram_id;
    var sub = otherId
      ? otherRole + ' · ID ' + otherId
      : (deal.buyer_telegram_id ? 'Buyer ' + deal.buyer_telegram_id : 'Open deal') +
        (deal.seller_telegram_id ? ' · Seller ' + deal.seller_telegram_id : '');

    return UI.h('button', {
      class: 'deal-card',
      onclick: function () { TG.haptic.light(); go('#/deal/' + deal.id); }
    }, [
      UI.h('div', { class: 'row' }, [
        UI.h('div', { class: 'asset-glyph ' + am.cls, text: am.glyph }),
        UI.h('div', {}, [
          UI.h('div', { class: 'deal-title', text: 'Deal #' + deal.id }),
          UI.h('div', { class: 'deal-sub', text: sub })
        ]),
        UI.h('div', { class: 'deal-amt' }, [
          UI.h('b', { text: UI.fmtAmount(deal.amount) + ' ' + am.symbol }),
          UI.h('div', {}, [
            UI.h('span', { class: 'badge ' + sm.cls, text: sm.label, style: 'margin-top:5px' })
          ])
        ])
      ])
    ]);
  }

  function emptyState(art, title, text, ctaText, ctaHash) {
    var box = UI.h('div', { class: 'empty' }, [
      UI.h('div', { class: 'art', text: art }),
      UI.h('h3', { text: title }),
      UI.h('p', { text: text })
    ]);
    if (ctaText) {
      box.appendChild(UI.h('button', {
        class: 'btn btn-primary',
        onclick: function () { go(ctaHash || '#/create'); }
      }, [ctaText]));
    }
    return box;
  }

  function errorBox(message, retry) {
    return UI.h('div', { class: 'banner error' }, [
      UI.h('div', { style: 'flex:1' }, [
        UI.h('div', { style: 'font-weight:700;margin-bottom:2px', text: 'Cannot reach server' }),
        UI.h('div', { class: 'small', text: message })
      ]),
      retry ? UI.h('button', { class: 'link-btn', onclick: retry, text: 'Retry' }) : null
    ]);
  }

  /* ================= Wallet ================= */

  function walletPill() {
    var balEl = UI.h('span', { class: 'wallet-bal small muted', style: 'margin-left:8px', text: '' });
    var btn = UI.h('button', {
      class: 'wallet-pill',
      onclick: function () {
        TG.haptic.tap();
        if (!Wallet.available()) { UI.toast('Wallet SDK still loading…'); return; }
        if (Wallet.connected()) walletSheet();
        else Wallet.connect().catch(function (err) {
          console.warn('[App] connect failed', err);
          UI.toast(err && err.message ? err.message : 'Wallet connection cancelled', 'err');
        });
      }
    }, ['🔌 Connect Wallet']);
    var wrap = UI.h('div', { class: 'wallet-pill-wrap', style: 'display:flex;align-items:center' }, [btn, balEl]);

    var render = function (acc) {
      // acc may be passed from onStatus, else use Wallet
      var isConn = Wallet.connected();
      var addr = Wallet.address();
      // If onStatus gave us acc directly, prefer it
      if (acc && acc.address) { isConn = true; addr = acc.address; }
      if (isConn && addr) {
        var friendly = Wallet.addressFriendly ? Wallet.addressFriendly() : (UI.toFriendly ? UI.toFriendly(addr) : addr);
        btn.textContent = '👛 ' + UI.shortAddr(friendly);
        btn.classList.add('connected');
        // Fetch balance async
        balEl.textContent = '…';
        Wallet.getBalance().then(function (r) {
          var ton = r.balanceTon || (Number(r.balance) / 1e9).toString();
          var n = Number(ton);
          balEl.textContent = isFinite(n) ? n.toFixed(4).replace(/\.?0+$/, '') + ' TON' : ton + ' TON';
        }).catch(function (err) {
          console.warn('[App] balance fetch failed', err);
          balEl.textContent = '';
        });
      } else {
        btn.textContent = '🔌 Connect Wallet';
        btn.classList.remove('connected');
        balEl.textContent = '';
      }
    };

    // Immediate + subscribed rendering
    Wallet.whenReady().then(function () { render(); }).catch(function () { render(); });
    Wallet.onStatus(function (acc) { render(acc); });
    // Fallback poll until wallet ready (covers slow SDK)
    var iv = setInterval(function () { if (Wallet.connected()) { render(); clearInterval(iv); } }, 1000);
    setTimeout(function () { clearInterval(iv); }, 10000);
    // Initial render
    render();
    return wrap;
  }

  function walletSheet() {
    var raw = Wallet.address();
    if (!raw) {
      UI.toast('Wallet not connected', 'err');
      return;
    }
    var friendly = Wallet.addressFriendly ? Wallet.addressFriendly() : UI.toFriendly(raw);
    var chain = Wallet.chain ? Wallet.chain() : null;
    var chainLabel = chain === -239 ? 'Mainnet' : chain === -3 ? 'Testnet' : (chain != null ? 'Chain ' + chain : '');
    var balRow = UI.h('div', { class: 'field-hint', style: 'margin:8px 0;font-size:13px', text: 'Balance: loading…' });
    // Fetch balance
    Wallet.getBalance().then(function (r) {
      var ton = r.balanceTon || (Number(r.balance) / 1e9).toString();
      balRow.textContent = 'Balance: ' + ton + ' TON' + (r.state ? ' · ' + r.state : '') + (chainLabel ? ' · ' + chainLabel : '');
    }).catch(function (err) {
      balRow.textContent = 'Balance: unavailable' + (chainLabel ? ' · ' + chainLabel : '');
      console.warn('[App] walletSheet balance failed', err);
    });

    var content = UI.h('div', {}, [
      UI.h('h3', { text: 'Your wallet' }),
      UI.h('p', { class: 'sub', text: (Wallet.walletName() || 'Connected') + (chainLabel ? ' · ' + chainLabel : '') + ' · tap address to copy' }),
      UI.h('button', {
        class: 'addr-pill',
        style: 'margin-bottom:8px',
        onclick: function () { UI.copy(friendly, 'Wallet address copied'); }
      }, [
        UI.h('span', { class: 'mono', text: UI.truncate(friendly, 10, 8) }),
        UI.h('span', { class: 'small muted', text: 'copy' })
      ]),
      UI.h('div', { class: 'addr-pill', style: 'margin-bottom:8px;opacity:.7' }, [
        UI.h('span', { class: 'mono small', text: UI.truncate(raw, 12, 8) }),
        UI.h('span', { class: 'small muted', text: 'raw' })
      ]),
      balRow,
      UI.h('button', {
        class: 'btn btn-danger',
        onclick: function () {
          TG.haptic.medium();
          Wallet.disconnect().then(function () { UI.sheetClose(); UI.toast('Wallet disconnected'); });
        }
      }, ['Disconnect'])
    ]);
    UI.sheetOpen(content);
  }

  /* ================= Home ================= */

  function viewHome() {
    setTabbar(true);
    setTopbar('TonEscrow');

    var s = App.state;
    var name = (s.user && (s.user.first_name || s.user.username)) || 'there';

    var seg = UI.h('div', { class: 'segmented' }, [
      segBtn('active', 'Active'),
      segBtn('done', 'Completed'),
      segBtn('all', 'All')
    ]);

    var stats = UI.h('div', { class: 'stats-grid' });
    var listBox = UI.h('div', { class: 'deal-list' });

    var root = UI.h('div', {}, [
      (!TG.realUser()) ?
        UI.h('div', { class: 'banner info' }, [
          UI.h('div', {}, UI.h('div', { class: 'small', text: 'Preview mode — open this page inside Telegram for full functionality.' }))
        ]) : null,
      UI.h('div', { class: 'hero' }, [
        UI.h('h1', { text: 'Hey, ' + name + ' 👋' }),
        UI.h('p', { text: 'Lock funds in escrow and trade P2P with confidence.' }),
        UI.h('div', { class: 'row', style: 'margin-top:12px' }, [walletPill()])
      ]),
      stats,
      seg,
      listBox,
      UI.h('button', {
        class: 'fab-inline',
        'aria-label': 'New deal',
        onclick: function () { TG.haptic.medium(); go('#/create'); }
      }, [UI.h('span', { html: '<svg viewBox="0 0 24 24" width="26" height="26"><path fill="currentColor" d="M11 5h2v6h6v2h-6v6h-2v-6H5v-2h6z"/></svg>' })])
    ].filter(Boolean));

    function segBtn(key, label) {
      return UI.h('button', {
        class: App.state.filter === key ? 'active' : '',
        onclick: function () {
          TG.haptic.tap();
          App.state.filter = key;
          Array.prototype.forEach.call(seg.children, function (b) { b.classList.remove('active'); });
          seg.children[['active', 'done', 'all'].indexOf(key)].classList.add('active');
          renderList();
        }
      }, [label]);
    }

    function computeStats(deals) {
      var active = 0, done = 0, volume = 0;
      deals.forEach(function (d) {
        var u = String(d.status || '').toUpperCase();
        if (u === 'RELEASED' || u === 'REFUNDED') done++;
        else { active++; if (u === 'DEPOSIT_CONFIRMED' || u === 'BUYER_CONFIRMED') volume += Number(d.amount) || 0; }
      });
      stats.innerHTML = '';
      [[done + active, 'Total'], [active, 'In progress'], [done, 'Completed']].forEach(function (p) {
        stats.appendChild(UI.h('div', { class: 'stat' }, [
          UI.h('b', { text: String(p[0]) }),
          UI.h('span', { text: p[1] })
        ]));
      });
    }

    function matchesFilter(d) {
      var u = String(d.status || '').toUpperCase();
      var f = App.state.filter;
      if (f === 'all') return true;
      if (f === 'done') return u === 'RELEASED' || u === 'REFUNDED';
      return u !== 'RELEASED' && u !== 'REFUNDED';
    }

    function renderList() {
      listBox.innerHTML = '';
      var visible = App.state.deals.filter(matchesFilter);
      if (!visible.length) {
        listBox.appendChild(emptyState(
          '🛡️',
          App.state.filter === 'active' ? 'No active deals' : 'Nothing here yet',
          'Start a secure P2P deal — funds stay locked in escrow until everyone confirms.',
          '+ New Deal'
        ));
        return;
      }
      visible.forEach(function (d) { listBox.appendChild(dealCard(d)); });
    }

    function load(silent) {
      if (!silent) {
        listBox.innerHTML = '';
        listBox.appendChild(UI.skeletonDeals(4));
      }
      return Api.deals()
        .then(function (deals) {
          App.state.apiOk = true;
          App.state.deals = deals;
          computeStats(deals);
          renderList();
        })
        .catch(function (err) {
          listBox.innerHTML = '';
          listBox.appendChild(errorBox(err.message || String(err), function () { load(false); }));
        });
    }

    document.getElementById('view').innerHTML = '';
    document.getElementById('view').appendChild(root);
    load(false);

    setTopbar('TonEscrow', { action: { icon: ICON_REFRESH, handler: function () { load(true); UI.toast('Refreshing…'); } } });

    var t = setInterval(function () { load(true); }, 20000);
    App.cleanupFns.push(function () { clearInterval(t); });
  }

  /* ================= Create deal wizard ================= */

  var DEADLINE_OPTIONS = [
    { h: 24, label: '24 hours' },
    { h: 48, label: '48 hours' },
    { h: 72, label: '3 days' },
    { h: 168, label: '7 days' }
  ];

  function newWizard() {
    return { step: 1, role: 'buy', cp: '', asset: 'TON', amount: '', terms: '', deadlineH: 24 };
  }

  function viewCreate() {
    setTabbar(false);
    App.wz = newWizard();

    var box = UI.h('div', {});
    document.getElementById('view').innerHTML = '';
    document.getElementById('view').appendChild(box);

    function wizBack() {
      if (App.wz.step > 1) { App.wz.step--; renderStep(); }
      else go('#/home');
    }
    setTopbar('New Escrow Deal', { back: wizBack });
    TG.showBack(wizBack);
    TG.preventClose(true);

    function feeOf(amountStr) {
      var n = parseFloat(amountStr);
      if (!isFinite(n) || n <= 0) return 0;
      return n * (UI.feeBpsEstimate / 10000);
    }

    function validate(step) {
      var w = App.wz;
      if (step === 1) {
        var n = Number(String(w.cp).trim());
        if (!n || n <= 0 || !isFinite(n)) { fail('Enter a valid Telegram ID of the ' + (w.role === 'buy' ? 'seller' : 'buyer')); return false; }
      }
      if (step === 2) {
        var amt = parseFloat(w.amount);
        if (!isFinite(amt) || amt <= 0) { fail('Enter a valid amount greater than 0'); return false; }
        if (amt > 1e9) { fail('Amount is too large'); return false; }
      }
      return true;

      function fail(msg) { UI.toast(msg, 'err'); TG.haptic.error(); }
    }

    function submit() {
      var w = App.wz;
      var payload = {
        sellerId: w.role === 'buy' ? Number(w.cp) : App.state.meId,
        buyerId: w.role === 'buy' ? App.state.meId : Number(w.cp),
        asset: w.asset,
        amount: parseFloat(w.amount),
        terms: w.terms || '',
        deadline: new Date(Date.now() + w.deadlineH * 3600000).toISOString()
      };
      if (!TG.available) UI.toast('Creating deal…');
      else TG.main.show('Creating…', function () {}, { progress: true });

      Api.createDeal(payload)
        .then(function (res) {
          TG.haptic.success();
          TG.preventClose(false);
          TG.main.hide();
          App.state.createdLinks[res.deal.id] = res.link;
          renderSuccess(res.deal, res.link);
        })
        .catch(function (err) {
          TG.haptic.error();
          TG.main.hide();
          renderStep();
          UI.toast(err.status === 0 ? 'Network unreachable' : ('Failed: ' + err.message), 'err');
        });
    }

    function renderSuccess(deal, link) {
      setTopbar('Deal Created', { back: function () { go('#/deal/' + deal.id); } });
      TG.showBack(function () { go('#/deal/' + deal.id); });
      var shareUrl = link || location.href.split('#')[0] + '#/deal/' + deal.id;

      box.innerHTML = '';
      box.appendChild(UI.h('div', { class: 'success-panel' }, [
        UI.h('div', { class: 'check-ring', html: '<svg viewBox="0 0 34 34" width="44" height="44"><path d="M8 18l6 6L26 11"/></svg>' }),
        UI.h('h2', { text: 'Escrow deal #' + deal.id + ' created' }),
        UI.h('p', { text: 'Share the invite link with the counterparty. Funds will be held safely until both sides are satisfied.' }),
        UI.h('div', { class: 'link-box' }, [
          UI.h('div', { class: 'mono', text: shareUrl }),
          UI.h('button', {
            class: 'icon-btn',
            'aria-label': 'Copy link',
            html: '<svg viewBox="0 0 24 24" width="19" height="19"><path fill="currentColor" d="M16 1H4a2 2 0 0 0-2 2v14h2V3h12zm3 4H8a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h11a2 2 0 0 0 2-2V7a2 2 0 0 0-2-2m0 16H8V7h11z"/></svg>',
            onclick: function () { UI.copy(shareUrl, 'Invite link copied'); }
          })
        ]),
        UI.h('div', { class: 'btn-row' }, [
          UI.h('button', {
            class: 'btn btn-primary',
            onclick: function () { TG.share(shareUrl, 'Join my escrow deal #' + deal.id + ' on TonEscrow'); }
          }, ['Share invite']),
          UI.h('button', { class: 'btn btn-ghost', onclick: function () { go('#/deal/' + deal.id); } }, ['View deal'])
        ]),
        UI.h('div', { class: 'btn-row' }, [
          UI.h('button', { class: 'btn btn-soft', onclick: function () { go('#/create'); } }, ['Create another'])
        ])
      ]));
    }

    function renderStep() {
      var w = App.wz;
      TG.main.hide();

      var dots = UI.h('div', { class: 'wizard-dots' });
      for (var i = 1; i <= 4; i++) dots.appendChild(UI.h('i', { class: i <= w.step ? 'on' : '' }));

      var body = null;

      if (w.step === 1) {
        var cpLabel = UI.h('label', { text: (w.role === 'buy' ? 'Seller' : 'Buyer') + ' Telegram ID' });
        var cpInput = UI.h('input', {
          class: 'input',
          type: 'text',
          inputmode: 'numeric',
          placeholder: 'e.g. 888281729',
          value: w.cp,
          oninput: function () { w.cp = this.value.trim(); }
        });
        body = [
          UI.h('h3', { style: 'font-size:18px;margin-bottom:4px', text: 'Which side are you?' }),
          UI.h('p', { class: 'muted small', style: 'margin-bottom:14px', text: 'This decides who deposits funds into escrow.' }),
          UI.h('div', { class: 'choice-row', style: 'margin-bottom:18px' }, [
            choice('buy', '🛒', "I'm Buying", 'You pay crypto into escrow'),
            choice('sell', '💰', "I'm Selling", 'You receive crypto after release')
          ]),
          UI.h('div', { class: 'field' }, [
            cpLabel,
            cpInput,
            UI.h('div', { class: 'field-hint', text: 'Numeric ID only. The counterparty can find theirs via @userinfobot.' })
          ])
        ];

        function choice(key, icon, title, subtext) {
          return UI.h('button', {
            class: 'choice-card' + (w.role === key ? ' selected' : ''),
            onclick: function () {
              TG.haptic.tap();
              w.role = key;
              Array.prototype.forEach.call(this.parentNode.children, function (c) { c.classList.remove('selected'); });
              this.classList.add('selected');
              cpLabel.textContent = (key === 'buy' ? 'Seller' : 'Buyer') + ' Telegram ID';
            }
          }, [
            UI.h('span', { class: 'cc-icon', text: icon }),
            UI.h('b', { text: title }),
            UI.h('span', { text: subtext })
          ]);
        }
      }

      if (w.step === 2) {
        var amountLabel = UI.h('label', { text: 'Amount (' + w.asset + ')' });
        var amountInput = UI.h('input', {
          class: 'input',
          type: 'text',
          inputmode: 'decimal',
          placeholder: '0.00',
          value: w.amount,
          oninput: function () {
            w.amount = this.value.replace(/[^0-9.,]/g, '').replace(',', '.');
            this.value = w.amount;
            updateFee();
          }
        });

        var feeLine = UI.h('div', { class: 'field-hint', style: 'margin-top:10px;font-size:13px', text: '' });

        function updateFee() {
          var f = feeOf(w.amount);
          feeLine.textContent = f > 0
            ? 'Escrow fee ≈ ' + UI.fmtAmount(f) + ' ' + w.asset + ' (est. ' + (UI.feeBpsEstimate / 100) + '%)'
            : '';
        }

        body = [
          UI.h('h3', { style: 'font-size:18px;margin-bottom:14px', text: 'Asset & amount' }),
          UI.h('div', { class: 'choice-row', style: 'margin-bottom:18px' }, [
            assetChoice('TON', '◈', 'Toncoin', 'Native TON'),
            assetChoice('USDT', '₮', 'Tether USD', 'Jetton on TON')
          ]),
          UI.h('div', { class: 'field' }, [
            amountLabel,
            amountInput,
            feeLine,
            UI.h('div', { class: 'chip-row' }, ['10', '50', '100', '500'].map(function (v) {
              return UI.h('button', {
                class: 'chip',
                onclick: function () { w.amount = v; amountInput.value = v; updateFee(); TG.haptic.tap(); }
              }, [v]);
            }))
          ])
        ];

        function assetChoice(key, glyph, title, subtext) {
          return UI.h('button', {
            class: 'choice-card' + (w.asset === key ? ' selected' : ''),
            onclick: function () {
              TG.haptic.tap();
              w.asset = key;
              Array.prototype.forEach.call(this.parentNode.children, function (c) { c.classList.remove('selected'); });
              this.classList.add('selected');
              amountLabel.textContent = 'Amount (' + key + ')';
              updateFee();
            }
          }, [
            UI.h('span', { class: 'asset-glyph ' + (key === 'TON' ? 'asset-ton' : 'asset-usdt'), style: 'width:38px;height:38px;font-size:17px;margin-bottom:8px', text: glyph }),
            UI.h('b', { text: title }),
            UI.h('span', { text: subtext })
          ]);
        }
      }

      if (w.step === 3) {
        var ta = UI.h('textarea', {
          class: 'input',
          maxlength: '500',
          placeholder: 'Describe what is being traded, delivery conditions, inspection window…',
          oninput: function () {
            w.terms = this.value;
            counter.textContent = this.value.length + '/500';
          }
        });
        var counter = UI.h('span', { class: 'char-count muted', text: (w.terms || '').length + '/500' });

        var dlRow = UI.h('div', { class: 'chip-row' });
        DEADLINE_OPTIONS.forEach(function (o) {
          dlRow.appendChild(UI.h('button', {
            class: 'chip' + (w.deadlineH === o.h ? ' active' : ''),
            onclick: function () {
              TG.haptic.tap();
              w.deadlineH = o.h;
              Array.prototype.forEach.call(dlRow.children, function (c) { c.classList.remove('active'); });
              this.classList.add('active');
            }
          }, [o.label]));
        });

        body = [
          UI.h('h3', { style: 'font-size:18px;margin-bottom:4px', text: 'Terms & deadline' }),
          UI.h('p', { class: 'muted small', style: 'margin-bottom:14px', text: 'Clear terms prevent disputes. Both parties see them before joining.' }),
          UI.h('div', { class: 'field' }, [
            UI.h('label', {}, [document.createTextNode('Terms '), counter]),
            ta
          ]),
          UI.h('div', { class: 'field' }, [
            UI.h('label', { text: 'Auto-release deadline' }),
            dlRow,
            UI.h('div', { class: 'field-hint', text: 'After the deadline the admin can settle the deal based on confirmations.' })
          ])
        ];
      }

      if (w.step === 4) {
        var am = UI.assetMeta(w.asset);
        body = [
          UI.h('h3', { style: 'font-size:18px;margin-bottom:14px', text: 'Review deal' }),
          UI.h('div', { class: 'card review-rows', style: 'padding:6px 14px' }, [
            rrow('Your role', w.role === 'buy' ? 'Buyer (pays first)' : 'Seller (receives)'),
            rrow((w.role === 'buy' ? 'Seller' : 'Buyer') + ' ID', String(Number(w.cp))),
            rrow('Asset', am.name),
            rrow('Amount', UI.fmtAmount(parseFloat(w.amount)) + ' ' + w.asset),
            rrow('Fee (est.)', UI.fmtAmount(feeOf(w.amount)) + ' ' + w.asset),
            w.terms ? rrow('Terms', w.terms.length > 80 ? UI.truncate(w.terms, 77, 0) : w.terms) : null,
            rrow('Deadline', DEADLINE_OPTIONS.filter(function (o) { return o.h === w.deadlineH; })[0].label)
          ].filter(Boolean)),
          UI.h('div', { class: 'total-line' }, [
            UI.h('span', { text: 'Escrow amount' }),
            UI.h('span', { text: UI.fmtAmount(parseFloat(w.amount)) + ' ' + w.asset })
          ]),
          UI.h('p', { class: 'muted small', style: 'margin-top:14px', text: '🔒 Funds are locked in the escrow contract until release. Nobody can spend them unilaterally — disputes are settled by the admin.' })
        ];
      }

      box.innerHTML = '';
      box.appendChild(dots);
      body.forEach(function (el) { box.appendChild(el); });

      if (w.step < 4) {
        box.appendChild(UI.h('div', { class: 'btn-row' }, [
          w.step > 1 ? UI.h('button', { class: 'btn btn-ghost', onclick: wizBack }, ['Back']) : null,
          UI.h('button', {
            class: 'btn btn-primary',
            onclick: function () {
              if (validate(w.step)) { TG.haptic.light(); w.step++; renderStep(); }
            }
          }, ['Continue'])
        ].filter(Boolean)));
      } else {
        box.appendChild(UI.h('div', { class: 'btn-row' }, [
          UI.h('button', { class: 'btn btn-ghost', onclick: wizBack }, ['Back']),
          UI.h('button', { class: 'btn btn-primary', onclick: submit }, ['🔒 Create Escrow'])
        ]));
        if (TG.available) TG.main.show('🔒 Create Escrow', submit);
      }
    }

    function rrow(k, v) {
      return UI.h('div', { class: 'rrow' }, [
        UI.h('span', { class: 'k', text: k }),
        UI.h('span', { class: 'v', text: v })
      ]);
    }

    renderStep();
  }

  /* ================= Deal detail ================= */

  var CHAIN_STATUS = { 0: 'Awaiting deposit', 1: 'Deposited', 2: 'Released', 3: 'Refunded' };

  function paySheet(deal, payTo, am) {
    var memo = 'escrow#' + deal.id;
    var releaseMemo = 'For ' + (deal.terms ? deal.terms.split(/[\n\r]+/)[0].slice(0, 30) : 'deal') + ' — ' + deal.amount + ' ' + am.symbol + ' — Escrow #' + deal.id;
    var amountInput = UI.h('input', {
      class: 'input',
      type: 'text',
      inputmode: 'decimal',
      value: UI.fmtAmount(deal.amount)
    });
    var memoPill = UI.h('button', {
      class: 'addr-pill',
      style: 'margin-bottom:8px',
      onclick: function () { UI.copy(memo, 'Memo copied — include it in the transaction!'); }
    }, [
      UI.h('span', { class: 'mono', text: memo }),
      UI.h('span', { class: 'small muted', text: 'tap to copy memo' })
    ]);
    var payBtn = UI.h('button', { class: 'btn btn-primary', onclick: doPay }, ['Approve & Pay with memo']);

    UI.sheetOpen(UI.h('div', {}, [
      UI.h('h3', { text: 'Pay with wallet' }),
      UI.h('p', { class: 'sub', text: 'The memo "' + memo + '" is mandatory — it links your payment to this deal on-chain.' }),
      UI.h('div', { class: 'card review-rows', style: 'padding:6px 14px;margin-bottom:14px' }, [
        UI.h('div', { class: 'rrow' }, [
          UI.h('span', { class: 'k', text: 'To' }),
          UI.h('span', { class: 'v mono', text: UI.truncate(UI.toFriendly(payTo), 8, 6) })
        ]),
        UI.h('div', { class: 'rrow' }, [
          UI.h('span', { class: 'k', text: 'Deal' }),
          UI.h('span', { class: 'v', text: '#' + deal.id })
        ]),
        UI.h('div', { class: 'rrow' }, [
          UI.h('span', { class: 'k', text: 'Memo' }),
          UI.h('span', { class: 'v mono', text: memo })
        ])
      ]),
      memoPill,
      UI.h('div', { class: 'field-hint', style: 'margin-bottom:8px;color:#7dd3a5', text: '✓ Memo will be attached automatically. Verify "' + memo + '" in wallet before approving.' }),
      UI.h('div', { class: 'field' }, [UI.h('label', { text: 'Amount (' + am.symbol + ')' }), amountInput]),
      payBtn,
      UI.h('div', { class: 'field-hint', text: 'On release, seller receives "' + UI.truncate(releaseMemo, 40, 0) + '" as memo.' })
    ]));

    function doPay() {
      var amt = parseFloat(String(amountInput.value).replace(',', '.'));
      if (!isFinite(amt) || amt <= 0) { UI.toast('Enter a valid amount', 'err'); return; }
      TG.haptic.medium();
      payBtn.setAttribute('disabled', '');
      payBtn.textContent = 'Waiting for wallet…';

      Wallet.pay(payTo, amt, memo)
        .then(function (res) {
          TG.haptic.success();
          UI.toast('Payment sent with memo "' + memo + '" — awaiting confirmation', 'ok');
          var proof = (res && res.boc) ? UI.truncate(res.boc, 16, 8) : 'wallet transfer';
          // Use encrypted chat path if available, fallback to legacy
          var chatText = '💰 Paid ' + UI.fmtAmount(amt) + ' ' + am.symbol + ' to escrow with memo "' + memo + '". Proof: ' + proof;
          if (window.ChatCrypto && window.Api && Api.sendChatEncrypted) {
            return Api.dealKey(deal.id).then(function (k) {
              if (k) return ChatCrypto.encrypt(chatText, k).then(function (ct) { return Api.sendChatEncrypted(deal.id, App.state.meId, ct); });
              return Api.sendChat(deal.id, App.state.meId, chatText);
            }).catch(function () { return Api.sendChat(deal.id, App.state.meId, chatText); });
          }
          return Api.sendChat(deal.id, App.state.meId, chatText);
        })
        .then(function () { UI.sheetClose(); })
        .catch(function (err) {
          TG.haptic.error();
          var msg = err && err.message ? err.message : 'Payment cancelled or failed';
          if (msg === 'wallet_sdk_unavailable') msg = 'Wallet SDK unavailable';
          else if (msg.indexOf('memo') !== -1) msg = 'Memo error: ' + msg;
          UI.toast(msg, 'err');
          payBtn.removeAttribute('disabled');
          payBtn.textContent = 'Approve & Pay with memo';
        });
    }
  }

  function viewDeal(id) {
    setTabbar(true);
    setTopbar('Deal #' + id, {
      back: function () { navBack('#/home'); },
      action: { icon: ICON_REFRESH, handler: function () { load(); } }
    });
    TG.showBack(function () { navBack('#/home'); });

    var box = UI.h('div', {});
    document.getElementById('view').innerHTML = '';
    document.getElementById('view').appendChild(box);

    function load() {
      box.innerHTML = '';
      var sk = UI.h('div', {});
      sk.appendChild(UI.h('div', { class: 'sk', style: 'height:120px;border-radius:18px;margin-bottom:12px' }));
      sk.appendChild(UI.h('div', { class: 'sk', style: 'height:180px;border-radius:18px' }));
      box.appendChild(sk);

      Api.deal(id)
        .then(function (deal) {
          if (!deal) {
            box.innerHTML = '';
            box.appendChild(emptyState('🔍', 'Deal not found', 'This deal does not exist or was removed.', 'Back to Deals', '#/home'));
            return;
          }
          render(deal);
        })
        .catch(function (err) {
          box.innerHTML = '';
          box.appendChild(errorBox(err.message || String(err), function () { load(); }));
        });
    }

    function render(deal) {
      var am = UI.assetMeta(deal.asset);
      var sm = UI.statusMeta(deal.status);
      var uid = App.state.meId;
      var iAmBuyer = Number(deal.buyer_telegram_id) === uid;
      var iAmSeller = Number(deal.seller_telegram_id) === uid;
      var link = App.state.createdLinks[deal.id] || '';

      var head = UI.h('div', { class: 'deal-head' }, [
        UI.h('div', { class: 'asset-glyph ' + am.cls, text: am.glyph }),
        UI.h('div', {}, [
          UI.h('span', { class: 'amt', text: UI.fmtAmount(deal.amount) }),
          UI.h('span', { class: 'cur', text: am.symbol })
        ]),
        UI.h('div', { style: 'margin-top:8px' }, [
          UI.h('span', { class: 'badge ' + sm.cls, text: sm.label })
        ]),
        UI.h('div', { class: 'small muted', style: 'margin-top:6px', text: UI.counterpartyLabel(deal) || 'Deal #' + deal.id })
      ]);

      var steps = [
        { label: 'Created', time: deal.created_at },
        { label: 'Deposit received', time: null },
        { label: iAmSeller ? 'Buyer confirmed' : 'Confirmation', time: null },
        { label: deal.status === 'REFUNDED' ? 'Refunded' : 'Released', time: null }
      ];
      var curStep = sm.step;
      var refunded = deal.status === 'REFUNDED';
      var finalState = UI.isFinalStatus(deal.status);
      var timeline = UI.h('div', { class: 'timeline' });
      steps.forEach(function (st, idx) {
        var cls = 'tl-step ';
        if (refunded && idx === 3) cls += 'fail';
        else if (finalState && idx <= curStep) cls += 'done';
        else if (idx < curStep) cls += 'done';
        else if (idx === curStep) cls += 'now';
        else cls += 'idle';
        timeline.appendChild(UI.h('div', { class: cls }, [
          UI.h('div', { class: 'tl-dot', html: '<svg viewBox="0 0 24 24"><path fill="currentColor" d="M9 16.2 4.8 12l-1.4 1.4L9 19 21 7l-1.4-1.4z"/></svg>' }),
          UI.h('div', {}, [
            UI.h('div', { class: 'tl-label', text: st.label }),
            st.time ? UI.h('div', { class: 'tl-time', text: UI.fmtDateTime(st.time) }) : null
          ].filter(Boolean))
        ]));
      });

      function party(roleLabel, tgId, you) {
        return UI.h('div', { class: 'party' + (you ? ' you' : '') }, [
          UI.h('div', { class: 'avatar ' + UI.avatarClass(tgId), text: String(tgId == null ? '?' : tgId).slice(-2) }),
          UI.h('div', { class: 'p-role', text: roleLabel + (you ? ' · You' : '') }),
          UI.h('div', { class: 'p-name', text: tgId ? 'ID ' + tgId : 'Awaiting counterparty' })
        ]);
      }

      var kv = UI.h('div', { class: 'kv-list card', style: 'padding:6px 14px' }, (function () {
        var rows = [];
        rows.push(kvRow('Created', UI.fmtDateTime(deal.created_at)));
        if (deal.deadline) {
          var cd = UI.countdown(deal.deadline);
          rows.push(kvRow('Deadline', UI.fmtDateTime(deal.deadline) + (cd ? ' · ' + cd.text : '')));
        }
        if (deal.fee_bps != null) rows.push(kvRow('Escrow fee', (Number(deal.fee_bps) / 100) + '%'));
        if (deal.fee_amount != null) rows.push(kvRow('Fee amount', UI.fmtAmount(deal.fee_amount) + ' ' + am.symbol));
        rows.push(kvRow('Status', sm.label));
        return rows;
      })());

      function kvRow(k, v) {
        return UI.h('div', { class: 'rrow' }, [
          UI.h('span', { class: 'k', text: k }),
          UI.h('span', { class: 'v', text: v })
        ]);
      }

      var actions = [];
      if (link && String(deal.status).toUpperCase() === 'AWAITING_DEPOSIT') {
        actions.push(UI.h('button', {
          class: 'btn btn-primary',
          onclick: function () { TG.share(link, 'Join escrow deal #' + deal.id); }
        }, ['Share invite link']));
      }
      actions.push(UI.h('button', {
        class: 'btn btn-soft',
        onclick: function () { TG.haptic.light(); go('#/deal/' + deal.id + '/chat'); }
      }, ['💬 Open deal chat']));
      actions.push(UI.h('button', {
        class: 'btn btn-ghost',
        onclick: function () { UI.copy(String(deal.id), 'Deal ID copied'); }
      }, ['Copy deal ID']));

      box.innerHTML = '';

      var addrSection = null;
      var addr = deal.contract_address || deal.payment_address;
      if (addr) {
        addrSection = UI.h('div', {}, [
          UI.h('div', { class: 'section-title', text: 'Escrow contract' }),
          UI.h('div', { class: 'card', style: 'padding:12px' }, [
            UI.h('button', {
              class: 'addr-pill',
              onclick: function () { UI.copy(addr, 'Contract address copied'); }
            }, [
              UI.h('span', { class: 'mono', text: UI.truncate(addr, 10, 8) }),
              UI.h('span', { class: 'small muted', text: 'tap to copy' })
            ]),
            UI.h('div', { class: 'row', style: 'margin-top:10px' }, [
              UI.h('a', {
                class: 'link-btn',
                href: 'https://tonviewer.com/' + addr,
                target: '_blank',
                rel: 'noopener',
                onclick: function (e) { e.preventDefault(); TG.openLink('https://tonviewer.com/' + addr); }
              }, ['View on explorer ↗']),
              UI.h('span', { class: 'chain-chip small muted', style: 'margin-left:auto', text: '' })
            ])
          ])
        ]);

        if (addr.length > 10) {
          Api.chainStatus(addr)
            .then(function (r) {
              var lbl = CHAIN_STATUS[r && r.status];
              var chip = addrSection.querySelector('.chain-chip');
              if (chip && lbl != null) chip.textContent = 'On-chain: ' + lbl;
            })
            .catch(function () { /* chain API unavailable */ });
        }
      }

      var payTo = (deal.payment_address && String(deal.payment_address).length > 10)
        ? deal.payment_address
        : ((deal.contract_address && String(deal.contract_address).length > 10) ? deal.contract_address : null);

      var paySection = null;
      if (payTo) {
        var canPay = iAmBuyer && String(deal.status).toUpperCase() === 'AWAITING_DEPOSIT' && am.symbol === 'TON';
        var memo = 'escrow#' + deal.id;
        var releaseMemoPreview = 'For ' + (deal.terms ? deal.terms.split(/[\n\r]+/)[0].slice(0, 20) : 'deal') + ' — ' + UI.fmtAmount(deal.amount) + ' ' + am.symbol + ' — Escrow #' + deal.id;
        paySection = UI.h('div', {}, [
          UI.h('div', { class: 'section-title', text: 'Payment — memo required' }),
          UI.h('div', { class: 'card', style: 'padding:12px' }, [
            UI.h('button', {
              class: 'addr-pill',
              onclick: function () { UI.copy(UI.toFriendly(payTo), 'Payment address copied'); }
            }, [
              UI.h('span', { class: 'mono', text: UI.truncate(UI.toFriendly(payTo), 10, 8) }),
              UI.h('span', { class: 'small muted', text: 'tap to copy address' })
            ]),
            UI.h('button', {
              class: 'addr-pill',
              style: 'margin-top:8px',
              onclick: function () { UI.copy(memo, 'Memo copied — paste as comment!'); }
            }, [
              UI.h('span', { class: 'mono', text: memo }),
              UI.h('span', { class: 'small muted', text: 'memo · tap to copy' })
            ]),
            UI.h('div', { class: 'field-hint', style: 'margin-top:8px;color:#7dd3a5', text: 'Send exactly ' + UI.fmtAmount(deal.amount) + ' ' + am.symbol + ' with memo "' + memo + '". The memo links your payment to this deal.' }),
            UI.h('div', { class: 'field-hint', style: 'margin-top:4px', text: 'On release, seller receives with memo "' + UI.truncate(releaseMemoPreview, 36, 0) + '".' }),
            canPay ? UI.h('button', {
              class: 'btn btn-primary',
              style: 'margin-top:10px',
              onclick: function () { TG.haptic.medium(); paySheet(deal, payTo, am); }
            }, ['💳 Pay ' + UI.fmtAmount(deal.amount) + ' ' + am.symbol + ' with memo']) : null,
            (canPay && !Wallet.available()) ? UI.h('div', { class: 'field-hint', style: 'margin-top:6px', text: 'Wallet SDK is loading — reopen this screen if it does not appear.' }) : null,
            (!canPay && String(deal.status).toUpperCase() === 'AWAITING_DEPOSIT' && am.symbol === 'USDT') ? UI.h('div', { class: 'field-hint', style: 'margin-top:8px', text: 'USDT: send Jetton to ' + UI.truncate(UI.toFriendly(payTo), 8, 6) + ' with forward memo "' + memo + '" (0.01 TON forward). Bot detects via forward payload.' }) : null
          ].filter(Boolean))
        ]);
      }

      box.appendChild(head);
      box.appendChild(timeline);
      if (paySection) box.appendChild(paySection);
      box.appendChild(UI.h('div', { class: 'section-title', text: 'Parties' }));
      box.appendChild(UI.h('div', { class: 'parties', style: 'margin-bottom:12px' }, [
        party('Buyer', deal.buyer_telegram_id, iAmBuyer),
        party('Seller', deal.seller_telegram_id, iAmSeller)
      ]));

      if (deal.terms) {
        box.appendChild(UI.h('div', { class: 'section-title', text: 'Terms' }));
        box.appendChild(UI.h('div', {
          class: 'card',
          style: 'user-select:text;white-space:pre-wrap;font-size:14px',
          text: deal.terms
        }));
      }

      box.appendChild(UI.h('div', { class: 'section-title', text: 'Details' }));
      box.appendChild(kv);
      if (addrSection) box.appendChild(addrSection);

      box.appendChild(UI.h('div', { class: 'section-title', text: 'Actions' }));
      actions.forEach(function (b) { box.appendChild(b); box.appendChild(UI.h('div', { style: 'height:8px' })); });
    }

    load();
  }

  /* ================= Deal chat ================= */

  function viewChat(id) {
    setTabbar(false);
    setTopbar('Deal #' + id + ' · Chat', { back: function () { go('#/deal/' + id); } });
    TG.showBack(function () { go('#/deal/' + id); });

    var scroller = UI.h('div', { class: 'chat-scroll' });
    var input = UI.h('textarea', {
      rows: '1',
      placeholder: 'Message…',
      onkeydown: function (e) {
        if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send(); }
      }
    });
    var sendBtn = UI.h('button', {
      class: 'send-btn',
      'aria-label': 'Send',
      html: '<svg viewBox="0 0 24 24" width="21" height="21"><path fill="currentColor" d="M3.4 20.4 20.9 12 3.4 3.6 3.3 10l13 2-13 2z"/></svg>',
      onclick: send
    });
    var statusBar = UI.h('div', { class: 'small muted', style: 'text-align:center;padding:6px;font-size:12px', text: '🔒 Encrypted channel — loading…' });

    document.getElementById('view').innerHTML = '';
    document.getElementById('view').appendChild(UI.h('div', { class: 'chat-wrap' }, [
      statusBar,
      scroller,
      UI.h('div', { class: 'composer' }, [input, sendBtn])
    ]));

    var dealKey = null;
    var keyReady = false;
    var keyError = null;
    var consecutiveFails = 0;

    function bubble(msg) {
      var mine = Number(msg.sender_telegram_id) === App.state.meId;
      var displayText = msg.decrypted || msg.content || '';
      if (msg.is_encrypted && !msg.decrypted && msg.ciphertext) displayText = '🔒 Encrypted message';
      return UI.h('div', { class: 'msg' + (mine ? ' mine' : '') }, [
        UI.h('div', { class: 'bubble' }, [
          UI.h('div', { text: displayText, style: 'word-break:break-word;white-space:pre-wrap' }),
          UI.h('div', { class: 'm-meta', text: (mine ? '' : shortName(msg.sender_telegram_id) + ' · ') + UI.fmtTime(msg.created_at) + (msg.is_encrypted ? ' · 🔒' : '') })
        ])
      ]);
    }

    function shortName(tid) {
      var s = String(tid == null ? '?' : tid);
      return s.length > 8 ? s.slice(0, 6) + '…' : s;
    }

    async function decryptList(list) {
      if (!keyReady || !dealKey) return list;
      var out = [];
      for (var i = 0; i < list.length; i++) {
        var m = list[i];
        if (m.is_encrypted && m.ciphertext) {
          try {
            var plain = await ChatCrypto.decrypt(m.ciphertext, dealKey);
            m.decrypted = plain;
          } catch (e) {
            m.decrypted = '🔒 Unable to decrypt';
          }
        } else if (!m.is_encrypted && m.content) {
          m.decrypted = m.content;
        } else if (m.ciphertext && !m.is_encrypted) {
          // Fallback: try decrypt even if flag missing
          try { m.decrypted = await ChatCrypto.decrypt(m.ciphertext, dealKey); } catch (e) { m.decrypted = m.ciphertext; }
        }
        out.push(m);
      }
      return out;
    }

    function renderMessages(list) {
      var nearBottom = scroller.scrollTop + scroller.clientHeight >= scroller.scrollHeight - 60;
      scroller.innerHTML = '';
      if (!list.length) {
        scroller.appendChild(emptyState('💬', 'No messages yet', 'Coordinate the trade details here. Be clear to avoid disputes. Messages are end-to-end encrypted.'));
        return;
      }
      list.forEach(function (msg) { scroller.appendChild(bubble(msg)); });
      if (nearBottom) scroller.scrollTop = scroller.scrollHeight;
    }

    function updateStatus() {
      if (keyError) {
        statusBar.textContent = '⛔ ' + keyError;
        statusBar.style.color = '#ff6b6b';
        input.setAttribute('disabled', '');
        sendBtn.setAttribute('disabled', '');
      } else if (!keyReady) {
        statusBar.textContent = '🔒 Establishing encrypted channel…';
        statusBar.style.color = '';
        input.setAttribute('disabled', '');
        sendBtn.setAttribute('disabled', '');
      } else {
        statusBar.textContent = '🔒 End-to-end encrypted · only you and the counterparty can read';
        statusBar.style.color = '#7dd3a5';
        input.removeAttribute('disabled');
        sendBtn.removeAttribute('disabled');
      }
    }

    async function load() {
      try {
        var raw = await Api.chat(id);
        var decrypted = await decryptList(raw);
        renderMessages(decrypted);
        consecutiveFails = 0;
      } catch (err) {
        consecutiveFails++;
        var msg = err && err.message ? String(err.message) : String(err);
        if (err && err.status === 403) {
          scroller.innerHTML = '';
          scroller.appendChild(UI.h('div', { class: 'banner error' }, [
            UI.h('div', {}, [
              UI.h('div', { style: 'font-weight:700', text: 'Chat locked' }),
              UI.h('div', { class: 'small', text: 'Only the buyer and seller of this deal can read or send messages. Join the deal first.' })
            ]),
            UI.h('button', { class: 'link-btn', onclick: function () { go('#/deal/' + id); }, text: 'View deal' })
          ]));
          statusBar.textContent = '⛔ Not a party to this deal';
        } else if (err && err.status === 401) {
          scroller.innerHTML = '';
          scroller.appendChild(UI.h('div', { class: 'banner warn' }, [
            UI.h('div', { class: 'small', text: 'Open this Mini App inside Telegram to use the encrypted chat.' })
          ]));
          statusBar.textContent = '⛔ Open in Telegram';
        } else {
          // Transient: keep existing messages, show toast after 2 fails
          if (consecutiveFails >= 2) UI.toast(msg || 'Could not load chat', 'err');
        }
        // Exponential backoff for polling on repeated failures
        if (consecutiveFails >= 3 && App.chatTimer) {
          clearInterval(App.chatTimer);
          var backoff = Math.min(4000 * Math.pow(1.8, consecutiveFails - 3), 30000);
          App.chatTimer = setInterval(load, backoff);
        }
      }
    }

    async function initKey() {
      try {
        if (!window.ChatCrypto || !ChatCrypto.isAvailable()) {
          // Fallback: still try but warn — backend will also encrypt at rest
          console.warn('[Chat] WebCrypto unavailable, using server-side encryption only');
        }
        var k = await Api.dealKey(id);
        if (!k) throw new Error('No chat key — join the deal first');
        dealKey = k;
        keyReady = true;
        keyError = null;
        updateStatus();
        await load();
      } catch (err) {
        var m = err && err.message ? err.message : String(err);
        if (err && err.status === 403) {
          keyError = 'Not a party to this deal — join first';
        } else if (err && err.status === 401) {
          keyError = 'Open in Telegram to enable encrypted chat';
        } else {
          keyError = m || 'Could not establish encrypted channel';
        }
        updateStatus();
        // Still try to load to show proper banner from load()
        try { await load(); } catch (e) {}
        console.warn('[Chat] key init failed', err);
      }
    }

    async function send() {
      var text = input.value.trim();
      if (!text) return;
      if (!keyReady || !dealKey) {
        UI.toast(keyError || 'Encrypted channel not ready', 'err');
        return;
      }
      if (!TG.realUser()) {
        UI.toast('Open in Telegram to chat securely', 'err');
        return;
      }
      if (text.length > 4000) { UI.toast('Message too long (max 4000)', 'err'); return; }
      input.value = '';
      sendBtn.setAttribute('disabled', '');
      TG.haptic.light();
      try {
        var ciphertext = await ChatCrypto.encrypt(text, dealKey);
        await Api.sendChatEncrypted(id, App.state.meId, ciphertext);
        await load();
        scroller.scrollTop = scroller.scrollHeight;
      } catch (err) {
        var em = err && err.message ? err.message : 'Could not send';
        UI.toast(em, 'err');
        input.value = text;
        // If encryption failed due to key, try refresh key once
        if (String(em).indexOf('key') !== -1) {
          try { dealKey = await Api.dealKey(id); keyReady = !!dealKey; updateStatus(); } catch (e) {}
        }
      } finally {
        sendBtn.removeAttribute('disabled');
        updateStatus();
      }
    }

    // Boot
    updateStatus();
    initKey();
    App.chatTimer = setInterval(load, 3500);
    App.cleanupFns.push(function () { if (App.chatTimer) clearInterval(App.chatTimer); });
    App.cleanupFns.push(function () { if (window.ChatCrypto) ChatCrypto.clearCache(id); });
  }

  /* ================= Join deal ================= */

  function viewJoin(id, token) {
    setTabbar(true);
    setTopbar('Join Deal #' + id, { back: function () { go('#/home'); } });
    TG.showBack(function () { go('#/home'); });

    var box = UI.h('div', {});
    document.getElementById('view').innerHTML = '';
    document.getElementById('view').appendChild(box);
    box.appendChild(UI.h('div', {}, UI.skeletonDeals(1)));

    Api.deal(id).then(function (deal) {
      box.innerHTML = '';
      if (!deal) {
        box.appendChild(emptyState('😕', 'Deal not found', 'The invite may be invalid or expired.', 'Go Home', '#/home'));
        return;
      }
      var am = UI.assetMeta(deal.asset);
      var content = UI.h('div', {}, [
        UI.h('h3', { text: 'Join escrow deal #' + deal.id }),
        UI.h('p', { class: 'sub', text: 'Amount ' + UI.fmtAmount(deal.amount) + ' ' + am.symbol + ' · Status: ' + UI.statusMeta(deal.status).label }),
        UI.h('div', { class: 'card review-rows', style: 'padding:6px 14px;margin-bottom:16px' }, [
          UI.h('div', { class: 'rrow' }, [UI.h('span', { class: 'k', text: 'Buyer' }), UI.h('span', { class: 'v', text: deal.buyer_telegram_id || '—' })]),
          UI.h('div', { class: 'rrow' }, [UI.h('span', { class: 'k', text: 'Seller' }), UI.h('span', { class: 'v', text: deal.seller_telegram_id || '—' })])
        ]),
        UI.h('button', {
          class: 'btn btn-primary',
          onclick: doJoin
        }, ['Join this deal'])
      ]);

      UI.sheetOpen(content, {});

      function doJoin() {
        TG.haptic.medium();
        Api.joinDeal(id, token)
          .then(function () {
            TG.haptic.success();
            UI.toast('Joined deal #' + id, 'ok');
            UI.sheetClose();
            go('#/deal/' + id);
          })
          .catch(function (err) {
            TG.haptic.error();
            UI.toast(err.message || 'Could not join', 'err');
          });
      }
    }).catch(function () {
      box.innerHTML = '';
      box.appendChild(emptyState('📡', 'Could not load deal', 'Check your connection and try again.', 'Go Home', '#/home'));
    });
  }

  /* ================= Profile ================= */

  function applyThemeMode(mode) {
    try {
      if (mode && mode !== 'auto') document.body.setAttribute('data-theme-mode', mode);
      else document.body.removeAttribute('data-theme-mode');
      localStorage.setItem('tonescrow:theme', mode);
    } catch (e) { /* ignore */ }
  }

  function getThemeMode() {
    try { return localStorage.getItem('tonescrow:theme') || 'auto'; } catch (e) { return 'auto'; }
  }

  function viewProfile() {
    setTabbar(true);
    setTopbar('Account', { back: function () { navBack('#/home'); } });
    TG.showBack(function () { navBack('#/home'); });

    var u = App.state.user || {};
    var initial = ((u.first_name || u.username || '?').trim()[0] || '?').toUpperCase();

    var isAdmin = App.state.admins.indexOf(App.state.meId) !== -1 ||
                  App.state.admins.map(Number).indexOf(App.state.meId) !== -1;

    var connValue = UI.h('span', { class: 'li-value', text: App.state.apiOk === null ? 'Checking…' : (App.state.apiOk ? 'Connected' : 'Offline') });
    var connDot = UI.h('span', { class: 'dot ' + (App.state.apiOk ? 'on' : 'off') });

    var themeSeg = UI.h('div', { class: 'theme-seg' });
    [['auto', 'Auto'], ['light', 'Light'], ['dark', 'Dark']].forEach(function (pair) {
      themeSeg.appendChild(UI.h('button', {
        class: getThemeMode() === pair[0] ? 'active' : '',
        onclick: function () {
          TG.haptic.tap();
          applyThemeMode(pair[0]);
          Array.prototype.forEach.call(themeSeg.children, function (b) { b.classList.remove('active'); });
          this.classList.add('active');
        }
      }, [pair[1]]));
    });

    var root = UI.h('div', {}, [
      UI.h('div', { class: 'card profile-card' }, [
        u.photo_url
          ? UI.h('img', { class: 'avatar ' + UI.avatarClass(u.id), src: u.photo_url, alt: '' })
          : UI.h('div', { class: 'avatar ' + UI.avatarClass(u.id), text: initial }),
        UI.h('h2', { text: u.first_name ? u.first_name + (u.last_name ? ' ' + u.last_name : '') : 'Guest' }),
        UI.h('div', { class: 'pid', text: (u.username ? '@' + u.username + ' · ' : '') + 'ID ' + (u.id || '—') })
      ]),
      UI.h('div', { class: 'section-title', text: 'Preferences' }),
      UI.h('div', { class: 'card', style: 'padding:8px 14px 14px' }, [
        UI.h('div', { class: 'list-item', style: 'border-bottom:0;padding-bottom:4px' }, [
          UI.h('div', { class: 'li-icon', text: '🎨' }),
          UI.h('div', { class: 'li-main' }, [
            UI.h('b', { text: 'Appearance' }),
            UI.h('span', { text: 'Match the Telegram theme automatically' })
          ])
        ]),
        themeSeg
      ]),
      UI.h('div', { class: 'section-title', text: 'Service' }),
      UI.h('div', { class: 'card', style: 'padding:4px 14px' }, [
        (function () {
          var walletValueEl = UI.h('span', { class: 'li-value', text: Wallet.connected() ? UI.shortAddr((Wallet.addressFriendly ? Wallet.addressFriendly() : UI.toFriendly(Wallet.address())) || '') : 'Connect' });
          var walletSubEl = UI.h('span', { text: 'Tonkeeper · MyTonWallet · @wallet' });
          function updateWalletRow(acc) {
            var isConn = Wallet.connected();
            var addr = Wallet.address();
            if (acc && acc.address) { isConn = true; addr = acc.address; }
            if (isConn && addr) {
              var friendly = Wallet.addressFriendly ? Wallet.addressFriendly() : UI.toFriendly(addr);
              walletValueEl.textContent = UI.shortAddr(friendly);
              // Fetch balance async
              Wallet.getBalance().then(function (r) {
                var ton = r.balanceTon || (Number(r.balance) / 1e9).toString();
                walletSubEl.textContent = Number(ton).toFixed(4).replace(/\.?0+$/, '') + ' TON';
              }).catch(function () {
                walletSubEl.textContent = 'Connected';
              });
            } else {
              walletValueEl.textContent = 'Connect';
              walletSubEl.textContent = 'Tonkeeper · MyTonWallet · @wallet';
            }
          }
          Wallet.whenReady().then(function () { updateWalletRow(); }).catch(function () {});
          Wallet.onStatus(function (acc) { updateWalletRow(acc); });
          // Initial
          updateWalletRow();
          return UI.h('button', {
            class: 'list-item',
            onclick: function () {
              TG.haptic.tap();
              if (Wallet.connected()) { walletSheet(); return; }
              if (!Wallet.available()) { UI.toast('Wallet SDK still loading…'); return; }
              Wallet.connect().catch(function (err) {
                console.warn('[App] wallet connect failed', err);
                UI.toast(err && err.message ? err.message : 'Wallet connection cancelled', 'err');
              });
            }
          }, [
            UI.h('div', { class: 'li-icon', text: '👛' }),
            UI.h('div', { class: 'li-main' }, [
              UI.h('b', { text: 'Wallet' }),
              walletSubEl
            ]),
            walletValueEl
          ]);
        })(),
        UI.h('button', {
          class: 'list-item',
          onclick: function () {
            TG.haptic.tap();
            connValue.textContent = 'Checking…';
            Api.info()
              .then(function (d) {
                App.state.admins = d.adminTelegramIds;
                App.state.apiOk = true;
                connDot.className = 'dot on';
                connValue.textContent = 'Connected';
                UI.toast('Server reachable', 'ok');
              })
              .catch(function () {
                App.state.apiOk = false;
                connDot.className = 'dot off';
                connValue.textContent = 'Offline';
                UI.toast('Server unreachable', 'err');
              });
          }
        }, [
          UI.h('div', { class: 'li-icon', text: '📡' }),
          UI.h('div', { class: 'li-main' }, [
            UI.h('b', { text: 'API connection' }),
            UI.h('span', { text: 'Tap to test connectivity' })
          ]),
          UI.h('span', {}, [connDot, connValue])
        ]),
        isAdmin ? UI.h('button', {
          class: 'list-item',
          onclick: function () { go('#/admin'); }
        }, [
          UI.h('div', { class: 'li-icon', text: '🛠️' }),
          UI.h('div', { class: 'li-main' }, [
            UI.h('b', { text: 'Admin tools' }),
            UI.h('span', { text: 'Broadcast notifications & logs' })
          ]),
          UI.h('span', { class: 'li-value', text: '›' })
        ]) : null,
        UI.h('button', {
          class: 'list-item',
          onclick: function () { TG.alert('TonEscrow v2.0 — Telegram Mini App for P2P escrow deals on TON.'); }
        }, [
          UI.h('div', { class: 'li-icon', text: 'ℹ️' }),
          UI.h('div', { class: 'li-main' }, [
            UI.h('b', { text: 'About' }),
            UI.h('span', { text: 'Version 2.0.0' })
          ]),
          UI.h('span', { class: 'li-value', text: '›' })
        ])
      ].filter(Boolean))
    ]);

    document.getElementById('view').innerHTML = '';
    document.getElementById('view').appendChild(root);
  }

  /* ================= Admin ================= */

  function viewAdmin() {
    setTabbar(false);
    setTopbar('Admin Tools', { back: function () { go('#/profile'); } });
    TG.showBack(function () { go('#/profile'); });

    var sel = UI.h('select', { class: 'input' }, (function () {
      var opts = [UI.h('option', { value: '', text: 'Select recipient…' })];
      App.state.admins.forEach(function (a) {
        opts.push(UI.h('option', { value: String(a), text: 'Admin · ' + a }));
      });
      opts.push(UI.h('option', { value: 'custom', text: 'Custom chat ID…' }));
      return opts;
    })());
    var customWrap = UI.h('div', { class: 'field hidden' }, [
      UI.h('label', { text: 'Chat ID' }),
      UI.h('input', { class: 'input', inputmode: 'numeric', placeholder: 'e.g. 111111111' })
    ]);
    var msgTa = UI.h('textarea', { class: 'input', maxlength: '500', placeholder: 'Message to send via the bot…' });
    var histBox = UI.h('div', {});

    sel.addEventListener('change', function () {
      customWrap.classList.toggle('hidden', sel.value !== 'custom');
    });

    function loadHistory() {
      histBox.innerHTML = '';
      histBox.appendChild(UI.h('div', { class: 'sk', style: 'height:64px;margin-bottom:8px' }));
      Api.notifications()
        .then(function (items) {
          histBox.innerHTML = '';
          if (!items.length) {
            histBox.appendChild(UI.h('p', { class: 'muted small', style: 'text-align:center;padding:14px', text: 'No notifications sent yet.' }));
            return;
          }
          items.slice(0, 30).forEach(function (n) {
            histBox.appendChild(UI.h('div', { class: 'notif-item' }, [
              UI.h('p', { text: n.message }),
              UI.h('div', { class: 'n-meta', text: '→ chat ' + n.chat_id + ' · ' + UI.timeAgo(n.created_at) })
            ]));
          });
        })
        .catch(function () {
          histBox.innerHTML = '';
          histBox.appendChild(UI.h('p', { class: 'muted small', style: 'text-align:center;padding:14px', text: 'Could not load notifications.' }));
        });
    }

    var root = UI.h('div', {}, [
      UI.h('div', { class: 'banner warn' }, [
        UI.h('div', { class: 'small', text: '⚠️ Admin area — messages are delivered through the bot to any chat ID.' })
      ]),
      UI.h('div', { class: 'section-title', text: 'Send notification' }),
      UI.h('div', { class: 'card' }, [
        UI.h('div', { class: 'field' }, [UI.h('label', { text: 'Recipient' }), sel, customWrap]),
        UI.h('div', { class: 'field' }, [UI.h('label', { text: 'Message' }), msgTa]),
        UI.h('button', {
          class: 'btn btn-primary',
          onclick: function () {
            var chatId = sel.value === 'custom' ? customWrap.querySelector('input').value.trim() : sel.value;
            var text = msgTa.value.trim();
            if (!chatId || !text) { UI.toast('Recipient and message required', 'err'); return; }
            TG.haptic.medium();
            Api.notify(chatId, text)
              .then(function () {
                TG.haptic.success();
                UI.toast('Notification sent', 'ok');
                msgTa.value = '';
                loadHistory();
              })
              .catch(function (err) {
                TG.haptic.error();
                UI.toast(err.status === 401 ? 'Unauthorized — set API access' : (err.message || 'Failed'), 'err');
              });
          }
        }, ['Send via bot'])
      ]),
      UI.h('div', { class: 'between', style: 'margin-top:16px' }, [
        UI.h('div', { class: 'section-title', style: 'margin:0', text: 'Recent notifications' }),
        UI.h('button', { class: 'link-btn', onclick: loadHistory, text: 'Refresh' })
      ]),
      histBox
    ]);

    document.getElementById('view').innerHTML = '';
    document.getElementById('view').appendChild(root);
    loadHistory();
  }

  /* ================= Boot ================= */

  function boot() {
    window.addEventListener('error', function (e) {
      try { UI.toast('Error: ' + (e.message || 'unknown'), 'err'); } catch (x) { /* ignore */ }
    });
    console.log('[TonEscrow] build v3 — ' + new Date().toISOString());

    TG.init();
    // Prefer real Telegram user when inside Telegram; preview fallback only for browsing
    var real = TG.realUser();
    var u = real || TG.user();
    App.state.user = u;
    App.state.meId = Number(u && u.id) || 0;
    // Re-sync meId if Telegram injects user after boot (some clients delay)
    setTimeout(function () {
      var r2 = TG.realUser();
      if (r2 && Number(r2.id) !== App.state.meId) {
        App.state.user = r2;
        App.state.meId = Number(r2.id);
      }
    }, 800);
    applyThemeMode(getThemeMode());
    bindChrome();

    var sp = TG.startParam();
    if (/^\d+\.[A-Za-z0-9_\-]+$/.test(sp)) {
      location.hash = '#/deal/' + sp.split('.')[0] + '/join/' + sp.split('.')[1];
    }

    Api.info()
      .then(function (d) {
        App.state.admins = d.adminTelegramIds || [];
        App.state.apiOk = true;
      })
      .catch(function () { App.state.apiOk = false; })
      .then(function () {
        if (!location.hash) location.hash = '#/home';
        router();
      });

    window.addEventListener('hashchange', router);
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
  else boot();
})();
