import { Bot } from 'grammy';
import * as db from '../../db/queries';
import * as accountService from '../../services/accountService';
import * as tradeService from '../../services/tradeService';
import logger from '../../logger';
import { decryptSession } from '../../services/sessionCrypto';

// Tracks buyer code input: tradeId -> awaiting code state
const awaitingCode = new Map<number, { buyerId: number; phone: string; phoneCodeHash?: string }>();

export function setAwaitingCode(tradeId: number, buyerId: number, phone: string, phoneCodeHash?: string) {
  awaitingCode.set(tradeId, { buyerId, phone, phoneCodeHash });
}

export function registerCodeHandler(bot: Bot) {
  // Buyer sends code as plain 5-6 digit number
  bot.on('message:text', async (ctx, next) => {
    const text = ctx.message.text.trim();
    const from = ctx.from?.id;
    if (!from) return next();

    // Check if this user is awaiting code for any trade
    // Find active trade where user is buyer and status is AWAITING_CODE
    const active = (await db.getActiveTradeForUser(from)) as unknown as { id: number; status: string; phone?: string; buyer_telegram_id?: number; session_encrypted: string } | null;
    if (!active) return next();
    if (!['AWAITING_CODE', 'PHONE_SHARED', 'AWAITING_BUYER_LOGIN'].includes(String(active.status))) return next();

    // Heuristic: buyer code is 5-6 digits, maybe with spaces
    const codeCandidate = text.replace(/\s+/g, '');
    if (!/^\d{5,6}$/.test(codeCandidate)) return next();

    const tradeId = Number(active.id);
    const phone = String(active.phone || '');
    if (!phone) {
      await ctx.reply('Phone not set for this trade — ask seller to run /setphone');
      return;
    }

    await ctx.reply(`🔐 Verifying code ${codeCandidate} for ${phone.slice(0, 4)}**** …`);

    // Attempt buyer login via GramJS with provided code
    let result: { success: boolean; session?: string; error?: string };
    try {
      // Try to get stored phoneCodeHash if available
      const stored = awaitingCode.get(tradeId);
      result = await accountService.attemptBuyerLogin({
        phone,
        phoneCode: codeCandidate,
        phoneCodeHash: stored?.phoneCodeHash,
      });
    } catch (e) {
      result = { success: false, error: String((e as Error).message || e) };
    }

    if (!result.success) {
      if (result.error === 'invalid_code') {
        await ctx.reply('❌ Invalid or expired code. Please resend a fresh code (request new code from Telegram and send it here).');
      } else if (result.error === '2fa_required') {
        await ctx.reply('This account has 2FA enabled. Please send the 2FA password as next message (format: `2fa:yourpassword`).');
        // Store that next message should be 2FA
        // We handle via separate handler below
        awaitingCode.set(tradeId, { buyerId: from, phone, phoneCodeHash: undefined });
        // Also store code for retry with password
        (awaitingCode as unknown as Map<number, { pendingCode: string }>).set(tradeId, { buyerId: from, phone, pendingCode: codeCandidate } as unknown as never);
      } else {
        await ctx.reply(`❌ Login failed: ${result.error}`);
        await tradeService.failTrade(tradeId, result.error || 'buyer_login_failed', from);
      }
      return;
    }

    // Success: buyer session captured — now logout utradebot's held session (seller session)
    await ctx.reply('✅ Code verified! Logging out tradebot session…');

    try {
      await accountService.logoutSession(String((active as unknown as { session_encrypted: string }).session_encrypted));
    } catch (e) {
      logger.warn('logoutSession after buyer login failed', e);
    }

    // Mark completed, but retain encrypted session (now invalid) for audit
    await tradeService.completeTrade(tradeId, from);

    // Optionally send buyer the new session (encrypted) if they want to use userbot later
    // We send it as one-time with burn warning
    if (result.session) {
      try {
        await ctx.api.sendMessage(from, `Buyer session (keep secret, valid for API): \`${result.session.slice(0, 60)}****\`` , { parse_mode: 'Markdown' });
      } catch {}
    }

    await ctx.reply(`🎉 Trade #${tradeId} completed! You now own the account. The tradebot has logged out.`);
    // Notify seller
    const sellerId = Number((active as unknown as { seller_telegram_id: number }).seller_telegram_id);
    try {
      await ctx.api.sendMessage(sellerId, `✅ Buyer has logged into your traded account for trade #${tradeId}. Your session was logged out. Trade completed.`);
    } catch {}

    awaitingCode.delete(tradeId);
  });

  // 2FA password handler: 2fa:password
  bot.on('message:text', async (ctx, next) => {
    const text = ctx.message.text.trim();
    if (!text.startsWith('2fa:')) return next();
    const from = ctx.from?.id;
    if (!from) return next();
    const active = (await db.getActiveTradeForUser(from)) as unknown as { id: number; status: string; phone?: string } | null;
    if (!active) return;
    const phone = String(active.phone || '');
    const pending = awaitingCode.get(Number(active.id)) as unknown as { pendingCode?: string };
    if (!pending?.pendingCode) {
      await ctx.reply('No pending code found — please send code first.');
      return;
    }
    const password = text.slice(4).trim();
    await ctx.reply('🔐 Verifying code + 2FA…');
    const result = await accountService.attemptBuyerLogin({
      phone,
      phoneCode: pending.pendingCode,
      password,
    });
    if (!result.success) {
      await ctx.reply(`❌ Login failed: ${result.error}`);
      return;
    }
    const tradeId = Number(active.id);
    try {
      await accountService.logoutSession(String((active as unknown as { session_encrypted: string }).session_encrypted));
    } catch {}
    await tradeService.completeTrade(tradeId, from);
    await ctx.reply(`🎉 Trade #${tradeId} completed with 2FA! Tradebot logged out.`);
    awaitingCode.delete(tradeId);
  });
}
