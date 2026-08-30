import { Bot } from 'grammy';
import { db, getUserByTelegramId, createUserIfNotExists } from '../../db/queries';
import { createDealRecord, generateDealLink, DEAL_STATUS } from '../../services/dealService';
import { deployEscrowContract } from '../../blockchain/contractDeployer';
import { addAddressToMonitor } from '../../blockchain/listener';
import { config } from '../../config';
import { webAppButton } from '../keyboards';
import { toBaseUnits, fromBaseUnits } from '../../utils/money';
import { Address } from '@ton/core';
import logger from '../../logger';

const USAGE = 'Usage: /newdeal <@seller|seller_id> <amount> <TON|USDT> [terms]';

export function registerNewDeal(bot: Bot) {
  bot.command('newdeal', async (ctx) => {
    const parts = (ctx.match || '').trim().split(/\s+/).filter(Boolean);
    if (parts.length < 3) return ctx.reply(USAGE);
    const sellerRef = parts[0];
    const amount = Number(parts[1]);
    const asset = parts[2].toUpperCase();
    const terms = parts.slice(3).join(' ').trim();

    if (!Number.isFinite(amount) || amount <= 0) return ctx.reply('Invalid amount.');
    if (asset !== 'TON' && asset !== 'USDT') return ctx.reply('Asset must be TON or USDT.');

    let baseUnits: string;
    try {
      baseUnits = toBaseUnits(amount, asset);
    } catch {
      return ctx.reply('Could not parse the amount. Use a plain decimal like 12.5');
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
      if (!Number.isInteger(n) || n <= 0) return ctx.reply('Invalid seller ID.');
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
          `⚠️ Deal #${deal.id} was created, but on-chain deployment failed: ${(err as Error).message}\n` +
            'Continuing in off-chain mode.'
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

    const lines = [
      `✅ Escrow deal #${deal.id} created`,
      '',
      `Amount: ${humanAmount} ${asset} (${baseUnits} base units)`,
      `Fee: ${config.feeBps} bps`,
      `Status: ${DEAL_STATUS.AWAITING_DEPOSIT}`,
      contractAddress ? `Contract: ${contractAddress}` : 'Mode: off-chain',
      paymentAddress && !contractAddress ? `Pay to: ${paymentAddress}` : '',
      `Deadline: ${deadline.toISOString()}`,
      terms ? `Terms: ${terms}` : '',
      '',
      `Share this join link with the counterparty:`,
      joinHint,
      `Check progress any time: /status ${deal.id}`,
    ].filter(Boolean);

    const extra = config.webappUrl ? { reply_markup: webAppButton(config.webappUrl, 'Open Escrow') } : {};
    await ctx.reply(lines.join('\n'), extra);
  });
}
