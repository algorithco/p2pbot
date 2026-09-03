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
 * Resolve payout destination TON address for a deal.
 * Priority: explicit opts.toAddress > per-deal payout_address > users.ton_address (seller/buyer) > DB fallback.
 * Returns null if none found — caller must throw seller_ton_address_required.
 */
async function resolvePayoutAddress(deal: any, optsToAddress: string | undefined, targetTelegramId: number | null): Promise<string | null> {
  let toAddress = (optsToAddress || '').trim();
  if (toAddress) return toAddress;
  const payoutAddr = (deal as any).payout_address as string | undefined;
  if (payoutAddr && payoutAddr.trim()) return payoutAddr.trim();
  if (targetTelegramId != null) {
    try {
      const res = await db.query('SELECT ton_address FROM users WHERE telegram_id = $1 LIMIT 1', [Number(targetTelegramId)]);
      if (res.rows[0]?.ton_address) return String(res.rows[0].ton_address).trim();
    } catch {}
    try {
      const r2 = await db.query('SELECT payout_address FROM deals WHERE id = $1 LIMIT 1', [deal.id]);
      if (r2.rows[0]?.payout_address) return String(r2.rows[0].payout_address).trim();
    } catch {}
  }
  return null;
}

/** Valid transitions for guarded release/refund. */
function isValidTransition(currentStatus: string, nextStatus: string): boolean {
  if (nextStatus === DEAL_STATUS.REFUNDED) {
    return [DEAL_STATUS.AWAITING_DEPOSIT, DEAL_STATUS.DEPOSIT_CONFIRMED, DEAL_STATUS.ITEM_SENT, DEAL_STATUS.BUYER_CONFIRMED].includes(currentStatus as any);
  }
  if (nextStatus === DEAL_STATUS.RELEASED) {
    return [DEAL_STATUS.DEPOSIT_CONFIRMED, DEAL_STATUS.ITEM_SENT, DEAL_STATUS.BUYER_CONFIRMED].includes(currentStatus as any);
  }
  return false;
}

/**
 * Shared guarded transition for RELEASED/REFUNDED.
 * Single send path — never sends twice. Webapp-first: requires seller payout address, posts chat system message.
 */
