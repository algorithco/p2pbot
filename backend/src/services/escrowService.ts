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

/** Fire-and-forget admin alert that never throws. */
function notifyAdmins(message: string) {
  void alertAdmins(message).catch((err) => logger.warn('alertAdmins failed', err));
}

function isAdmin(telegramId: number): boolean {
  return config.adminTelegramIds.includes(Number(telegramId));
}

/**
 * Shared guarded transition for RELEASED/REFUNDED.
 * Off-chain mode: pure DB status transition (+ resolved_at via updateDealStatus).
 * On-chain mode: refuses to fake success until sendRelease/sendRefund exist.
 */
async function guardedTransition(dealId: number, status: string) {
  if (config.requireOnchain) {
    // TODO(blockchain-agent): call escrow.sendRelease()/sendRefund() here once
    // sendRelease/sendRefund land in src/blockchain; then persist status + tx_hash.
    throw new Error('onchain_release_not_configured');
  }
  await updateDealStatus(dealId, status);
}

export async function adminRelease(adminTelegramId: number | string, dealId: number | string) {
  const id = Number(dealId);
  if (!isAdmin(Number(adminTelegramId))) {
    return { success: false, message: 'Unauthorized.' };
  }
  try {
    await guardedTransition(id, DEAL_STATUS.RELEASED);
    notifyAdmins(`Deal #${id} RELEASED by admin ${adminTelegramId}.`);
    return { success: true, message: 'Funds released.' };
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
    await guardedTransition(id, DEAL_STATUS.REFUNDED);
    notifyAdmins(`Deal #${id} REFUNDED by admin ${adminTelegramId}.`);
    return { success: true, message: 'Funds refunded.' };
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
 * No funds are actually moved; on-chain transfers are not configured yet.
 */
export async function transferTokens(dealId: number, toAddress: string, amount: number, tokenType: 'TON' | 'USDT', includeFee: boolean = true) {
  void tokenType;
  void amount;
  void includeFee;
  const id = Number(dealId);
  logger.warn(`transferTokens(deal #${id} -> ${toAddress}) is deprecated; using guarded release path`);
  await guardedTransition(id, DEAL_STATUS.RELEASED);
  return { ok: true, dealId: id, status: DEAL_STATUS.RELEASED };
}

/**
 * @deprecated Legacy API surface — routes through the same guarded transition.
 * No funds are actually moved; on-chain refunds are not configured yet.
 */
export async function refundBuyerWithoutFee(dealId: number, toAddress: string) {
  const id = Number(dealId);
  logger.warn(`refundBuyerWithoutFee(deal #${id} -> ${toAddress}) is deprecated; using guarded refund path`);
  await guardedTransition(id, DEAL_STATUS.REFUNDED);
  return { ok: true, dealId: id, status: DEAL_STATUS.REFUNDED };
}

/**
 * Record a party confirmation on a deal in DEPOSIT_CONFIRMED state.
 * Both parties confirmed -> straight to RELEASED (+ resolved_at).
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
    await updateDealStatus(id, nextStatus);
  }

  if (nextStatus === DEAL_STATUS.RELEASED) {
    notifyAdmins(`Deal #${id} auto-RELEASED: both parties confirmed.`);
    return { success: true, message: 'Both parties confirmed — funds released.', released: true };
  }
  return { success: true, message: 'Confirmation recorded. Waiting for the other party.', released: false };
}
