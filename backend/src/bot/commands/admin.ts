import { Bot } from 'grammy';
import { db } from '../../db/queries';
import { adminRelease, adminRefund } from '../../services/escrowService';
import { adminKeyboard } from '../keyboards';

function isAdminCtx(ctx: any): boolean {
  return Boolean((ctx as any).session?.isAdmin);
}

export function registerAdminCommands(bot: Bot) {
  bot.command('admin_release', async (ctx) => {
    if (!isAdminCtx(ctx)) return ctx.reply(`❌ Ruxsat yo'q.\nBu buyruq faqat admin uchun.`);
    const dealId = (ctx.match || '').trim();
    if (!dealId) return ctx.reply(`Foydalanish: /admin_release <deal_id>\nMasalan: /admin_release 12`);
    const result = await adminRelease(ctx.from!.id, dealId);
    if (result.success) {
      await ctx.reply(`✅ Deal #${dealId} chiqarildi.\nPul sotuvchiga yuborildi.`);
    } else {
      await ctx.reply(`❌ Xatolik: ${result.message}\nQayta urinib ko'ring.`);
    }
  });

  bot.command('admin_refund', async (ctx) => {
    if (!isAdminCtx(ctx)) return ctx.reply(`❌ Ruxsat yo'q.\nBu buyruq faqat admin uchun.`);
    const dealId = (ctx.match || '').trim();
    if (!dealId) return ctx.reply(`Foydalanish: /admin_refund <deal_id>\nMasalan: /admin_refund 12`);
    const result = await adminRefund(ctx.from!.id, dealId);
    if (result.success) {
      await ctx.reply(`✅ Deal #${dealId} qaytarildi.\nPul xaridorga qaytdi.`);
    } else {
      await ctx.reply(`❌ Xatolik: ${result.message}\nQayta urinib ko'ring.`);
    }
  });

  bot.command('disputes', async (ctx) => {
    if (!isAdminCtx(ctx)) return ctx.reply(`❌ Ruxsat yo'q.\nBu buyruq faqat admin uchun.`);
    const res = await db.query(
      `SELECT * FROM deals WHERE confirmations->>'disputed' = 'true' AND status NOT IN ('RELEASED','REFUNDED') ORDER BY id DESC LIMIT 20`
    );
    if (res.rows.length === 0) return ctx.reply(`✅ Ochilgan nizolar yo'q.\nHammasi joyida.`);
    for (const d of res.rows) {
      await ctx.reply(
        `⚖️ Nizo #${d.id} — ${d.amount} ${d.asset}\nXaridor ${d.buyer_telegram_id} ↔ Sotuvchi ${d.seller_telegram_id}.\nQaror uchun tugmani bosing.`,
        { parse_mode: 'HTML', reply_markup: adminKeyboard(d.id) }
      );
    }
  });

  bot.callbackQuery(/^admin_do_release:(\d+)$/, async (ctx) => {
    if (!isAdminCtx(ctx)) return ctx.answerCallbackQuery({ text: "Ruxsat yo'q" });
    const r = await adminRelease(ctx.from!.id, ctx.match![1]);
    await ctx.answerCallbackQuery({ text: r.success ? 'Chiqarildi' : String(r.message).slice(0, 180) });
    await ctx.reply(r.success ? `✅ Deal #${ctx.match![1]} chiqarildi.` : `❌ Xatolik: ${r.message}`);
  });

  bot.callbackQuery(/^admin_do_refund:(\d+)$/, async (ctx) => {
    if (!isAdminCtx(ctx)) return ctx.answerCallbackQuery({ text: "Ruxsat yo'q" });
    const r = await adminRefund(ctx.from!.id, ctx.match![1]);
    await ctx.answerCallbackQuery({ text: r.success ? 'Qaytarildi' : String(r.message).slice(0, 180) });
    await ctx.reply(r.success ? `✅ Deal #${ctx.match![1]} qaytarildi.` : `❌ Xatolik: ${r.message}`);
  });
}
