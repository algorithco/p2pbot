// src/services/escrowService.ts
import { db } from '../db/queries';
import {
  DEAL_STATUS,
  getDealById,
  updateDealStatus,
  setConfirmation,
} from './dealService';
import { config } from '../config';
import logger from '../logger';
import { alertAdmins } from './notificationService';
import { releaseComment, depositComment } from '../utils/comments';
import { sendTon, sendJetton } from '../blockchain/signerClient';
import { encryptField } from '../utils/encryption';
import { toBaseUnits, fromBaseUnits } from '../utils/money';

/** Fire-and-forget admin alert that never throws. */
function notifyAdmins(message: string) {
  void alertAdmins(message).catch((err) => logger.warn('alertAdmins failed', err));
}

function isAdmin(telegramId: number): boolean {
  return config.adminTelegramIds.includes(Number(telegramId));
}

/**
 * Shared guarded transition for RELEASED/REFUNDED.
 * Off-chain mode: now also disburses via signer minus commission (custodial payout).
 * On-chain mode: sends funds via signer with a human-readable comment.
 */
async function guardedTransition(dealId: number, status: string, opts?: { toAddress?: string; amount?: string | number; asset?: string; terms?: string }) {
  const deal = await getDealById(dealId);
  if (!deal) throw new Error('deal_not_found');
  const asset = String(opts?.asset || deal.asset || 'TON').toUpperCase();
  const amountStr = String(opts?.amount ?? deal.amount ?? 0);
  const terms = String(opts?.terms || deal.terms || '');

  // Fee-aware amount for RELEASED (seller payout minus commission). Refund is full.
  let payoutHuman = amountStr;
  let feeHuman: string | null = null;
  if (status === DEAL_STATUS.RELEASED) {
    try {
      const totalBase = BigInt(toBaseUnits(amountStr, asset));
      const feeBps = Number(deal.fee_bps ?? config.feeBps ?? 0);
      if (feeBps > 0 && feeBps < 10000) {
        const sellerBase = (totalBase * BigInt(10000 - feeBps)) / BigInt(10000);
        const feeBase = totalBase - sellerBase;
        payoutHuman = fromBaseUnits(sellerBase, asset);
        feeHuman = fromBaseUnits(feeBase, asset);
        // Guard against 0 payout due to rounding
        if (payoutHuman === '0' || payoutHuman === '-0') payoutHuman = amountStr;
      }
    } catch (e) {
      logger.warn(`Fee calc failed for deal #${dealId}`, e);
      payoutHuman = amountStr;
    }
  }

  if (config.requireOnchain) {
    // On-chain: actually move funds via signer with a comment
    const memo = releaseComment({ id: dealId, amount: amountStr, asset, terms });
    // For refund, keep same memo but prefix "Refund:" — ensure <120 chars for TON comment limit
    let finalMemoPlain = status === DEAL_STATUS.REFUNDED ? `Refund: ${memo}` : memo;
    if (finalMemoPlain.length > 120) finalMemoPlain = finalMemoPlain.slice(0, 119) + '…';
    // Memo is encrypted and auto-injected — never show plaintext to user
    const finalMemo = encryptField(finalMemoPlain);

    const to = opts?.toAddress || (status === DEAL_STATUS.RELEASED ? String(deal.seller_telegram_id ? '' : deal.payment_address) : String(deal.buyer_telegram_id ? '' : deal.payment_address));
    // Try to resolve seller/buyer TON address from users table
    let toAddress = to;
    if (!toAddress || toAddress.trim() === '') {
      // Fallback: try to get seller/buyer TON address
      const targetId = status === DEAL_STATUS.RELEASED ? deal.seller_telegram_id : deal.buyer_telegram_id;
      if (targetId) {
        const res = await db.query('SELECT ton_address FROM users WHERE telegram_id = $1 LIMIT 1', [Number(targetId)]);
        toAddress = res.rows[0]?.ton_address || '';
      }
    }
    if (!toAddress) {
      throw new Error('onchain_release_not_configured: no destination address (set user ton_address or provide toAddress)');
    }

    // Send via signer (TON or Jetton) — memo is mandatory in EVERY tx
    try {
      if (asset === 'TON') {
        await sendTon({ to: toAddress, value: payoutHuman, comment: finalMemo, bounce: false });
        logger.info(`On-chain ${status} for deal #${dealId} to ${toAddress} amount ${payoutHuman} (total ${amountStr} fee ${feeHuman ?? 0})`);
        // Fee payout to feeAddress if configured and fee exists
        if (status === DEAL_STATUS.RELEASED && feeHuman && config.feeAddress && feeHuman !== '0') {
          try {
            const feeMemo = encryptField(`Fee for Escrow #${dealId} — ${feeHuman} ${asset}`);
            await sendTon({ to: config.feeAddress, value: feeHuman, comment: feeMemo, bounce: false });
            logger.info(`Fee ${feeHuman} ${asset} sent to ${config.feeAddress} for deal #${dealId}`);
          } catch (feeErr) {
            logger.warn(`Fee payout failed for deal #${dealId}`, feeErr);
          }
        }
      } else {
        const jettonMaster = config.jettonMasterAddress || config.usdtJettonAddress;
        if (!jettonMaster) throw new Error('jetton_master_not_configured: set JETTON_MASTER_ADDRESS or USDT_JETTON_ADDRESS');
        await sendJetton({ jettonMasterAddress: jettonMaster, to: toAddress, amount: payoutHuman, forwardComment: finalMemo, forwardTonAmount: '0.01' });
        logger.info(`On-chain Jetton ${status} for deal #${dealId} to ${toAddress} amount ${payoutHuman} forward memo "${finalMemo}"`);
      }
    } catch (e) {
      logger.error(`On-chain send failed for deal #${dealId} (${status})`, e);
      throw new Error(`onchain_send_failed: ${(e as Error).message}`);
    }
    await updateDealStatus(dealId, status);
    return;
  }
  // Off-chain (custodial) mode: also disburse via signer if wallet configured, minus fee
  if (status === DEAL_STATUS.RELEASED) {
    // Attempt custodial payout via signer
    let toAddress = opts?.toAddress || '';
    if (!toAddress) {
      const targetId = deal.seller_telegram_id;
      if (targetId) {
        const res = await db.query('SELECT ton_address FROM users WHERE telegram_id = $1 LIMIT 1', [Number(targetId)]);
        toAddress = res.rows[0]?.ton_address || '';
      }
    }
    if (toAddress) {
      try {
        const memo = encryptField(releaseComment({ id: dealId, amount: amountStr, asset, terms }));
        if (asset === 'TON') {
          await sendTon({ to: toAddress, value: payoutHuman, comment: memo, bounce: false });
          logger.info(`Custodial RELEASE for deal #${dealId} to ${toAddress} amount ${payoutHuman} (fee ${feeHuman ?? 0})`);
          if (feeHuman && config.feeAddress && feeHuman !== '0') {
            try {
              const feeMemo = encryptField(`Fee for Escrow #${dealId} — ${feeHuman} ${asset}`);
              await sendTon({ to: config.feeAddress, value: feeHuman, comment: feeMemo, bounce: false });
            } catch (feeErr) {
              logger.warn(`Custodial fee payout failed for deal #${dealId}`, feeErr);
            }
          }
        } else {
          const jettonMaster = config.jettonMasterAddress || config.usdtJettonAddress;
          if (jettonMaster) {
            await sendJetton({ jettonMasterAddress: jettonMaster, to: toAddress, amount: payoutHuman, forwardComment: memo, forwardTonAmount: '0.01' });
            logger.info(`Custodial Jetton RELEASE for deal #${dealId} to ${toAddress} amount ${payoutHuman}`);
          }
        }
      } catch (e) {
        logger.warn(`Custodial payout failed for deal #${dealId} — marking RELEASED anyway (manual payout needed): ${(e as Error).message}`, e);
        // Do not throw; continue to mark RELEASED so deal doesn't stall. Admin will be alerted.
        notifyAdmins(`Deal #${dealId} custodial payout failed: ${(e as Error).message} — amount ${payoutHuman} to ${toAddress}. Manual payout required.`);
      }
    } else {
      logger.warn(`No seller ton_address for deal #${dealId} — marking RELEASED without on-chain transfer (custodial off-chain). Fee ${feeHuman ?? 0}`);
    }
  }
  await updateDealStatus(dealId, status);
}

