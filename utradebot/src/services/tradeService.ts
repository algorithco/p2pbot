import * as db from '../db/queries';
import logger from '../logger';
import { encryptSession } from './sessionCrypto';

export type TradeStatus =
  | 'PENDING_SESSION'
  | 'SELLER_REMOVED'
  | 'AWAITING_PAYMENT'
  | 'PHONE_SHARED'
  | 'AWAITING_CODE'
  | 'AWAITING_BUYER_LOGIN'
  | 'COMPLETED'
  | 'FAILED'
  | 'CANCELLED';

export async function createTradeWithSession(
  sellerTelegramId: number,
  sessionPlainOrEnc: string,
  phone?: string | null,
): Promise<number> {
  // Ensure session is encrypted before storage
  // If input looks already encrypted (base64 with iv+tag), keep it; else encrypt
  let enc: string;
  // Heuristic: if input contains spaces or length < 50, it's phone+code path not session — should have been handled earlier
  // We assume caller passes StringSession string (plain) or already encrypted
  try {
    // Try to detect if already encrypted: base64 length and looks like iv+tag
    const maybeDec = sessionPlainOrEnc.trim();
    // If it contains spaces (24 words?) it's not session — error
    if (maybeDec.split(' ').length === 24) throw new Error('mnemonic_not_allowed');
    // Simple: encrypt if not already encrypted form (we can't reliably detect, so encrypt if not base64 with tag)
    // For safety, always encrypt via encryptSession which handles plain vs enc
    enc = encryptSession(maybeDec);
  } catch (e) {
    throw new Error(`invalid_session: ${String((e as Error).message || e)}`);
  }

  const row = await db.createTrade({
    sellerTelegramId,
    sessionEncrypted: enc,
    phone: phone || null,
    status: 'SELLER_REMOVED',
  });
  await db.appendEvent(row.id, sellerTelegramId, 'created', { phone: phone ? 'set' : 'null' });
  return row.id;
}

export async function confirmPayment(tradeId: number, sellerId: number): Promise<void> {
  const trade = await db.getTrade(tradeId);
  if (!trade) throw new Error('trade_not_found');
  if (Number(trade.seller_telegram_id) !== sellerId) throw new Error('not_seller');
  const status = String(trade.status);
  if (!['SELLER_REMOVED', 'AWAITING_PAYMENT'].includes(status)) {
    throw new Error(`invalid_status_for_confirm: ${status}`);
  }
  // Phone must be known — if not, derive from session (best-effort)
  await db.updateTradeStatus(tradeId, 'PHONE_SHARED');
  await db.appendEvent(tradeId, sellerId, 'payment_confirmed');
}

export async function sharePhone(tradeId: number, phone: string, sellerId: number): Promise<void> {
  const trade = await db.getTrade(tradeId);
  if (!trade) throw new Error('trade_not_found');
  if (Number(trade.seller_telegram_id) !== sellerId) throw new Error('not_seller');
  await db.setPhone(tradeId, phone);
  await db.updateTradeStatus(tradeId, 'PHONE_SHARED');
  await db.appendEvent(tradeId, sellerId, 'phone_shared', { phone: phone.slice(0, 3) + '****' });
}

export async function bindBuyer(tradeId: number, buyerId: number): Promise<void> {
  const trade = await db.getTrade(tradeId);
  if (!trade) throw new Error('trade_not_found');
  if (trade.buyer_telegram_id && Number(trade.buyer_telegram_id) !== buyerId) {
    throw new Error('buyer_already_set');
  }
  await db.setBuyer(tradeId, buyerId);
  await db.updateTradeStatus(tradeId, 'AWAITING_CODE');
  await db.appendEvent(tradeId, buyerId, 'buyer_bound');
}

export async function markAwaitingBuyerLogin(tradeId: number): Promise<void> {
  await db.updateTradeStatus(tradeId, 'AWAITING_BUYER_LOGIN');
}

export async function completeTrade(tradeId: number, buyerId: number): Promise<void> {
  await db.updateTradeStatus(tradeId, 'COMPLETED');
  await db.appendEvent(tradeId, buyerId, 'completed');
  logger.info(`Trade #${tradeId} completed`);
}

export async function failTrade(tradeId: number, reason: string, actorId?: number): Promise<void> {
  await db.updateTradeStatus(tradeId, 'FAILED', { meta: JSON.stringify({ fail_reason: reason }) });
  await db.appendEvent(tradeId, actorId || null, 'failed', { reason });
}

export async function cancelTrade(tradeId: number, actorId: number): Promise<void> {
  const trade = await db.getTrade(tradeId);
  if (!trade) throw new Error('trade_not_found');
  if (Number(trade.seller_telegram_id) !== actorId && !isAdmin(actorId)) {
    throw new Error('not_authorized_to_cancel');
  }
  await db.updateTradeStatus(tradeId, 'CANCELLED');
  await db.appendEvent(tradeId, actorId, 'cancelled');
}

function isAdmin(id: number): boolean {
  const admins = (process.env.ADMIN_TELEGRAM_IDS || '').split(',').map(Number).filter(Boolean);
  return admins.includes(id);
}

export async function getActiveTradeForUser(telegramId: number) {
  return db.getActiveTradeForUser(telegramId);
}
