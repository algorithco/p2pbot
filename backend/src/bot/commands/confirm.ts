import { Bot } from 'grammy';
import { createUserIfNotExists } from '../../db/queries';
import { buyerApproveReceipt } from '../../services/escrowService';

export function registerConfirm(bot: Bot) {
  bot.command('confirm', async (ctx) => {
    const raw = (ctx.match || '').trim();
    const dealId = Number(raw);
    if (!raw || !Number.isInteger(dealId) || dealId <= 0) {
      return ctx.reply('Usage: /confirm <deal_id> — buyer confirms receipt (web app preferred)');
    }

    // Make sure the caller exists as a user before recording anything.
    await createUserIfNotExists(ctx.from!.id, ctx.from!.username);

    const result = await buyerApproveReceipt(ctx.from!.id, dealId);
    await ctx.reply(result.message);
  });
}