export async function adminRelease(adminTelegramId: number | string, dealId: number | string) {
  const id = Number(dealId);
  if (!isAdmin(Number(adminTelegramId))) {
    return { success: false, message: 'Unauthorized.' };
  }
  try {
    const deal = await getDealById(id);
    await guardedTransition(id, DEAL_STATUS.RELEASED, deal ? { toAddress: undefined, amount: deal.amount, asset: deal.asset, terms: deal.terms } : undefined);
    notifyAdmins(`Deal #${id} RELEASED by admin ${adminTelegramId} (encrypted memo auto-injected)`);
    return { success: true, message: `Funds released (encrypted memo)` };
  } catch (err) {
    logger.error(`adminRelease failed for deal #${id}`, err);
    notifyAdmins(`Deal #${id} release FAILED: ${(err as Error).message}`);
    return { success: false, message: (err as Error).message };
  }
}

export async function adminRefund(adminTelegramId: number | string, dealId: number | string) {
  const id = Number(dealId);
  if (!isAdmin(Number(adminTelegramId))) {
    return { success: false, message: 'Unauthorized.' };
  }
  try {
    const deal = await getDealById(id);
    await guardedTransition(id, DEAL_STATUS.REFUNDED, deal ? { amount: deal.amount, asset: deal.asset, terms: deal.terms } : undefined);
    notifyAdmins(`Deal #${id} REFUNDED by admin ${adminTelegramId} (encrypted memo)`);
    return { success: true, message: `Funds refunded (encrypted memo)` };
  } catch (err) {
    logger.error(`adminRefund failed for deal #${id}`, err);
    notifyAdmins(`Deal #${id} refund FAILED: ${(err as Error).message}`);
    return { success: false, message: (err as Error).message };
  }
}

