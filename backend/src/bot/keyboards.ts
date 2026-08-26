import { InlineKeyboard } from 'grammy';

/** Inline keyboard containing a single Telegram WebApp button. */
export function webAppButton(url: string, label = 'Open Escrow') {
  return new InlineKeyboard().webApp(label, url);
}

/** Deal card keyboard: quick status callback plus optional WebApp deep link. */
export function dealCardKeyboard(dealId: number, webappUrl?: string) {
  const kb = new InlineKeyboard().text(`Deal #${dealId}: refresh`, `deal_status:${dealId}`);
  if (webappUrl) {
    const sep = webappUrl.includes('?') ? '&' : '?';
    kb.webApp('Open in App', `${webappUrl}${sep}deal=${dealId}`);
  }
  return kb;
}
