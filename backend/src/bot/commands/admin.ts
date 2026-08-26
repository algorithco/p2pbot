import { Bot } from 'grammy';
import { config } from '../../config';
import { adminRelease, adminRefund, adminSetFiatSent } from '../../services/escrowService';

export function registerAdminCommands(bot: Bot) {
  bot.command('admin_release', async (ctx) => {
    if (!ctx.session.isAdmin) return ctx.reply('Unauthorized');
    const dealId = ctx.match;
    if (!dealId) return ctx.reply('Usage: /admin_release <deal_id>');
    const result = await adminRelease(ctx.from!.id, dealId);
    await ctx.reply(result.message);
  });

  bot.command('admin_refund', async (ctx) => {
    if (!ctx.session.isAdmin) return ctx.reply('Unauthorized');
    const dealId = ctx.match;
    if (!dealId) return ctx.reply('Usage: /admin_refund <deal_id>');
    const result = await adminRefund(ctx.from!.id, dealId);
    await ctx.reply(result.message);
  });

  bot.command('admin_set_fiat_sent', async (ctx) => {
    if (!ctx.session.isAdmin) return ctx.reply('Unauthorized');
    const dealId = ctx.match;
    if (!dealId) return ctx.reply('Usage: /admin_set_fiat_sent <deal_id>');
    const result = await adminSetFiatSent(ctx.from!.id, dealId);
    await ctx.reply(result.message);
  });
}