export async function adminSetFiatSent(adminTelegramId: number | string, dealId: number | string) {
  if (!isAdmin(Number(adminTelegramId))) {
    return { success: false, message: 'Unauthorized.' };
  }
  await db.query('UPDATE deals SET terms = terms || $2, updated_at = now() WHERE id = $1', [Number(dealId), ' | Fiat sent: true']);
  return { success: true, message: 'Fiat payout marked as sent.' };
}

/**
 * @deprecated Legacy API surface — routes through the same guarded transition.
 * Now includes a proper release comment.
 */
export async function transferTokens(dealId: number, toAddress: string, amount: number, tokenType: 'TON' | 'USDT', includeFee: boolean = true) {
  void includeFee;
  const id = Number(dealId);
  const deal = await getDealById(id);
  const memoPlain = deal ? releaseComment({ id, amount: deal?.amount ?? amount, asset: tokenType, terms: deal?.terms }) : `For Escrow #${id} — ${amount} ${tokenType}`;
  const memo = encryptField(memoPlain);
  logger.warn(`transferTokens(deal #${id} -> ${toAddress}) is deprecated; using guarded release path (encrypted memo)`);
  if (config.requireOnchain) {
    try {
      if (tokenType === 'TON') {
        await sendTon({ to: toAddress, value: String(amount), comment: memo, bounce: false });
      } else {
        const jettonMaster = config.jettonMasterAddress || config.usdtJettonAddress;
        if (!jettonMaster) throw new Error('jetton_master_not_configured');
        await sendJetton({ jettonMasterAddress: jettonMaster, to: toAddress, amount: String(amount), forwardComment: memo });
      }
    } catch (e) {
      logger.warn(`transferTokens on-chain send failed for deal #${id}`, e);
    }
  }
  await guardedTransition(id, DEAL_STATUS.RELEASED, { toAddress, amount, asset: tokenType, terms: deal?.terms });
  return { ok: true, dealId: id, status: DEAL_STATUS.RELEASED, comment: '[encrypted]' };
}

