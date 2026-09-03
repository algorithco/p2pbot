import { Bot } from 'grammy';
import { createUserIfNotExists } from '../../db/queries';
import { buyerApproveReceipt } from '../../services/escrowService';

export function registerConfirm(bot: Bot) {
  // Webapp-first: /confirm now redirects to web app. Fallback execution kept only for edge where webapp unreachable.
  bot.command('confirm', async (ctx) => {
    const raw = (ctx.match || '').trim();
    const dealId = Number(raw);
    const webappUrl = (await import('../../config')).config.webappUrl || (await import('../../config')).config.frontendUrl;
    if (!raw || !Number.isInteger(dealId) || dealId <= 0) {
      const { InlineKeyboard } = await import('grammy');
      const kb = new InlineKeyboard();
      if (webappUrl) kb.webApp('📲 Open Web App', webappUrl);
      return ctx.reply(
        [
          `📲 <b>Confirm in Web App</b> (bot is notifications only)`,
          `Open Deal → <b>✅ Yes, received</b> after seller marks ITEM_SENT.`,
          dealId ? `Deal #${dealId}` : '',
          webappUrl ? `🔗 ${webappUrl}/#/deal/${dealId || ''}` : '',
          ``,
          `If you still need bot fallback, send <code>/confirm &lt;deal_id&gt;</code> with valid id — bot will attempt but webapp is preferred.`,
        ].filter(Boolean).join('\n'),
        { parse_mode: 'HTML', reply_markup: kb as any }
      );
    }
    // Show redirect first
    if (webappUrl) {
      const { InlineKeyboard } = await import('grammy');
      const kb = new InlineKeyboard().webApp('📲 Open Web App — Confirm', `${String(webappUrl).replace(/\/$/, '')}/#/deal/${dealId}`);
      await ctx.reply(
        `📲 <b>Deal #${dealId}</b> — please confirm in the <b>Web App</b>: Deal → ✅ Yes, received — Release\n` +
          `Tap below to open.\n\n<i>Bot fallback will still attempt once after this notice.</i>`,
        { parse_mode: 'HTML', reply_markup: kb }
      );
    }
    await createUserIfNotExists(ctx.from!.id, ctx.from!.username);
    const result: any = await buyerApproveReceipt(ctx.from!.id, dealId);
    if (!result.success && result.needSellerAddress) {
      await ctx.reply(
        `⏳ <b>Deal #${dealId}</b> — you confirmed receipt, but seller has not set TON payout address yet.\nSeller was notified to set it in the web app (Deal → Set payout address). Funds will transfer once set.`,
        { parse_mode: 'HTML' }
      );
      return;
    }
    if ((result as any).needItemSent) {
      await ctx.reply(`⏳ <b>Deal #${dealId}</b> — seller must mark item as sent first in web app (Deal → 📦 I sent the item).`, { parse_mode: 'HTML' });
      return;
    }
    const hint = result.success ? '\n\n<i>Next time use web app for instant release.</i>' : '';
    await ctx.reply(result.message + hint, { parse_mode: 'HTML' });
  });
}
