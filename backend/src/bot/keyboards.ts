import { InlineKeyboard } from 'grammy';
// Re-exported here for reuse in newdeal post-create card — no circular deps

/** Inline keyboard containing a single Telegram WebApp button. */
export function webAppButton(url: string, label = 'Open Escrow') {
  return new InlineKeyboard().webApp(label, url);
}

/** Deal card keyboard: quick status callback plus optional WebApp deep link. */
export function dealCardKeyboard(dealId: number, webappUrl?: string) {
  const kb = new InlineKeyboard().text(`🔄 Refresh Deal #${dealId}`, `deal_status:${dealId}`);
  if (webappUrl) {
    const sep = webappUrl.includes('?') ? '&' : '?';
    kb.row().webApp('🚀 Open in App', `${webappUrl}${sep}deal=${dealId}`);
  }
  kb.row().text('🏠 Main Menu', 'menu:home');
  return kb;
}

// ─────────────────────────────────────────────────────────────────────────────
// Main menu & navigation keyboards — polished, branded, consistent
// ─────────────────────────────────────────────────────────────────────────────

/** Primary welcome / main menu keyboard. 2-col grid + optional WebApp CTA. */
export function mainMenuKeyboard(webappUrl?: string) {
  const kb = new InlineKeyboard()
    .text('➕ Create Deal', 'menu:create')
    .text('📋 My Deals', 'menu:deals')
    .row()
    .text('ℹ️ How it Works', 'menu:how')
    .text('📖 Commands', 'menu:help')
    .row()
    .text('🛟 Support', 'menu:support')
    .text('✨ About', 'menu:about');

  if (webappUrl) {
    kb.row().webApp('🚀 Open Escrow App', webappUrl);
  } else {
    kb.row().text('🚀 Open Escrow App', 'menu:how');
  }
  return kb;
}

/** Sub-page keyboard with Back + optional WebApp. */
export function backToMenuKeyboard(webappUrl?: string, extra?: { label: string; data: string }[]) {
  const kb = new InlineKeyboard();
  if (extra) {
    for (const b of extra) kb.text(b.label, b.data).row();
  }
  if (webappUrl) kb.webApp('🚀 Open App', webappUrl).row();
  kb.text('⬅️ Back to Menu', 'menu:home').text('🏠 Main', 'menu:home');
  return kb;
}

/** Keyboard shown on the "Create Deal" help screen. */
export function createDealKeyboard(webappUrl?: string) {
  const kb = new InlineKeyboard()
    .text('💎 Create TON Deal', 'menu:create_ton')
    .text('💵 Create USDT Deal', 'menu:create_usdt')
    .row()
    .text('📋 My Deals', 'menu:deals')
    .text('ℹ️ How it Works', 'menu:how');

  if (webappUrl) kb.row().webApp('🚀 Open App to Create', webappUrl);
  kb.row().text('⬅️ Back', 'menu:home');
  return kb;
}

/** Small helper — row of quick action buttons after /newdeal. */
export function postCreateKeyboard(dealId: number, webappUrl?: string) {
  const kb = new InlineKeyboard()
    .text('📊 Check Status', `deal_status:${dealId}`)
    .text('📋 My Deals', 'menu:deals');
  if (webappUrl) {
    const sep = webappUrl.includes('?') ? '&' : '?';
    kb.row().webApp('🚀 Open in App', `${webappUrl}${sep}deal=${dealId}`);
  }
  kb.row().text('🏠 Menu', 'menu:home');
  return kb;
}

/** Help screen keyboard. */
export function helpKeyboard(webappUrl?: string) {
  const kb = new InlineKeyboard()
    .text('➕ How to Create', 'menu:create')
    .text('ℹ️ How it Works', 'menu:how')
    .row()
    .text('📋 My Deals', 'menu:deals')
    .text('🛟 Support', 'menu:support');
  if (webappUrl) kb.row().webApp('🚀 Open App', webappUrl);
  kb.row().text('⬅️ Back to Menu', 'menu:home');
  return kb;
}
