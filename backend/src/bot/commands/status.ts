import { Bot } from 'grammy';
import { config } from '../../config';
import { getDealById } from '../../services/dealService';

function fmtDate(v: unknown): string {
  if (!v) return '—';
  try {
    return new Date(v as string).toISOString().replace('T', ' ').slice(0, 16) + ' UTC';
  } catch {
    return String(v);
  }
}

export function registerStatus(bot: Bot) {
  bot.command('status', async (ctx) => {
    const raw = (ctx.match || '').trim();
    const dealId = Number(raw);
    if (!raw || !Number.isInteger(dealId)) return ctx.reply('Usage: /status <deal_id>');

    const deal = await getDealById(dealId);
    if (!deal) return ctx.reply('Deal not found');

    // Privacy: only buyer, seller, or admin may view deal status
    const callerId = ctx.from?.id;
    const isAdmin = callerId != null && config.adminTelegramIds.map(Number).includes(Number(callerId));
    const isParty =
      callerId != null &&
      ((deal.buyer_telegram_id != null && Number(deal.buyer_telegram_id) === callerId) ||
        (deal.seller_telegram_id != null && Number(deal.seller_telegram_id) === callerId));
    if (!isParty && !isAdmin) {
      return ctx.reply('🔒 This deal is private — only its buyer and seller can view it.');
    }

    const conf: Record<string, boolean> = deal.confirmations || {};
    const timeline = [
      `Created:   ${fmtDate(deal.created_at)}`,
      `Deposit:   ${deal.status === 'AWAITING_DEPOSIT' ? 'waiting' : 'confirmed'}${deal.tx_hash ? `\n           tx: ${String(deal.tx_hash).slice(0, 24)}…` : ''}`,
      `Buyer ✓:   ${conf.buyer ? 'yes' : 'no'}`,
      `Seller ✓:  ${conf.seller ? 'yes' : 'no'}`,
      `Resolved:  ${fmtDate(deal.resolved_at)}`,
      `Deadline:  ${fmtDate(deal.deadline)}`,
    ].join('\n');

    await ctx.reply(
      [
        `Deal #${deal.id}`,
        `Status: ${deal.status}`,
        `Amount: ${deal.amount} ${deal.asset} (fee ${deal.fee_bps ?? 0} bps)`,
        deal.contract_address ? `Contract: ${deal.contract_address}` : 'Mode: off-chain',
        '',
        'Timeline:',
        timeline,
      ].join('\n')
    );
  });
}
