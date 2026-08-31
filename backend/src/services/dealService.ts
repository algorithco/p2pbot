// src/services/dealService.ts
import { db } from '../db/queries';
import { v4 as uuidv4 } from 'uuid';
import { QueryResult } from 'pg';
import {
  generateDealChatKey,
  encryptDealKey,
  decryptDealKey,
  encryptWithDealKey,
} from '../utils/encryption';

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

  // Generate per-deal E2E chat key (32 bytes base64, encrypted at rest if ENCRYPTION_KEY set)
  const chatKeyPlain = generateDealChatKey();
  const chatKeyStored = encryptDealKey(chatKeyPlain);

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
        chat_key,
        chat_key_created_at,
        created_at
      ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,now(),now()) RETURNING *`,
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
      chatKeyStored,
    ]
  );
  return res.rows[0];
}

export async function getDealById(id: number | string) {
  const res = await db.query('SELECT * FROM deals WHERE id = $1 LIMIT 1', [Number(id)]);
  return res.rows[0] || null;
}

/** Get plaintext per-deal chat key (only for parties/admin). Returns null if not found. */
export async function getDealChatKey(dealId: number | string): Promise<string | null> {
  const deal = await getDealById(dealId);
  if (!deal || !deal.chat_key) {
    // Backfill: generate & persist if missing (legacy deals)
    const newKey = generateDealChatKey();
    const enc = encryptDealKey(newKey);
    await db.query('UPDATE deals SET chat_key = $1, chat_key_created_at = now(), updated_at = now() WHERE id = $2', [enc, Number(dealId)]);
    return newKey;
  }
  return decryptDealKey(String(deal.chat_key));
}

/** Ensure a deal has a chat_key, return plaintext. */
export async function ensureDealChatKey(dealId: number | string): Promise<string> {
  const k = await getDealChatKey(dealId);
  if (!k) throw new Error('chat_key_unavailable');
  return k;
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

/** Assign role telegram ID to a deal after link validation — guarded: only if slot is empty */
export async function assignRoleToDeal(dealId: number | string, role: 'buyer' | 'seller', telegramId: number) {
  const column = role === 'buyer' ? 'buyer_telegram_id' : 'seller_telegram_id';
  const res = await db.query(
    `UPDATE deals SET ${column} = $1, updated_at = now() WHERE id = $2 AND ${column} IS NULL RETURNING id`,
    [telegramId, Number(dealId)]
  );
  if (res.rowCount === 0) {
    const deal = await getDealById(dealId);
    if (!deal) throw new Error('deal_not_found');
    throw new Error('deal_already_full');
  }
}

/** Atomic join: assign role + consume link in a transaction to prevent race */
export async function atomicJoinDeal(dealId: number, token: string, telegramId: number): Promise<'buyer' | 'seller'> {
  const client = await db.connect();
  try {
    await client.query('BEGIN');
    // Lock deal row
    const dealRes = await client.query('SELECT buyer_telegram_id, seller_telegram_id FROM deals WHERE id = $1 FOR UPDATE', [dealId]);
    if (dealRes.rows.length === 0) throw new Error('deal_not_found');
    const deal = dealRes.rows[0];
    const linkRes = await client.query('SELECT * FROM deal_links WHERE token = $1 AND deal_id = $2 AND expires_at > now() FOR UPDATE', [token, dealId]);
    if (linkRes.rows.length === 0) throw new Error('invalid_token');
    let role: 'buyer' | 'seller';
    if (deal.buyer_telegram_id == null) role = 'buyer';
    else if (deal.seller_telegram_id == null) role = 'seller';
    else throw new Error('deal_already_full');
    const col = role === 'buyer' ? 'buyer_telegram_id' : 'seller_telegram_id';
    await client.query(`UPDATE deals SET ${col} = $1, updated_at = now() WHERE id = $2`, [telegramId, dealId]);
    await client.query('DELETE FROM deal_links WHERE token = $1', [token]);
    await client.query('COMMIT');
    return role;
  } catch (e) {
    await client.query('ROLLBACK');
    throw e;
  } finally {
    client.release();
  }
}

/** Record a party confirmation in the confirmations JSONB column. */
export async function setConfirmation(dealId: number | string, party: 'buyer' | 'seller', confirmations: Record<string, boolean>) {
  await db.query(
    'UPDATE deals SET confirmations = $1::jsonb, updated_at = now() WHERE id = $2',
    [JSON.stringify(confirmations), Number(dealId)]
  );
}

/** Retrieve chat messages for a deal — returns ciphertext-aware rows */
export async function getDealMessages(dealId: number, limit: number = 100) {
  const res = await db.query(
    `SELECT id, deal_id, sender_telegram_id, content, encrypted_content, is_encrypted, created_at
     FROM messages WHERE deal_id = $1 ORDER BY created_at ASC LIMIT $2`,
    [dealId, limit]
  );
  return res.rows;
}

/** Add a message to a deal chat (legacy plaintext path — encrypts at rest if ENCRYPTION_KEY set) */
export async function addDealMessage(dealId: number, senderTelegramId: number, content: string) {
  const chatKey = await getDealChatKey(dealId);
  if (chatKey) {
    // E2E encrypt with per-deal key so DB never sees plaintext
    const encrypted = encryptWithDealKey(content, chatKey);
    await db.query(
      `INSERT INTO messages (deal_id, sender_telegram_id, content, encrypted_content, is_encrypted) VALUES ($1,$2,$3,$4,true)`,
      [dealId, senderTelegramId, '', encrypted]
    );
  } else {
    await db.query(
      `INSERT INTO messages (deal_id, sender_telegram_id, content) VALUES ($1,$2,$3)`,
      [dealId, senderTelegramId, content]
    );
  }
}

/** Add an already-encrypted message (ciphertext from client) — SERVER NEVER SEES PLAINTEXT */
export async function addEncryptedMessage(dealId: number, senderTelegramId: number, encryptedContentB64: string) {
  if (!encryptedContentB64 || typeof encryptedContentB64 !== 'string' || encryptedContentB64.length < 10) {
    throw new Error('invalid_ciphertext');
  }
  // Basic base64 validation + length check (iv 12 + tag 16 + at least 1 byte)
  let buf: Buffer;
  try {
    buf = Buffer.from(encryptedContentB64, 'base64');
    if (buf.length < 28) throw new Error('ciphertext_too_short');
  } catch {
    throw new Error('invalid_ciphertext');
  }
  await db.query(
    `INSERT INTO messages (deal_id, sender_telegram_id, content, encrypted_content, is_encrypted) VALUES ($1,$2,$3,$4,true)`,
    [dealId, senderTelegramId, '', encryptedContentB64]
  );
}

/** Cleanup expired deal links */
export async function purgeExpiredLinks() {
  await db.query('DELETE FROM deal_links WHERE expires_at < now()');
}