/**
 * @deprecated Legacy API surface — routes through the same guarded transition.
 */
export async function refundBuyerWithoutFee(dealId: number, toAddress: string) {
  const id = Number(dealId);
  const deal = await getDealById(id);
  const memoPlain = deal ? `Refund: ${releaseComment({ id, amount: deal.amount, asset: deal.asset, terms: deal.terms })}` : `Refund for Escrow #${id}`;
  const memo = encryptField(memoPlain);
  logger.warn(`refundBuyerWithoutFee(deal #${id} -> ${toAddress}) is deprecated; using guarded refund path (encrypted memo)`);
  if (config.requireOnchain) {
    const amt = deal ? String(deal.amount) : '0';
    const asset = String(deal?.asset || 'TON').toUpperCase();
    try {
      if (asset === 'TON') {
        await sendTon({ to: toAddress, value: amt, comment: memo, bounce: false });
      } else {
        const jettonMaster = config.jettonMasterAddress || config.usdtJettonAddress;
        if (!jettonMaster) throw new Error('jetton_master_not_configured');
        await sendJetton({ jettonMasterAddress: jettonMaster, to: toAddress, amount: amt, forwardComment: memo });
      }
    } catch (e) {
      logger.warn(`refundBuyerWithoutFee on-chain send failed for deal #${id}`, e);
    }
  }
  await guardedTransition(id, DEAL_STATUS.REFUNDED, { toAddress, amount: deal?.amount, asset: deal?.asset, terms: deal?.terms });
  return { ok: true, dealId: id, status: DEAL_STATUS.REFUNDED, comment: '[encrypted]' };
}

/**
 * Record a party confirmation on a deal in DEPOSIT_CONFIRMED state.
 * Both parties confirmed -> straight to RELEASED (+ resolved_at) with a release comment.
 */
export async function recordConfirmation(telegramId: number, dealId: number | string) {
  const id = Number(dealId);
  const deal = await getDealById(id);
  if (!deal) return { success: false, message: 'Deal not found' };

  const isBuyer = deal.buyer_telegram_id != null && Number(deal.buyer_telegram_id) === telegramId;
  const isSeller = deal.seller_telegram_id != null && Number(deal.seller_telegram_id) === telegramId;
  if (!isBuyer && !isSeller) {
    return { success: false, message: 'Only the buyer or seller of this deal can confirm it.' };
  }

  if (deal.status !== DEAL_STATUS.DEPOSIT_CONFIRMED) {
    return {
      success: false,
      message: `Deal #${id} is currently "${deal.status}". Confirmation is only possible while it awaits your sign-off (status DEPOSIT_CONFIRMED).`,
    };
  }

  const role: 'buyer' | 'seller' = isBuyer ? 'buyer' : 'seller';
  const confirmations: Record<string, boolean> = { ...(deal.confirmations || {}), [role]: true };

  let nextStatus: string = deal.status;
  if (role === 'buyer') {
    nextStatus = confirmations.seller ? DEAL_STATUS.RELEASED : DEAL_STATUS.BUYER_CONFIRMED;
  } else if (confirmations.buyer) {
    nextStatus = DEAL_STATUS.RELEASED;
  }

  await setConfirmation(id, role, confirmations);
  if (nextStatus !== deal.status) {
    // If auto-releasing, memo is encrypted and not shown
    if (nextStatus === DEAL_STATUS.RELEASED) {
      logger.info(`Deal #${id} auto-release (encrypted memo)`);
      try {
        await guardedTransition(id, nextStatus, { amount: deal.amount, asset: deal.asset, terms: deal.terms });
      } catch (e) {
        logger.error(`Auto-release failed for deal #${id}`, e);
        return { success: false, message: (e as Error).message };
      }
      notifyAdmins(`Deal #${id} auto-RELEASED: both parties confirmed (encrypted memo)`);
      return { success: true, message: `Both parties confirmed — funds released`, released: true };
    }
    await updateDealStatus(id, nextStatus);
  }

  if (nextStatus === DEAL_STATUS.RELEASED) {
    notifyAdmins(`Deal #${id} auto-RELEASED: both parties confirmed.`);
    return { success: true, message: 'Both parties confirmed — funds released.', released: true };
  }
  return { success: true, message: 'Confirmation recorded. Waiting for the other party.', released: false };
}