async function guardedTransition(dealId: number, status: string, opts?: { toAddress?: string; amount?: string | number; asset?: string; terms?: string }) {
  const deal = await getDealById(dealId);
  if (!deal) throw new Error('deal_not_found');
  if (![DEAL_STATUS.RELEASED, DEAL_STATUS.REFUNDED].includes(status as any)) throw new Error('invalid_target_status');
  if (!isValidTransition(String(deal.status), status)) {
    throw new Error(`invalid_transition: cannot go from ${deal.status} to ${status}`);
  }
  if (deal.status === status) throw new Error(`already_${status.toLowerCase()}`);
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
        if (payoutHuman === '0' || payoutHuman === '-0') payoutHuman = amountStr;
      }
    } catch (e) {
      logger.warn(`Fee calc failed for deal #${dealId}`, e);
      payoutHuman = amountStr;
    }
  }

  const isRelease = status === DEAL_STATUS.RELEASED;
  const targetTelegramId = isRelease ? deal.seller_telegram_id : deal.buyer_telegram_id;
  const memoPlainBase = releaseComment({ id: dealId, amount: amountStr, asset, terms });
  let memoPlain = isRelease ? memoPlainBase : `Refund: ${memoPlainBase}`;
  if (memoPlain.length > 120) memoPlain = memoPlain.slice(0, 119) + '…';
  const encryptedMemo = encryptField(memoPlain);

  // Resolve destination — for both custodial and on-chain modes
  const toAddress = await resolvePayoutAddress(deal, opts?.toAddress, targetTelegramId != null ? Number(targetTelegramId) : null);
  const isRefund = status === DEAL_STATUS.REFUNDED;
  if (!toAddress) {
    if (isRelease) throw new Error('seller_ton_address_required: seller must set TON payout address in web app (Deal → Set payout address or Profile → TON address)');
    if (isRefund) {
      // For refund, try payment_address fallback? No — buyer must have address too
      throw new Error('buyer_ton_address_required: buyer TON address missing, set in web app');
    }
  }

  // Attempt blockchain payout if we have a destination and signer configured.
  // For OFF-CHAIN custodial RELEASE we still require signer; for REFUND we also try but don't block status update if signer unavailable?
  // Current policy: RELEASE requires successful send; REFUND attempts send but falls through to status update if no jetton config etc.
  const shouldSend = isRelease || isRefund;
  if (shouldSend && toAddress) {
    try {
      if (asset === 'TON') {
        await sendTon({ to: toAddress!, value: isRelease ? payoutHuman : amountStr, comment: encryptedMemo, bounce: false });
        logger.info(`${config.requireOnchain ? 'On-chain' : 'Custodial'} ${status} for deal #${dealId} to ${toAddress} amount ${isRelease ? payoutHuman : amountStr} (total ${amountStr} fee ${feeHuman ?? 0})`);
        if (isRelease && feeHuman && config.feeAddress && feeHuman !== '0') {
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
        await sendJetton({ jettonMasterAddress: jettonMaster, to: toAddress!, amount: isRelease ? payoutHuman : amountStr, forwardComment: encryptedMemo, forwardTonAmount: '0.01' });
        logger.info(`${config.requireOnchain ? 'On-chain' : 'Custodial'} Jetton ${status} for deal #${dealId} to ${toAddress} amount ${isRelease ? payoutHuman : amountStr}`);
        if (isRelease && feeHuman && config.feeAddress && feeHuman !== '0') {
          // Jetton fee currently sent as TON fee via signer if feeAddress present — keep separate
          try {
            const feeMemo = encryptField(`Fee for Escrow #${dealId} — ${feeHuman} ${asset}`);
            await sendTon({ to: config.feeAddress, value: feeHuman, comment: feeMemo, bounce: false });
          } catch {}
        }
      }
    } catch (e) {
      const msg = String((e as Error).message || '');
      if (msg.includes('seller_ton_address_required') || msg.includes('buyer_ton_address_required')) throw e;
      // For RELEASE, payout failure must NOT mark RELEASED
      if (isRelease) {
        logger.warn(`Payout failed for deal #${dealId} — not marking ${status}, manual required: ${msg}`, e);
        notifyAdmins(`Deal #${dealId} payout failed: ${msg} — amount ${isRelease ? payoutHuman : amountStr} to ${toAddress}. Manual payout required.`);
        throw new Error(`payout_failed: ${msg}`);
      }
      logger.error(`On-chain send failed for deal #${dealId} (${status}) fallback to status update`, e);
      // For REFUND, continue to mark REFUNDED even if send failed? We throw to avoid silent loss — keep throwing
      throw new Error(`onchain_send_failed: ${msg}`);
    }
  } else if (isRelease && !toAddress) {
    throw new Error('seller_ton_address_required: seller must set payout address');
  }

  await updateDealStatus(dealId, status);
  // Post system message to deal chat (E2E not needed for system — plaintext as server)
  try {
    const { addDealMessage } = await import('./dealService');
    const sysText = status === DEAL_STATUS.RELEASED
      ? `🔒 System: Deal #${dealId} RELEASED — ${isRelease ? payoutHuman : amountStr} ${asset} sent to seller${feeHuman ? ` (fee ${feeHuman} ${asset})` : ''}.`
      : `🔒 System: Deal #${dealId} REFUNDED — ${amountStr} ${asset} returned to buyer.`;
    await addDealMessage(dealId, 0, sysText);
  } catch {}
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
 * @deprecated Legacy API surface — SINGLE send path via guardedTransition only (no double-send).
 */
export async function transferTokens(dealId: number, toAddress: string, amount: number, tokenType: 'TON' | 'USDT', includeFee: boolean = true) {
  void includeFee;
  const id = Number(dealId);
  const deal = await getDealById(id);
  logger.warn(`transferTokens(deal #${id} -> ${toAddress}) deprecated; single guardedTransition path`);
  await guardedTransition(id, DEAL_STATUS.RELEASED, { toAddress, amount, asset: tokenType, terms: deal?.terms });
  return { ok: true, dealId: id, status: DEAL_STATUS.RELEASED, comment: '[encrypted]' };
}

/**
 * @deprecated Legacy API surface — single path.
 */
export async function refundBuyerWithoutFee(dealId: number, toAddress: string) {
  const id = Number(dealId);
  const deal = await getDealById(id);
  logger.warn(`refundBuyerWithoutFee(deal #${id} -> ${toAddress}) deprecated; single guardedTransition path`);
  await guardedTransition(id, DEAL_STATUS.REFUNDED, { toAddress, amount: deal?.amount, asset: deal?.asset, terms: deal?.terms });
  return { ok: true, dealId: id, status: DEAL_STATUS.REFUNDED, comment: '[encrypted]' };
}

/**
 * @deprecated Legacy mutual confirm path — kept for backward compat but now delegates to webapp-first flow.
 * New flow: seller markItemSent -> buyer buyerApproveReceipt. This function will warn and not auto-release unless already ITEM_SENT.
 */
export async function recordConfirmation(telegramId: number, dealId: number | string) {
  const id = Number(dealId);
  const deal = await getDealById(id);
  if (!deal) return { success: false, message: 'Deal not found' };
  logger.warn(`recordConfirmation deprecated for deal #${id} by ${telegramId} status ${deal.status} — use webapp POST /ship or /approve`);
  // Only allow if exactly DEPOSIT_CONFIRMED -> record but do NOT auto-release unless buyer+seller both confirmed AND deal was already ITEM_SENT style
  // For now, preserve old behavior but warn that webapp flow is preferred
  const isBuyer = deal.buyer_telegram_id != null && Number(deal.buyer_telegram_id) === telegramId;
  const isSeller = deal.seller_telegram_id != null && Number(deal.seller_telegram_id) === telegramId;
  if (!isBuyer && !isSeller) return { success: false, message: 'Only the buyer or seller of this deal can confirm it.' };
  if (deal.status !== DEAL_STATUS.DEPOSIT_CONFIRMED) {
    return { success: false, message: `Deal #${id} is "${deal.status}". Use web app: seller "I sent item" then buyer "Yes, received".` };
  }
  const role: 'buyer' | 'seller' = isBuyer ? 'buyer' : 'seller';
  const confirmations: Record<string, boolean> = { ...(deal.confirmations || {}), [role]: true };
  await setConfirmation(id, role, confirmations);
  // Do not auto-release via legacy mutual confirm unless both confirmed — and even then delegate to guardedTransition
  if (confirmations.buyer && confirmations.seller) {
    try {
      await guardedTransition(id, DEAL_STATUS.RELEASED, { amount: deal.amount, asset: deal.asset, terms: deal.terms });
      notifyAdmins(`Deal #${id} auto-RELEASED via legacy mutual confirm (deprecated)`);
      return { success: true, message: `Both parties confirmed — funds released (deprecated path, use webapp)`, released: true };
    } catch (e) {
      logger.error(`Legacy auto-release failed for deal #${id}`, e);
      return { success: false, message: (e as Error).message };
    }
  }
  if (role === 'buyer') await updateDealStatus(id, DEAL_STATUS.BUYER_CONFIRMED);
  return { success: true, message: 'Confirmation recorded (deprecated path — please use web app Ship/Approve). Waiting for counterparty.', released: false };
}

/**
 * Seller signals item sent — moves DEPOSIT_CONFIRMED -> ITEM_SENT and notifies buyer "Did you receive it?"
 * Webapp-first: posts system message to deal chat + bot notification with webApp button.
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
  // Ensure seller payout address is set before allowing ship (fail-fast, better UX)
  const payoutAddr = (deal as any).payout_address as string | undefined;
  let hasPayout = !!(payoutAddr && payoutAddr.trim());
  if (!hasPayout) {
    try {
      const r = await db.query('SELECT ton_address FROM users WHERE telegram_id = $1 LIMIT 1', [Number(sellerTelegramId)]);
      if (r.rows[0]?.ton_address) hasPayout = true;
    } catch {}
  }
  if (!hasPayout) {
    return { success: false, message: 'seller_ton_address_required: set payout address in web app (Deal → Set payout address) before marking sent', needSellerAddress: true } as any;
  }
  await updateDealStatus(id, DEAL_STATUS.ITEM_SENT);
  // Post system message to deal chat (visible in webapp)
  try {
    const { addDealMessage } = await import('./dealService');
    await addDealMessage(id, 0, `📦 Seller marked item as sent for Deal #${id} — buyer please confirm receipt in web app.`);
  } catch {}
  // Notify buyer via bot (notification only) with webApp button
  const buyerId = Number(deal.buyer_telegram_id);
  if (buyerId) {
    try {
      const { getBot } = await import('../bot/bot');
      const bot = getBot();
      if (bot) {
        const { InlineKeyboard } = await import('grammy');
        const product = deal.terms ? `"${String(deal.terms).slice(0, 80)}"` : 'the item';
        const webappUrl = config.webappUrl || config.frontendUrl;
        const dealUrl = webappUrl ? `${webappUrl.replace(/\/$/, '')}/#/deal/${id}` : undefined;
        const text = [
          `📦 <b>Seller says item sent for Deal #${id}</b>`,
          `━━━━━━━━━━━━━━━━━━━━━━━`,
          `💎 <code>${String(deal.amount)} ${String(deal.asset)}</code> — ${product}`,
          ``,
          `Did you receive it? Open web app to confirm: Deal #${id} → ✅ Yes, received - Release`,
        ].join('\n');
        const kb = new InlineKeyboard();
        if (dealUrl) kb.webApp('📲 Open Web App to Confirm', dealUrl);
        // Keep legacy callback for users who only have bot, but preference is webapp
        kb.text('❌ Not yet (chat)', `buyer_dispute:${id}`);
        try {
          await bot.api.sendMessage(buyerId, text, { parse_mode: 'HTML', reply_markup: kb });
        } catch (e) {
          logger.warn(`Could not notify buyer ${buyerId} for ITEM_SENT #${id}`, e);
        }
        try {
          await bot.api.sendMessage(sellerTelegramId, `✅ Marked Deal #${id} as <b>ITEM_SENT</b> — buyer has been notified via web app & bot.`, { parse_mode: 'HTML' });
        } catch {}
      }
    } catch (e) {
      logger.warn(`markItemSent notify failed for #${id}`, e);
    }
  }
  logger.info(`Deal #${id} marked ITEM_SENT by seller ${sellerTelegramId}`);
  return { success: true, message: 'Item marked as sent — buyer notified via web app & bot.', status: DEAL_STATUS.ITEM_SENT };
}

/**
 * Buyer approves receipt — moves ITEM_SENT -> RELEASED minus fee (strict).
 * Webapp-first: buyer confirms in Deal Detail or Chat. Seller must have sent item first.
 */
export async function buyerApproveReceipt(buyerTelegramId: number, dealId: number | string) {
  const id = Number(dealId);
  const deal = await getDealById(id);
  if (!deal) return { success: false, message: 'Deal not found' };
  const isBuyer = deal.buyer_telegram_id != null && Number(deal.buyer_telegram_id) === buyerTelegramId;
  if (!isBuyer) return { success: false, message: 'Only the buyer can approve receipt and release funds.' };
  const allowed = [DEAL_STATUS.ITEM_SENT];
  if (!allowed.includes(deal.status as any)) {
    if (deal.status === DEAL_STATUS.DEPOSIT_CONFIRMED) {
      return { success: false, message: `Deal #${id} is "DEPOSIT_CONFIRMED" — seller must mark item as sent first (web app → I sent the item) before you can release.`, needItemSent: true } as any;
    }
    if (deal.status === DEAL_STATUS.BUYER_CONFIRMED) {
      // legacy path — still allow but warn
      logger.warn(`buyerApproveReceipt legacy BUYER_CONFIRMED for deal #${id}`);
    } else {
      return { success: false, message: `Deal #${id} is "${deal.status}" — approval only from ITEM_SENT (seller must send item first).` };
    }
  }
  if (deal.seller_telegram_id == null) return { success: false, message: 'Seller not yet joined — cannot release.' };
  const confirmations: Record<string, boolean> = { ...(deal.confirmations || {}), buyer: true };
  await setConfirmation(id, 'buyer', confirmations);
  try {
    await guardedTransition(id, DEAL_STATUS.RELEASED, { amount: deal.amount, asset: deal.asset, terms: deal.terms });
  } catch (e) {
    const msg = String((e as Error).message || '');
    logger.error(`buyerApproveReceipt failed for deal #${id}`, e);
    if (msg.includes('seller_ton_address_required')) {
      try {
        const { getBot } = await import('../bot/bot');
        const bot = getBot();
        if (bot) {
          const sellerId = Number(deal.seller_telegram_id);
          const webappUrl = config.webappUrl || config.frontendUrl;
          const { InlineKeyboard } = await import('grammy');
          const kb = new InlineKeyboard();
          if (webappUrl) {
            const url = `${webappUrl.replace(/\/$/, '')}/#/deal/${id}`;
            kb.webApp('📲 Set TON address in web app', url);
          }
          kb.text('❓ How to set?', 'menu:how');
          const sellerPrompt = [
            `📲 <b>Action required for Deal #${id}</b>`,
            `━━━━━━━━━━━━━━━━━━━━━━━`,
            `Buyer confirmed receipt — ready to pay you <b>${String(deal.amount)} ${String(deal.asset)}</b> minus fee.`,
            ``,
            `Please set your TON payout address in the web app to receive funds:`,
            `1️⃣ Open Escrow web app → Deal #${id}`,
            `2️⃣ Tap "Set payout address" and paste your TON address (UQ/EQ…) or connect wallet`,
            `3️⃣ Buyer can then retry approval — funds will transfer automatically.`,
          ].join('\n');
          try { await bot.api.sendMessage(sellerId, sellerPrompt, { parse_mode: 'HTML', reply_markup: kb }); } catch {}
          try {
            await bot.api.sendMessage(buyerTelegramId, `⏳ <b>Deal #${id}</b> — you confirmed receipt, but seller has not set a TON payout address yet. Seller was notified via web app. Funds will transfer once seller adds address.`, { parse_mode: 'HTML' });
          } catch {}
          // Also post to chat
          try {
            const { addDealMessage } = await import('./dealService');
            await addDealMessage(id, 0, `⏳ Buyer confirmed receipt for Deal #${id} but seller payout address missing — seller please set payout address in web app.`);
          } catch {}
        }
      } catch {}
      return { success: false, message: msg, needSellerAddress: true } as any;
    }
    return { success: false, message: msg };
  }
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
      const webappUrl = config.webappUrl || config.frontendUrl;
      const dealUrl = webappUrl ? `${webappUrl.replace(/\/$/, '')}/#/deal/${id}` : undefined;
      const buyerMsg = `✅ <b>Deal #${id} — you confirmed receipt.</b>\nFunds ${sellerHuman} ${deal.asset} released to seller (fee ${feeHuman} ${deal.asset} deducted). Deal closed.${dealUrl ? `\nView: ${dealUrl}` : ''}`;
      const sellerMsg = `🎉 <b>Deal #${id} — buyer confirmed receipt!</b>\nFunds ${sellerHuman} ${deal.asset} (minus ${feeBps} bps fee) transferred to your payout address. Deal closed.`;
      try { await bot.api.sendMessage(buyerTelegramId, buyerMsg, { parse_mode: 'HTML' }); } catch {}
      try { await bot.api.sendMessage(sellerId, sellerMsg, { parse_mode: 'HTML' }); } catch {}
    }
  } catch (e) {
    logger.warn(`buyerApproveReceipt notify failed for #${id}`, e);
  }
  notifyAdmins(`Deal #${id} RELEASED by buyer ${buyerTelegramId} approval (fee deducted)`);
  return { success: true, message: 'Receipt confirmed — funds released to seller minus fee. Deal closed.', released: true, status: DEAL_STATUS.RELEASED };
}
