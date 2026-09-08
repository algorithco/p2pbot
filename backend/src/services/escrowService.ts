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
import { releaseComment } from '../utils/comments';
import { sendTon, sendJetton } from '../blockchain/signerClient';
import { encryptField } from '../utils/encryption';
import { toBaseUnits, fromBaseUnits } from '../utils/money';
import * as notify from '../bot/notify';

function isAdmin(telegramId: number): boolean {
  return config.adminTelegramIds.includes(Number(telegramId));
}

function dealLike(deal: { id: number | string; amount: string | number; asset: string; terms?: string | null }): {
  id: number | string;
  amount: string | number;
  asset: string;
  terms?: string;
} {
  return { id: deal.id, amount: deal.amount, asset: deal.asset, terms: deal.terms ?? undefined };
}

async function notifyAdminsHub(memo: string, amount = '', asset = ''): Promise<void> {
  try {
    await notify.unknownDepositToAdmins({ amount, asset, address: 'admin', memo: memo.slice(0, 300) });
  } catch (e) {
    logger.warn('admin hub notify failed', e);
  }
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

function feeParts(amountStr: string, assetUpper: string, feeBpsRaw: unknown): { sellerHuman: string; feeHuman: string; feeBase: bigint } {
  const priceBase = BigInt(toBaseUnits(amountStr, assetUpper));
  const n = Number(feeBpsRaw ?? config.feeBps ?? 100);
  const feeBps = Number.isFinite(n) && n >= 0 ? Math.floor(n) : 100;
  if (feeBps <= 0) {
    return { sellerHuman: fromBaseUnits(priceBase, assetUpper), feeHuman: fromBaseUnits(0n, assetUpper), feeBase: 0n };
  }
  const feeBase = (priceBase * BigInt(Math.min(feeBps, 10000))) / 10000n;
  return { sellerHuman: fromBaseUnits(priceBase, assetUpper), feeHuman: fromBaseUnits(feeBase, assetUpper), feeBase };
}

/**
 * Shared guarded transition for RELEASED/REFUNDED.
 * MONEY MODEL: deal.amount = price (seller net). Buyer deposited price+fee.
 * On RELEASED: seller gets amount, feeAddress gets fee.
 * FIX 2.1: wrapped in SELECT ... FOR UPDATE transaction to prevent double-payout races.
 */
async function guardedTransition(dealId: number, status: string, opts?: { toAddress?: string; amount?: string | number; asset?: string; terms?: string }) {
  const client = await db.connect();
  try {
    await client.query('BEGIN');
    const lockedRes = await client.query('SELECT * FROM deals WHERE id = $1 FOR UPDATE', [dealId]);
    const deal = lockedRes.rows[0];
    if (!deal) {
      await client.query('ROLLBACK');
      throw new Error(`deal_not_found: bitim topilmadi`);
    }
    if (![DEAL_STATUS.RELEASED, DEAL_STATUS.REFUNDED].includes(status as any)) {
      await client.query('ROLLBACK');
      throw new Error(`invalid_target_status: noto'g'ri holat`);
    }
    if (!isValidTransition(String(deal.status), status)) {
      await client.query('ROLLBACK');
      throw new Error(`invalid_transition: ${deal.status} dan ${status} ga o'tib bo'lmaydi`);
    }
    if (deal.status === status) {
      await client.query('ROLLBACK');
      throw new Error(`already_${String(status).toLowerCase()}: bitim allaqachon ${status} holatda`);
    }
    const asset = String(opts?.asset || deal.asset || 'TON').toUpperCase();
    const assetUpper = asset;
    const amountStr = String(opts?.amount ?? deal.amount ?? 0);
    const terms = String(opts?.terms || deal.terms || '');

    // Fee: seller net = amount (price), fee = amount * feeBps / 10000.
    let payoutHuman = amountStr;
    let feeHuman = fromBaseUnits(0n, assetUpper);
    let feeBase = 0n;
    if (status === DEAL_STATUS.RELEASED) {
      try {
        const parts = feeParts(amountStr, assetUpper, (deal as any).fee_bps ?? config.feeBps ?? 100);
        payoutHuman = parts.sellerHuman;
        feeHuman = parts.feeHuman;
        feeBase = parts.feeBase;
        if (payoutHuman === '0' || payoutHuman === '-0') payoutHuman = amountStr;
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

    const toAddress = await resolvePayoutAddress(deal, opts?.toAddress, targetTelegramId != null ? Number(targetTelegramId) : null);
    const isRefund = status === DEAL_STATUS.REFUNDED;
    if (!toAddress) {
      await client.query('ROLLBACK');
      if (isRelease) throw new Error(`seller_ton_address_required: sotuvchi TON manzilni ilovada kiritishi shart (Bitim → To'lov manzili yoki Profil → TON manzil)`);
      if (isRefund) {
        throw new Error(`buyer_ton_address_required: xaridor TON manzili yo'q, ilovada kiriting`);
      }
      throw new Error(`payout_address_required`);
    }

    const shouldSend = isRelease || isRefund;
    if (shouldSend && toAddress) {
      try {
        if (assetUpper === 'TON') {
          await sendTon({ to: toAddress!, value: isRelease ? payoutHuman : amountStr, comment: encryptedMemo, bounce: false });
          logger.info(`Custodial ${status} for deal #${dealId} to ${toAddress} amount ${isRelease ? payoutHuman : amountStr} (price ${amountStr} fee ${feeHuman})`);
          if (isRelease && feeBase > 0n && config.feeAddress && feeHuman !== '0') {
            try {
              const feeMemo = encryptField(`Fee for Escrow #${dealId} — ${feeHuman} ${assetUpper}`);
              await sendTon({ to: config.feeAddress, value: feeHuman, comment: feeMemo, bounce: false });
              logger.info(`Fee ${feeHuman} ${assetUpper} sent to ${config.feeAddress} for deal #${dealId}`);
            } catch (feeErr) {
              logger.warn(`Fee payout failed for deal #${dealId}`, feeErr);
            }
          }
        } else {
          const jettonMaster = config.jettonMasterAddress || config.usdtJettonAddress;
          if (!jettonMaster) throw new Error(`jetton_master_not_configured: jetton sozlanmagan, admin bilan bog'laning`);
          await sendJetton({ jettonMasterAddress: jettonMaster, to: toAddress!, amount: isRelease ? payoutHuman : amountStr, forwardComment: encryptedMemo, forwardTonAmount: '0.01' });
          logger.info(`Custodial Jetton ${status} for deal #${dealId} to ${toAddress} amount ${isRelease ? payoutHuman : amountStr}`);
          if (isRelease && feeBase > 0n && config.feeAddress && feeHuman !== '0') {
            try {
              const feeMemo = encryptField(`Fee for Escrow #${dealId} — ${feeHuman} ${assetUpper}`);
              await sendJetton({ jettonMasterAddress: jettonMaster, to: config.feeAddress, amount: feeHuman, forwardComment: feeMemo, forwardTonAmount: '0.01' });
            } catch (feeErr) {
              logger.warn(`Jetton fee payout failed for deal #${dealId}`, feeErr);
            }
          }
        }
      } catch (e) {
        const msg = String((e as Error).message || '');
        if (msg.includes('seller_ton_address_required') || msg.includes('buyer_ton_address_required')) {
          await client.query('ROLLBACK');
          throw e;
        }
        await client.query('ROLLBACK');
        if (isRelease) {
          logger.warn(`Payout failed for deal #${dealId} — not marking ${status}, manual required: ${msg}`, e);
          await notifyAdminsHub(`Deal #${dealId} payout failed: ${msg} — amount ${isRelease ? payoutHuman : amountStr} to ${toAddress}.`, String(isRelease ? payoutHuman : amountStr), assetUpper);
          throw new Error(`payout_failed: ${msg}`);
        }
        logger.error(`On-chain send failed for deal #${dealId} (${status})`, e);
        throw new Error(`onchain_send_failed: ${msg}`);
      }
    } else if (isRelease && !toAddress) {
      await client.query('ROLLBACK');
      throw new Error(`seller_ton_address_required: sotuvchi to'lov manzilini kiritishi shart`);
    }

    // Guarded status update inside transaction — row still locked, prevents race
    const finalSets: string[] = ['status = $1'];
    const finalParams: unknown[] = [status];
    finalSets.push('updated_at = now()');
    finalSets.push('resolved_at = now()');
    finalParams.push(dealId);
    const upd = await client.query(`UPDATE deals SET ${finalSets.join(', ')} WHERE id = $${finalParams.length} AND status = $${finalParams.length + 1} RETURNING id`, [...finalParams.slice(0, -1), dealId, deal.status]);
    // status guard: if rowCount 0 means concurrent transition already happened
    if (upd.rowCount === 0) {
      await client.query('ROLLBACK');
      throw new Error(`concurrent_transition: deal status changed concurrently from ${deal.status}`);
    }
    // also set tx_hash if needed (kept separate for compatibility)
    await client.query('COMMIT');
    // System message after commit (best-effort)
    try {
      const { addDealMessage } = await import('./dealService');
      const sysText = status === DEAL_STATUS.RELEASED
        ? `Tizim: Yakunlandi (Deal #${dealId}) — ${isRelease ? payoutHuman : amountStr} ${asset} sotuvchiga yuborildi${feeHuman !== '0' ? ` (komissiya ${feeHuman} ${asset})` : ''}.`
        : `Tizim: Qaytarildi (Deal #${dealId}) — ${amountStr} ${asset} xaridorga qaytarildi.`;
      await addDealMessage(dealId, 0, sysText);
    } catch (e) {
      logger.warn(`post-commit system message failed for deal #${dealId}`, e);
    }
  } catch (e) {
    try { await client.query('ROLLBACK'); } catch {}
    throw e;
  } finally {
    client.release();
  }
}

export async function adminRelease(adminTelegramId: number | string, dealId: number | string) {
  const id = Number(dealId);
  if (!isAdmin(Number(adminTelegramId))) {
    return { success: false, message: `Ruxsat yo'q.` };
  }
  try {
    const deal = await getDealById(id);
    await guardedTransition(id, DEAL_STATUS.RELEASED, deal ? { toAddress: undefined, amount: deal.amount, asset: deal.asset, terms: deal.terms } : undefined);
    const like = deal ? dealLike({ id, amount: String(deal.amount), asset: String(deal.asset), terms: deal.terms }) : { id, amount: '', asset: 'TON' };
    const partyText = `Admin qarori: pul sotuvchiga chiqarildi (Deal #${id}).`;
    try {
      if (deal?.buyer_telegram_id != null) await notify.adminDecisionToParty(Number(deal.buyer_telegram_id), like, partyText);
    } catch {}
    try {
      if (deal?.seller_telegram_id != null) await notify.adminDecisionToParty(Number(deal.seller_telegram_id), like, partyText);
    } catch {}
    try {
      const { saveAdminAlert } = await import('../db/queries');
      await saveAdminAlert('admin_release', `Deal #${id} admin tomonidan chiqarildi`, { dealId: id, by: Number(adminTelegramId) });
    } catch {}
    await notifyAdminsHub(`Deal #${id} admin tomonidan chiqarildi (${adminTelegramId})`, String(deal?.amount ?? ''), String(deal?.asset ?? ''));
    return { success: true, message: `Pul chiqarildi (shifrlangan memo)` };
  } catch (err) {
    logger.error(`adminRelease failed for deal #${id}`, err);
    await notifyAdminsHub(`Deal #${id} chiqarish xatosi: ${(err as Error).message}`);
    return { success: false, message: (err as Error).message };
  }
}

export async function adminRefund(adminTelegramId: number | string, dealId: number | string) {
  const id = Number(dealId);
  if (!isAdmin(Number(adminTelegramId))) {
    return { success: false, message: `Ruxsat yo'q.` };
  }
  try {
    const deal = await getDealById(id);
    await guardedTransition(id, DEAL_STATUS.REFUNDED, deal ? { amount: deal.amount, asset: deal.asset, terms: deal.terms } : undefined);
    const like = deal ? dealLike({ id, amount: String(deal.amount), asset: String(deal.asset), terms: deal.terms }) : { id, amount: '', asset: 'TON' };
    const partyText = `Admin qarori: pul xaridorga qaytarildi (Deal #${id}).`;
    try {
      if (deal?.buyer_telegram_id != null) await notify.adminDecisionToParty(Number(deal.buyer_telegram_id), like, partyText);
    } catch {}
    try {
      if (deal?.seller_telegram_id != null) await notify.adminDecisionToParty(Number(deal.seller_telegram_id), like, partyText);
    } catch {}
    try {
      const { saveAdminAlert } = await import('../db/queries');
      await saveAdminAlert('admin_refund', `Deal #${id} admin tomonidan qaytarildi`, { dealId: id, by: Number(adminTelegramId) });
    } catch {}
    await notifyAdminsHub(`Deal #${id} admin tomonidan qaytarildi (${adminTelegramId})`, String(deal?.amount ?? ''), String(deal?.asset ?? ''));
    return { success: true, message: `Pul qaytarildi (shifrlangan memo)` };
  } catch (err) {
    logger.error(`adminRefund failed for deal #${id}`, err);
    await notifyAdminsHub(`Deal #${id} qaytarish xatosi: ${(err as Error).message}`);
    return { success: false, message: (err as Error).message };
  }
}

/**
 * Seller signals item sent — moves DEPOSIT_CONFIRMED -> ITEM_SENT and notifies buyer.
 * FIX 2.1: transactional FOR UPDATE to prevent race with concurrent refund/release.
 */
export async function markItemSent(sellerTelegramId: number, dealId: number | string) {
  const id = Number(dealId);
  const client = await db.connect();
  try {
    await client.query('BEGIN');
    const locked = await client.query('SELECT * FROM deals WHERE id = $1 FOR UPDATE', [id]);
    const deal = locked.rows[0];
    if (!deal) {
      await client.query('ROLLBACK');
      return { success: false, message: 'Bitim topilmadi' };
    }
    const isSeller = deal.seller_telegram_id != null && Number(deal.seller_telegram_id) === sellerTelegramId;
    if (!isSeller) {
      await client.query('ROLLBACK');
      return { success: false, message: `Faqat sotuvchi yuborilganini belgilay oladi.` };
    }
    if (deal.status !== DEAL_STATUS.DEPOSIT_CONFIRMED) {
      await client.query('ROLLBACK');
      return { success: false, message: `Deal #${id} "${deal.status}" holatda — faqat DEPOSIT_CONFIRMED dan yuborilgan deb belgilash mumkin.` };
    }
    const upd = await client.query(`UPDATE deals SET status = $1, updated_at = now() WHERE id = $2 AND status = $3 RETURNING id`, [DEAL_STATUS.ITEM_SENT, id, DEAL_STATUS.DEPOSIT_CONFIRMED]);
    if (upd.rowCount === 0) {
      await client.query('ROLLBACK');
      return { success: false, message: `concurrent_transition` };
    }
    await client.query('COMMIT');
    // best-effort side effects after commit
    try {
      const { addDealMessage } = await import('./dealService');
      await addDealMessage(id, 0, `Tizim: Sotuvchi yetkazdi (Deal #${id}) — xaridor ilovada qabulni tasdiqlang.`);
    } catch (e) { logger.warn(`markItemSent system message failed #${id}`, e); }
    const buyerId = Number(deal.buyer_telegram_id);
    if (buyerId) {
      try {
        await notify.shippedToBuyer(buyerId, dealLike({ id, amount: String(deal.amount), asset: String(deal.asset), terms: deal.terms }));
      } catch (e) {
        logger.warn(`markItemSent notify failed for #${id}`, e);
      }
    }
    logger.info(`Deal #${id} marked ITEM_SENT by seller ${sellerTelegramId}`);
    return { success: true, message: `Yetkazildi deb belgilandi — xaridor xabardor qilindi.`, status: DEAL_STATUS.ITEM_SENT };
  } catch (e) {
    try { await client.query('ROLLBACK'); } catch {}
    logger.error(`markItemSent failed for #${id}`, e);
    return { success: false, message: String((e as Error).message || 'internal_error') };
  } finally {
    client.release();
  }
}

/**
 * Buyer approves receipt — moves ITEM_SENT -> RELEASED.
 * MONEY MODEL: sellerNet = amount (price), fee = amount * feeBps / 10000 (on top, paid by buyer).
 * FIX 2.1: transactional FOR UPDATE + guarded UPDATE to prevent double-payout.
 */
export async function buyerApproveReceipt(buyerTelegramId: number, dealId: number | string) {
  const id = Number(dealId);
  const client = await db.connect();
  try {
    await client.query('BEGIN');
    const locked = await client.query('SELECT * FROM deals WHERE id = $1 FOR UPDATE', [id]);
    const deal = locked.rows[0];
    if (!deal) {
      await client.query('ROLLBACK');
      return { success: false, message: 'Bitim topilmadi' };
    }
    const isBuyer = deal.buyer_telegram_id != null && Number(deal.buyer_telegram_id) === buyerTelegramId;
    if (!isBuyer) {
      await client.query('ROLLBACK');
      return { success: false, message: `Faqat xaridor qabulni tasdiqlab pulni chiqara oladi.` };
    }
    const allowed = [DEAL_STATUS.ITEM_SENT];
    if (!allowed.includes(deal.status as any)) {
      if (deal.status === DEAL_STATUS.DEPOSIT_CONFIRMED) {
        await client.query('ROLLBACK');
        return { success: false, message: `Deal #${id} "DEPOSIT_CONFIRMED" holatda — avval sotuvchi "Yetkazdim" ni bosishi shart, keyin chiqarish mumkin.`, needItemSent: true } as any;
      }
      if (deal.status === DEAL_STATUS.BUYER_CONFIRMED) {
        logger.warn(`buyerApproveReceipt legacy BUYER_CONFIRMED for deal #${id}`);
      } else {
        await client.query('ROLLBACK');
        return { success: false, message: `Deal #${id} "${deal.status}" holatda — faqat ITEM_SENT dan tasdiqlash mumkin (sotuvchi avval yuborishi shart).` };
      }
    }
    if (deal.seller_telegram_id == null) {
      await client.query('ROLLBACK');
      return { success: false, message: `Sotuvchi hali qo'shilmagan — chiqarib bo'lmaydi.` };
    }
    // Record buyer confirmation inside transaction
    try {
      const confirmations: Record<string, boolean> = { ...(deal.confirmations || {}), buyer: true };
      await client.query('UPDATE deals SET confirmations = $1::jsonb, updated_at = now() WHERE id = $2', [JSON.stringify(confirmations), id]);
    } catch (e) {
      logger.warn(`setConfirmation failed for #${id}`, e);
    }

    const assetUpper = String(deal.asset || 'TON').toUpperCase();
    const amountStr = String(deal.amount ?? '0');
    let sellerHuman = amountStr;
    let feeHuman = '0';
    let feeBase = 0n;
    try {
      const parts = feeParts(amountStr, assetUpper, (deal as any).fee_bps ?? config.feeBps ?? 100);
      sellerHuman = parts.sellerHuman;
      feeHuman = parts.feeHuman;
      feeBase = parts.feeBase;
    } catch (e) {
      logger.warn(`Fee calc failed for deal #${id}`, e);
    }

    const payoutAddress = await resolvePayoutAddress(deal, undefined, deal.seller_telegram_id != null ? Number(deal.seller_telegram_id) : null);
    if (!payoutAddress) {
      await client.query('ROLLBACK');
      const msg = `seller_ton_address_required: sotuvchi TON manzilni ilovada kiritishi shart (Bitim → To'lov manzili yoki Profil → TON manzil)`;
      try {
        const sellerId = Number(deal.seller_telegram_id);
        if (sellerId) {
          await notify.adminDecisionToParty(sellerId, dealLike({ id, amount: amountStr, asset: assetUpper, terms: deal.terms }), `To'lov manzilingizni kiriting (Deal #${id})`);
        }
      } catch {}
      try {
        const { addDealMessage } = await import('./dealService');
        await addDealMessage(id, 0, `Tizim: Xaridor qabul qildi (Deal #${id}), lekin sotuvchi to'lov manzili yo'q — sotuvchi ilovada manzilni kiriting.`);
      } catch {}
      logger.warn(`buyerApproveReceipt #${id}: missing payout address`);
      return { success: false, message: msg, needSellerAddress: true } as any;
    }

    const memoPlainBase = releaseComment({ id, amount: amountStr, asset: assetUpper, terms: String(deal.terms || '') });
    let memoPlain = memoPlainBase;
    if (memoPlain.length > 120) memoPlain = memoPlain.slice(0, 119) + '…';
    const encryptedMemo = encryptField(memoPlain);

    try {
      if (assetUpper === 'TON') {
        await sendTon({ to: payoutAddress, value: sellerHuman, comment: encryptedMemo, bounce: false });
        logger.info(`Custodial RELEASED deal #${id} seller ${sellerHuman} TON to ${payoutAddress} fee ${feeHuman}`);
        if (feeBase > 0n && config.feeAddress && feeHuman !== '0') {
          try {
            const feeMemo = encryptField(`Fee for Escrow #${id} — ${feeHuman} ${assetUpper}`);
            await sendTon({ to: config.feeAddress, value: feeHuman, comment: feeMemo, bounce: false });
          } catch (feeErr) {
            logger.warn(`Fee payout failed for deal #${id}`, feeErr);
          }
        }
      } else {
        const jettonMaster = config.jettonMasterAddress || config.usdtJettonAddress;
        if (!jettonMaster) throw new Error('jetton_master_not_configured: set JETTON_MASTER_ADDRESS or USDT_JETTON_ADDRESS');
        await sendJetton({ jettonMasterAddress: jettonMaster, to: payoutAddress, amount: sellerHuman, forwardComment: encryptedMemo, forwardTonAmount: '0.01' });
        logger.info(`Custodial RELEASED deal #${id} seller ${sellerHuman} ${assetUpper} to ${payoutAddress} fee ${feeHuman}`);
        if (feeBase > 0n && config.feeAddress && feeHuman !== '0') {
          try {
            const feeMemo = encryptField(`Fee for Escrow #${id} — ${feeHuman} ${assetUpper}`);
            await sendJetton({ jettonMasterAddress: jettonMaster, to: config.feeAddress, amount: feeHuman, forwardComment: feeMemo, forwardTonAmount: '0.01' });
          } catch (feeErr) {
            logger.warn(`Jetton fee payout failed for deal #${id}`, feeErr);
          }
        }
      }
    } catch (e) {
      await client.query('ROLLBACK');
      const msg = String((e as Error).message || '');
      logger.error(`buyerApproveReceipt payout failed for deal #${id}`, e);
      await notifyAdminsHub(`Deal #${id} to'lov xatosi: ${msg} — ${sellerHuman} manzil ${payoutAddress}.`, sellerHuman, assetUpper);
      return { success: false, message: msg.startsWith('payout_failed') ? msg : `payout_failed: to'lov yuborilmadi: ${msg}` };
    }

    const upd = await client.query(`UPDATE deals SET status = $1, updated_at = now(), resolved_at = now() WHERE id = $2 AND status = $3 RETURNING id`, [DEAL_STATUS.RELEASED, id, deal.status]);
    if (upd.rowCount === 0) {
      await client.query('ROLLBACK');
      return { success: false, message: `concurrent_transition: deal status changed` };
    }
    await client.query('COMMIT');
    // Post-commit side effects (best-effort)
    try {
      const { addDealMessage } = await import('./dealService');
      await addDealMessage(id, 0, `Tizim: Yakunlandi (Deal #${id}) — ${sellerHuman} ${assetUpper} sotuvchiga yuborildi (komissiya ${feeHuman} ${assetUpper}).`);
    } catch (e) { logger.warn(`buyerApproveReceipt system message failed #${id}`, e); }
    try {
      await notify.releasedToBuyer(Number(deal.buyer_telegram_id), dealLike({ id, amount: amountStr, asset: assetUpper, terms: deal.terms }));
    } catch (e) {
      logger.warn(`releasedToBuyer notify failed for #${id}`, e);
    }
    try {
      await notify.releasedToSeller(Number(deal.seller_telegram_id), dealLike({ id, amount: amountStr, asset: assetUpper, terms: deal.terms }), sellerHuman);
    } catch (e) {
      logger.warn(`releasedToSeller notify failed for #${id}`, e);
    }
    logger.info(`Deal #${id} RELEASED by buyer ${buyerTelegramId} approval (seller ${sellerHuman}, fee ${feeHuman})`);
    return { success: true, message: `Qabul qilindi — pul sotuvchiga chiqarildi (komissiya chegirilgan). Bitim yopildi.`, released: true, status: DEAL_STATUS.RELEASED };
  } catch (e) {
    try { await client.query('ROLLBACK'); } catch {}
    logger.error(`buyerApproveReceipt failed for #${id}`, e);
    return { success: false, message: String((e as Error).message || 'internal_error') };
  } finally {
    client.release();
  }
}

// ── CHANNEL/GROUP custodial escrow (via @gramchioka) ──
// P2P flow untouched — these helpers only run when deal.deal_type in (CHANNEL,GROUP)
const ESCROW_HOLDER_USERNAME = process.env.ESCROW_HOLDER_USERNAME || '@gramchioka';
const ESCROW_HOLDER_ID = Number(process.env.ESCROW_HOLDER_ID || 8992814642);

function isChannelDeal(deal: any): boolean {
  const t = String(deal?.deal_type || deal?.dealType || 'P2P').toUpperCase();
  return t === 'CHANNEL' || t === 'GROUP';
}

async function ubotFetch(path: string, init?: RequestInit): Promise<any> {
  const base = (config as any).ubotUrl || process.env.UBOT_URL || 'http://ubot:3002';
  const key = (config as any).ubotApiKey || process.env.UBOT_API_KEY || '';
  const headers: Record<string,string> = { 'Content-Type':'application/json' };
  if (key) headers['x-api-key']=key;
  const url = base.replace(/\/+$/,'') + path;
  const res = await fetch(url, { ...init, headers:{ ...headers, ...(init?.headers as any||{}) } } as any);
  const txt = await res.text();
  let data:any = txt; try{ data=txt?JSON.parse(txt):null;}catch{}
  if (!res.ok) {
    const err: any = new Error(data?.error || txt || `ubot ${res.status}`);
    err.status = res.status; err.body = data;
    if (data?.retryAfter) err.retryAfter = data.retryAfter;
    throw err;
  }
  return data;
}

export async function verifyChannelOwnershipForDeal(dealId: number | string, sellerTelegramId?: number | null): Promise<{ ok:boolean; verified:boolean; channelId?:string; title?:string; username?:string; members?:number; error?:string; }> {
  const deal:any = await getDealById(dealId);
  if (!deal) return { ok:false, verified:false, error:'deal_not_found' };
  if (!isChannelDeal(deal)) return { ok:false, verified:false, error:'not_channel_deal' };
  const rawUsername = deal.channel_username || deal.channelUsername;
  if (!rawUsername) return { ok:false, verified:false, error:'channel_username_required' };
  const channelId = rawUsername as string;
  try {
    const info: any = await ubotFetch(`/channel/${encodeURIComponent(String(channelId))}`, { method:'GET' });
    const admins: any = await ubotFetch(`/channel/${encodeURIComponent(String(channelId))}/admins`, { method:'GET' });
    const creator = Array.isArray(admins) ? admins.find((a:any)=> a.isCreator) : null;
    const creatorId = creator ? Number(creator.id) : null;
    const expected = sellerTelegramId != null ? Number(sellerTelegramId) : Number(deal.seller_telegram_id);
    const verified = creatorId != null && expected != null && creatorId === expected;
    const snapshot = { title: info.title, username: info.username, channelId: String(info.id), isChannel: info.isChannel, creatorId, verifiedAt: new Date().toISOString() };
    const { updateChannelVerification } = await import('./dealService');
    await updateChannelVerification(Number(dealId), { channelId: String(info.id), channelTitle: String(info.title||''), channelSnapshot: snapshot as any, verified });
    try {
      const { addDealMessage } = await import('./dealService');
      if (verified) await addDealMessage(Number(dealId), 0, `Tizim: Kanal ${rawUsername} tasdiqlandi — ega ${creatorId} sotuvchi ${expected} ga mos.`);
      else await addDealMessage(Number(dealId), 0, `Tizim: Kanal ${rawUsername} mos kelmadi: yaratuvchi ${creatorId ?? "noma'lum"} va sotuvchi ${expected}. @gramchioka admin ekanini va sotuvchi yaratuvchi ekanini tekshiring.`);
    } catch {}
    return { ok:true, verified, channelId: String(info.id), title: info.title, username: info.username, error: verified ? undefined : 'owner_mismatch' };
  } catch (e:any) {
    const msg = String(e?.message||e);
    if (msg.includes('FLOOD_WAIT') || msg.includes('429') || msg.includes('FloodWait')) {
      return { ok:false, verified:false, error: msg };
    }
    return { ok:false, verified:false, error: msg };
  }
}

export async function checkEscrowHolderOwnership(dealId: number | string): Promise<{ ok:boolean; isEscrowOwner:boolean; currentCreatorId?: number; error?:string }> {
  const deal:any = await getDealById(dealId);
  if (!deal) return { ok:false, isEscrowOwner:false, error:'deal_not_found' };
  if (!isChannelDeal(deal)) return { ok:false, isEscrowOwner:false, error:'not_channel_deal' };
  const channelId = deal.channel_username || deal.channel_id;
  if (!channelId) return { ok:false, isEscrowOwner:false, error:'channel_username_required' };
  try {
    const admins: any = await ubotFetch(`/channel/${encodeURIComponent(String(channelId))}/admins`, { method:'GET' });
    const creator = Array.isArray(admins) ? admins.find((a:any)=> a.isCreator) : null;
    const creatorId = creator ? Number(creator.id) : null;
    const isEscrowOwner = creatorId === ESCROW_HOLDER_ID;
    if (isEscrowOwner) {
      const { setTransferToEscrow } = await import('./dealService');
      await setTransferToEscrow(Number(dealId));
      try { const { addDealMessage } = await import('./dealService'); await addDealMessage(Number(dealId), 0, `Tizim: Escrow ${channelId} kanalni qabul qildi — ${ESCROW_HOLDER_USERNAME} endi ega.`);} catch {}
    }
    return { ok:true, isEscrowOwner, currentCreatorId: creatorId ?? undefined };
  } catch (e:any) {
    return { ok:false, isEscrowOwner:false, error: String(e?.message||e) };
  }
}

export async function requestTransferToEscrow(dealId: number | string, sellerTelegramId: number): Promise<{ ok:boolean; message?:string; error?:string }> {
  const deal:any = await getDealById(dealId);
  if (!deal) return { ok:false, error:'deal_not_found' };
  if (Number(deal.seller_telegram_id) !== Number(sellerTelegramId)) return { ok:false, error:'only_seller_can_transfer' };
  if (String(deal.status) !== DEAL_STATUS.DEPOSIT_CONFIRMED && String(deal.status) !== DEAL_STATUS.AWAITING_DEPOSIT) return { ok:false, error:`invalid_status ${deal.status} need DEPOSIT_CONFIRMED` };
  const channelId = deal.channel_username || deal.channel_id;
  try {
    const { addDealMessage } = await import('./dealService');
    await addDealMessage(Number(dealId), 0, `Tizim: Sotuvchi ${channelId} egaligini hozir ${ESCROW_HOLDER_USERNAME} ga o'tkazing. O'tkazgach "O'tkazdim" ni bosing.`);
    try {
      await notify.adminDecisionToParty(Number(sellerTelegramId), dealLike({ id: Number(dealId), amount: String(deal.amount ?? ''), asset: String(deal.asset ?? 'TON'), terms: deal.terms }), `Kanal ${channelId} ni ${ESCROW_HOLDER_USERNAME} ga o'tkazing`);
    } catch {}
    return { ok:true, message:'transfer_requested' };
  } catch (e:any) { return { ok:false, error: String(e?.message||e)}; }
}

export async function confirmTransferToEscrow(sellerTelegramId: number, dealId: number | string): Promise<{ ok:boolean; verified?:boolean; message?:string; error?:string }> {
  const res = await checkEscrowHolderOwnership(dealId);
  if (!res.ok) return { ok:false, error: res.error };
  if (!res.isEscrowOwner) return { ok:false, verified:false, error:`not_yet_transferred: current creator ${res.currentCreatorId} != escrow ${ESCROW_HOLDER_ID}` };
  return { ok:true, verified:true, message:'escrow_received' };
}

export async function payoutSellerForChannel(dealId: number | string, sellerTelegramId?: number | null): Promise<{ success:boolean; message?:string; error?:string }> {
  const deal:any = await getDealById(dealId);
  if (!deal) return { success:false, error:'deal_not_found' };
  if (!isChannelDeal(deal)) return { success:false, error:'not_channel_deal' };
  if (!deal.transfer_to_escrow_at) return { success:false, error:'escrow_not_yet_received' };
  if (String(deal.status) === DEAL_STATUS.RELEASED || String(deal.status) === DEAL_STATUS.REFUNDED) return { success:false, error:`already_${String(deal.status).toLowerCase()}` };
  try {
    await guardedTransition(Number(dealId), DEAL_STATUS.RELEASED, { amount: deal.amount, asset: deal.asset, terms: deal.terms });
    try { const { addDealMessage } = await import('./dealService'); await addDealMessage(Number(dealId), 0, `Tizim: Sotuvchiga to'lov yuborildi (${deal.channel_username}) — ${deal.amount} ${deal.asset} (komissiya chegirilgan).`);} catch {}
    return { success:true, message:'payout_sent' };
  } catch (e:any) {
    return { success:false, error: String(e?.message||e) };
  }
}

export async function transferChannelToBuyer(dealId: number | string, newOwnerUsername: string, callerTelegramId?: number | null): Promise<{ ok:boolean; error?:string; detail?:string }> {
  const deal:any = await getDealById(dealId);
  if (!deal) return { ok:false, error:'deal_not_found' };
  if (!isChannelDeal(deal)) return { ok:false, error:'not_channel_deal' };
  if (String(deal.status) !== DEAL_STATUS.RELEASED) return { ok:false, error:`invalid_status ${deal.status} need RELEASED (seller already paid)` };
  const channelId = deal.channel_username || deal.channel_id;
  if (!channelId) return { ok:false, error:'channel_username_required' };
  const raw = String(newOwnerUsername).trim().replace(/^@/, '');
  if (!raw || !/^([A-Za-z0-9_]{4,32})$/.test(raw)) return { ok:false, error:'invalid_username' };
  const target = '@' + raw;
  try { await ubotFetch(`/channel/${encodeURIComponent(String(channelId))}/invite`, { method:'POST', body: JSON.stringify({ userId: target })}); } catch {}
  await new Promise(r=> setTimeout(r, 1200));
  try {
    const idemp = `channel-deal-${dealId}-${target}`;
    const res: any = await ubotFetch(`/channel/${encodeURIComponent(String(channelId))}/takeover`, { method:'POST', body: JSON.stringify({ newOwnerId: target }), headers:{ 'x-idempotency-key': idemp }});
    const { setTransferToBuyer } = await import('./dealService');
    await setTransferToBuyer(Number(dealId), target);
    try { const { addDealMessage } = await import('./dealService'); await addDealMessage(Number(dealId), 0, `Tizim: Kanal ${channelId} yangi ega ${target} ga o'tkazildi.`);} catch {}
    return { ok:true };
  } catch (e:any) {
    const msg = String(e?.message||e);
    if (msg.includes('USER_NOT_PARTICIPANT')) return { ok:false, error:'user_not_participant_try_invite', detail: msg };
    if (msg.includes('FRESH_CHANGE_ADMINS_FORBIDDEN') || msg.includes('86400')) return { ok:false, error:'fresh_forbidden_wait_24h', detail: msg };
    if (msg.includes('CHANNELS_TOO_MUCH')) return { ok:false, error:'channels_too_much', detail: msg };
    if (msg.includes('not_admin') || msg.includes('CHAT_ADMIN_REQUIRED')) return { ok:false, error:'not_admin', detail: msg };
    if (String(deal.deal_type).toUpperCase()==='GROUP') {
      try {
        const idemp = `group-deal-${dealId}-${target}`;
        await ubotFetch(`/group/${encodeURIComponent(String(channelId))}/takeover`, { method:'POST', body: JSON.stringify({ newOwnerId: target }), headers:{ 'x-idempotency-key': idemp }});
        const { setTransferToBuyer } = await import('./dealService');
        await setTransferToBuyer(Number(dealId), target);
        return { ok:true };
      } catch (e2:any) { return { ok:false, error: String(e2?.message||e2) } }
    }
    return { ok:false, error: msg };
  }
}