/**
 * Seller signals item sent — moves DEPOSIT_CONFIRMED -> ITEM_SENT and notifies buyer "Did you receive it?"
 * Desired flow: after TON received, seller sends item off-chain then taps "I sent item", bot asks buyer.
 */
export async function markItemSent(sellerTelegramId: number, dealId: number | string) {
  const id = Number(dealId);
  const deal = await getDealById(id);
  if (!deal) return { success: false, message: 'Deal not found' };
  const isSeller = deal.seller_telegram_id != null && Number(deal.seller_telegram_id) === sellerTelegramId;
  if (!isSeller) return { success: false, message: 'Only the seller can mark item as sent.' };
  if (deal.status !== DEAL_STATUS.DEPOSIT_CONFIRMED) {
    return { success: false, message: `Deal #${id} is "${deal.status}" — can only mark sent from DEPOSIT_CONFIRMED.` };
  }
  await updateDealStatus(id, DEAL_STATUS.ITEM_SENT);
  // Notify buyer: "Did you receive it?" with approve button
  const buyerId = Number(deal.buyer_telegram_id);
  if (buyerId) {
    try {
      const { getBot } = await import('../bot/bot');
      const bot = getBot();
      if (bot) {
        const { InlineKeyboard } = await import('grammy');
        const product = deal.terms ? `"${String(deal.terms).slice(0, 80)}"` : 'the item';
        const text = [
          `📦 <b>Seller says item sent for Deal #${id}</b>`,
          `━━━━━━━━━━━━━━━━━━━━━━━`,
          `💎 <code>${String(deal.amount)} ${String(deal.asset)}</code> — ${product}`,
          ``,
          `Did you receive it?`,
          `Tap ✅ if received — funds will be released to seller (minus ${deal.fee_bps ?? config.feeBps} bps fee).`,
        ].join('\n');
        const kb = new InlineKeyboard()
          .text('✅ Yes, received - Release', `buyer_approve:${id}`)
          .text('❌ Not yet', `buyer_dispute:${id}`);
        try {
          await bot.api.sendMessage(buyerId, text, { parse_mode: 'HTML', reply_markup: kb });
        } catch (e) {
          logger.warn(`Could not notify buyer ${buyerId} for ITEM_SENT #${id}`, e);
        }
        // Also notify seller confirmation
        try {
          await bot.api.sendMessage(sellerTelegramId, `✅ Marked Deal #${id} as <b>ITEM_SENT</b> — buyer has been asked to confirm receipt.`, { parse_mode: 'HTML' });
        } catch {}
      }
    } catch (e) {
      logger.warn(`markItemSent notify failed for #${id}`, e);
    }
  }
  logger.info(`Deal #${id} marked ITEM_SENT by seller ${sellerTelegramId}`);
  return { success: true, message: 'Item marked as sent — buyer notified to confirm receipt.', status: DEAL_STATUS.ITEM_SENT };
}

