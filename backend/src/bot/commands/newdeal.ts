import { Bot } from 'grammy';
import { db, getUserByTelegramId, createUserIfNotExists } from '../../db/queries';
import { createDealRecord, generateDealLink, DEAL_STATUS } from '../../services/dealService';
import { deployEscrowContract } from '../../blockchain/contractDeployer';
import { addAddressToMonitor } from '../../blockchain/listener';
import { config } from '../../config';
import { postCreateKeyboard } from '../keyboards';
import { toBaseUnits, fromBaseUnits } from '../../utils/money';
import { depositComment, releaseComment } from '../../utils/comments';
import { Address } from '@ton/core';
import logger from '../../logger';

const USAGE_HTML =
  `📝 <b>Usage:</b> <code>/newdeal &lt;@seller|seller_id&gt; &lt;amount&gt; &lt;TON|USDT&gt; [terms]</code>\n` +
  `<i>Examples:</i>\n` +
  `  <code>/newdeal @alice 2.5 TON fast delivery</code>\n` +
  `  <code>/newdeal 123456789 50 USDT no refund after ship</code>`;

function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

export function registerNewDeal(bot: Bot) {
  bot.command('newdeal', async (ctx) => {
    const parts = (ctx.match || '').trim().split(/\s+/).filter(Boolean);
    if (parts.length < 3) {
      return ctx.reply(USAGE_HTML, { parse_mode: 'HTML' });
    }
    const sellerRef = parts[0];
    const amount = Number(parts[1]);
    const asset = parts[2].toUpperCase();
    const terms = parts.slice(3).join(' ').trim();

    if (!Number.isFinite(amount) || amount <= 0) {
      return ctx.reply('❌ <b>Invalid amount.</b> Use a positive number like <code>2.5</code>.', { parse_mode: 'HTML' });
    }
    if (asset !== 'TON' && asset !== 'USDT') {
      return ctx.reply('❌ <b>Asset must be TON or USDT.</b>\n' + USAGE_HTML, { parse_mode: 'HTML' });
    }

    let baseUnits: string;
    try {
      baseUnits = toBaseUnits(amount, asset);
    } catch {
      return ctx.reply('❌ Could not parse the amount. Use a plain decimal like <code>12.5</code>', { parse_mode: 'HTML' });
    }
    const humanAmount = fromBaseUnits(baseUnits, asset);

    // Upsert the buyer so the users table stays consistent.
    await createUserIfNotExists(ctx.from!.id, ctx.from!.username);

    // Resolve seller: numeric IDs are looked up but absence never fails —
    // we proceed and store the telegram id directly. @username stays unresolved (null).
    let sellerTelegramId: number | null = null;
    let sellerRow: Record<string, unknown> | null = null;
    if (/^-?\d+$/.test(sellerRef)) {
      const n = Number(sellerRef);
      if (!Number.isInteger(n) || n <= 0) {
        return ctx.reply('❌ <b>Invalid seller ID.</b> Must be a positive integer Telegram ID.', { parse_mode: 'HTML' });
      }
      sellerTelegramId = n;
      sellerRow = await getUserByTelegramId(n); // best-effort; null is fine
    }

    const deadline = new Date(Date.now() + 24 * 3600 * 1000);

    // 1) DB record FIRST so we always have a durable deal id.
    const deal = await createDealRecord({
      buyerId: ctx.from!.id,
      sellerId: sellerTelegramId,
      buyerTelegramId: ctx.from!.id,
      sellerTelegramId,
      asset,
      amount,
      feeBps: config.feeBps,
      status: DEAL_STATUS.AWAITING_DEPOSIT,
      contractAddress: '',
      paymentAddress: '',
      terms: terms || 'No special terms',
      deadline,
    });

    // 2) On-chain deployment ONLY in explicit on-chain mode with signer configured.
    let contractAddress = '';
    if (config.requireOnchain && config.signerUrl && config.escrowContractCodeHex) {
      try {
        const buyerRow = await getUserByTelegramId(ctx.from!.id);
        contractAddress = await deployEscrowContract(
          BigInt(deal.id),
          Address.parse((buyerRow?.ton_address as string) || ''),
          Address.parse(((sellerRow?.ton_address as string) || '')),
          asset === 'TON' ? 0 : 1,
          BigInt(baseUnits),
          Math.floor(deadline.getTime() / 1000),
          undefined,
          undefined
        );
      } catch (err) {
        logger.error(`On-chain deployment failed for deal #${deal.id}`, err);
        await ctx.reply(
          `⚠️ Deal #${deal.id} was created, but on-chain deployment failed: ${(err as Error).message}\n` + 'Continuing in off-chain mode.',
          { parse_mode: 'HTML' }
        );
        contractAddress = '';
      }
    } else if (config.requireOnchain) {
      logger.warn(`Deal #${deal.id}: REQUIRE_ONCHAIN=true but signer/ESCROW_CONTRACT_CODE_HEX missing — staying off-chain (check SIGNER_URL)`);
    }

    // 3) Off-chain fallback: deposits go to the custodial wallet address.
    const paymentAddress = contractAddress || config.walletAddress || config.adminAddress || '';
    await db.query('UPDATE deals SET contract_address = $1, payment_address = $2 WHERE id = $3', [
      contractAddress,
      paymentAddress,
      deal.id,
    ]);

    if (paymentAddress) addAddressToMonitor(paymentAddress);

    const token = await generateDealLink(deal.id);
    const joinHint = config.webappUrl
      ? `${config.webappUrl}${config.webappUrl.includes('?') ? '&' : '?'}deal=${deal.id}&join=${token}`
      : `POST /api/deals/${deal.id}/join/${token}`;

    const feePct = (config.feeBps / 100).toFixed(config.feeBps % 100 === 0 ? 0 : 2);
    const memo = depositComment(deal.id);
    const outPreview = releaseComment({ id: deal.id, amount: humanAmount, asset, terms });

    // Polished HTML card — matches the new welcome design language
    const card = [
      `✅ <b>Escrow Deal #${deal.id} Created!</b>`,
      `━━━━━━━━━━━━━━━━━━━━━━━`,
      ``,
      `  💎 <b>Amount:</b> <code>${escapeHtml(humanAmount)} ${escapeHtml(asset)}</code>`,
      `     <i>${escapeHtml(baseUnits)} base units</i>`,
      `  💰 <b>Fee:</b> <code>${escapeHtml(String(config.feeBps))} bps (${feePct}%)</code>`,
      `  📊 <b>Status:</b> <code>${escapeHtml(DEAL_STATUS.AWAITING_DEPOSIT)}</code> ⏳`,
      contractAddress
        ? `  ⛓ <b>Contract:</b> <code>${escapeHtml(contractAddress.slice(0, 32))}…</code>`
        : `  🗄 <b>Mode:</b> off-chain (custodial)`,
      paymentAddress && !contractAddress ? `  💳 <b>Pay to:</b> <code>${escapeHtml(paymentAddress)}</code>` : '',
      `  ⏰ <b>Deadline:</b> <code>${escapeHtml(deadline.toISOString().slice(0, 16).replace('T', ' '))} UTC</code> (24h)`,
      terms ? `  📝 <b>Terms:</b> <i>${escapeHtml(terms.slice(0, 180))}</i>` : '',
      ``,
      `  📝 <b>Deposit memo (required):</b> <code>${escapeHtml(memo)}</code>`,
      asset === 'TON'
        ? `     <i>Include this comment when you send TON to the address above — bot uses it to detect your payment.</i>`
        : `     <i>Include this in the Jetton forward payload when you send ${asset} — bot uses it to detect your payment.</i>`,
      `  💸 <b>On release seller will receive:</b> <code>${escapeHtml(outPreview)}</code>`,
      ``,
      `🔗 <b>Invite counterparty</b> — share this one-time link:`,
      config.webappUrl ? `  <a href="${escapeHtml(joinHint)}">${escapeHtml(joinHint)}</a>` : `  <code>${escapeHtml(joinHint)}</code>`,
      ``,
      `💡 <i>They tap the link to join as seller. Then deposit to the address above with the memo.</i>`,
      `📊 Check progress any time: <code>/status ${deal.id}</code>`,
    ]
      .filter(Boolean)
      .join('\n');

    await ctx.reply(card, {
      parse_mode: 'HTML',
      reply_markup: postCreateKeyboard(deal.id, config.webappUrl || undefined),
      link_preview_options: { is_disabled: true } as any,
    });
  });
}
