// src/services/dealService.ts
import { db } from '../db/queries';
import { v4 as uuidv4 } from 'uuid';
import { QueryResult } from 'pg';

/** Canonical deal status strings. */
export const DEAL_STATUS = {
  AWAITING_DEPOSIT: 'AWAITING_DEPOSIT',
  DEPOSIT_CONFIRMED: 'DEPOSIT_CONFIRMED',
  BUYER_CONFIRMED: 'BUYER_CONFIRMED',
  RELEASED: 'RELEASED',
  REFUNDED: 'REFUNDED',
} as const;

const FINAL_STATUSES = new Set<string>([DEAL_STATUS.RELEASED, DEAL_STATUS.REFUNDED]);

/** Create a new deal record with optional role telegram IDs */
export async function createDealRecord(params: {
  buyerId?: number | null;
  sellerId?: number | null;
  buyerTelegramId?: number | null;
  sellerTelegramId?: number | null;
  asset: string;
  amount: number;
  feeBps: number;
  status: string;
  contractAddress?: string;
  paymentAddress?: string;
  terms?: string;
  deadline?: Date | null;
}) {
  const {
    buyerId = null,
    sellerId = null,
    buyerTelegramId = null,
    sellerTelegramId = null,
    asset,
    amount,
    feeBps,
    status,
    contractAddress = '',
    paymentAddress = '',
    terms = '',
    deadline = null,
  } = params;

  const feeAmount = (amount * feeBps) / 10000; // feeBps in basis points (100 = 1%)

  const res: QueryResult = await db.query(
    `INSERT INTO deals (
        buyer_id,
        seller_id,
        buyer_telegram_id,
        seller_telegram_id,
        asset,
        amount,
        fee_bps,
        fee_amount,
        status,
        contract_address,
        payment_address,
        terms,
        deadline,
        created_at
      ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,now()) RETURNING *`,
    [
      buyerId,
      sellerId,
      buyerTelegramId,
      sellerTelegramId,
      asset,
      amount,
      feeBps,
      feeAmount,
      status,
      contractAddress,
      paymentAddress,
      terms,
      deadline,
    ]
  );
  return res.rows[0];
}

export async function getDealById(id: number | string) {
  const res = await db.query('SELECT * FROM deals WHERE id = $1 LIMIT 1', [Number(id)]);
  return res.rows[0] || null;
}

/** Update deal status; writes tx_hash when provided and stamps resolved_at on final statuses. */
export async function updateDealStatus(dealId: number | string, status: string, txHash?: string) {
  const id = Number(dealId);
  const sets: string[] = ['status = $1'];
  const params: unknown[] = [status];
  if (txHash) {
    params.push(txHash);
    sets.push(`tx_hash = $${params.length}`);
  }
  if (FINAL_STATUSES.has(status)) {
    sets.push('resolved_at = now()');
  }
  sets.push('updated_at = now()');
  params.push(id);
  await db.query(`UPDATE deals SET ${sets.join(', ')} WHERE id = $${params.length}`, params);
}

/** Generate a one-time link token for a deal */
export async function generateDealLink(dealId: number, ttlSeconds: number = 86400) {
  const token = uuidv4();
  const expiresAt = new Date(Date.now() + ttlSeconds * 1000);
  await db.query(
    `INSERT INTO deal_links (deal_id, token, expires_at) VALUES ($1,$2,$3)`,
    [dealId, token, expiresAt]
  );
  return token;
}

/** Validate a deal link and return the associated unexpired deal (or null). */
export async function validateDealLink(token: string) {
  const res = await db.query(
    `SELECT d.* FROM deal_links dl JOIN deals d ON dl.deal_id = d.id
     WHERE dl.token = $1 AND dl.expires_at > now()`,
    [token]
  );
  return res.rows[0] || null;
}

export async function getDealLink(token: string) {
  const res = await db.query('SELECT * FROM deal_links WHERE token = $1 LIMIT 1', [token]);
  return res.rows[0] || null;
}

/** Consume a link after successful join. */
export async function markDealLinkUsed(token: string) {
  await db.query('DELETE FROM deal_links WHERE token = $1', [token]);
}

/** Assign role telegram ID to a deal after link validation */
export async function assignRoleToDeal(dealId: number | string, role: 'buyer' | 'seller', telegramId: number) {
  const column = role === 'buyer' ? 'buyer_telegram_id' : 'seller_telegram_id';
  await db.query(`UPDATE deals SET ${column} = $1, updated_at = now() WHERE id = $2`, [telegramId, Number(dealId)]);
}

/** Record a party confirmation in the confirmations JSONB column. */
export async function setConfirmation(dealId: number | string, party: 'buyer' | 'seller', confirmations: Record<string, boolean>) {
  await db.query(
    'UPDATE deals SET confirmations = $1::jsonb, updated_at = now() WHERE id = $2',
    [JSON.stringify(confirmations), Number(dealId)]
  );
}

/** Retrieve chat messages for a deal */
export async function getDealMessages(dealId: number, limit: number = 100) {
  const res = await db.query(
    `SELECT sender_telegram_id, content, created_at FROM messages WHERE deal_id = $1 ORDER BY created_at DESC LIMIT $2`,
    [dealId, limit]
  );
  return res.rows;
}

/** Add a message to a deal chat */
export async function addDealMessage(dealId: number, senderTelegramId: number, content: string) {
  await db.query(
    `INSERT INTO messages (deal_id, sender_telegram_id, content) VALUES ($1,$2,$3)`,
    [dealId, senderTelegramId, content]
  );
}

/** Cleanup expired deal links */
export async function purgeExpiredLinks() {
  await db.query('DELETE FROM deal_links WHERE expires_at < now()');
}