/**
 * Buyer approves receipt — moves ITEM_SENT (or DEPOSIT_CONFIRMED/BUYER_CONFIRMED) -> RELEASED minus fee.
 * Desired flow: "Upon the buyer's approval, the bot transfers the TON to the seller (minus commission) and closes deal."
 */
export async function buyerApproveReceipt(buyerTelegramId: number, dealId: number | string) {
  const id = Number(dealId);
  const deal = await getDealById(id);
  if (!deal) return { success: false, message: 'Deal not found' };
  const isBuyer = deal.buyer_telegram_id != null && Number(deal.buyer_telegram_id) === buyerTelegramId;
  if (!isBuyer) return { success: false, message: 'Only the buyer can approve receipt and release funds.' };
  const allowed = [DEAL_STATUS.DEPOSIT_CONFIRMED, DEAL_STATUS.ITEM_SENT, DEAL_STATUS.BUYER_CONFIRMED];
  if (!allowed.includes(deal.status)) {
    return { success: false, message: `Deal #${id} is "${deal.status}" — approval only from ${allowed.join('/')} (seller must send item first or deposit must be confirmed).` };
  }
  if (deal.seller_telegram_id == null) return { success: false, message: 'Seller not yet joined — cannot release.' };
  // Record confirmation for audit
  const confirmations: Record<string, boolean> = { ...(deal.confirmations || {}), buyer: true };
  await setConfirmation(id, 'buyer', confirmations);
  try {
    await guardedTransition(id, DEAL_STATUS.RELEASED, { amount: deal.amount, asset: deal.asset, terms: deal.terms });
  } catch (e) {
    logger.error(`buyerApproveReceipt failed for deal #${id}`, e);
    return { success: false, message: (e as Error).message };
  }
  // Notifications
  try {
    const { getBot } = await import('../bot/bot');
    const bot = getBot();
    if (bot) {
      const sellerId = Number(deal.seller_telegram_id);
      const feeBps = Number(deal.fee_bps ?? config.feeBps ?? 100);
      let sellerHuman: string = String(deal.amount);
      try {
        const totalBase = BigInt(toBaseUnits(String(deal.amount), String(deal.asset)));
        const sellerBase = (totalBase * BigInt(10000 - feeBps)) / BigInt(10000);
        sellerHuman = fromBaseUnits(sellerBase, String(deal.asset));
      } catch {}
      const feeHuman = (() => {
        try {
          const totalBase = BigInt(toBaseUnits(String(deal.amount), String(deal.asset)));
          const sellerBase = (totalBase * BigInt(10000 - feeBps)) / BigInt(10000);
          return fromBaseUnits(totalBase - sellerBase, String(deal.asset));
        } catch { return '0'; }
      })();
      const buyerMsg = `✅ <b>Deal #${id} — you confirmed receipt.</b>\nFunds ${sellerHuman} ${deal.asset} released to seller (fee ${feeHuman} ${deal.asset} deducted). Deal closed.`;
      const sellerMsg = `🎉 <b>Deal #${id} — buyer confirmed receipt!</b>\nFunds ${sellerHuman} ${deal.asset} (minus ${feeBps} bps fee) transferred to you. Deal closed.`;
      try { await bot.api.sendMessage(buyerTelegramId, buyerMsg, { parse_mode: 'HTML' }); } catch {}
      try { await bot.api.sendMessage(sellerId, sellerMsg, { parse_mode: 'HTML' }); } catch {}
    }
  } catch (e) {
    logger.warn(`buyerApproveReceipt notify failed for #${id}`, e);
  }
  notifyAdmins(`Deal #${id} RELEASED by buyer ${buyerTelegramId} approval (fee deducted)`);
  return { success: true, message: 'Receipt confirmed — funds released to seller minus fee. Deal closed.', released: true, status: DEAL_STATUS.RELEASED };
}
