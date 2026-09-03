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
  ITEM_SENT: 'ITEM_SENT',
  BUYER_CONFIRMED: 'BUYER_CONFIRMED',
  RELEASED: 'RELEASED',
  REFUNDED: 'REFUNDED',
} as const;

export const DEAL_TYPE = {
  P2P: 'P2P',
  CHANNEL: 'CHANNEL',
  GROUP: 'GROUP',
} as const;

const FINAL_STATUSES = new Set<string>([DEAL_STATUS.RELEASED, DEAL_STATUS.REFUNDED]);

export function normalizeChannelUsername(v: unknown): string | null {
  if (!v) return null;
  let s = String(v).trim();
  if (!s) return null;
  s = s.replace(/^https?:\/\/t\.me\//i, '').replace(/^t\.me\//i, '').replace(/^@/, '').trim();
  s = s.split('/')[0].split('?')[0].trim();
  if (!s) return null;
  if (!/^[@A-Za-z0-9_]{1,64}$/.test(s.startsWith('@') ? s : `@${s}`)) return null;
  return s.startsWith('@') ? s : `@${s}`;
}

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
  dealType?: string; // P2P | CHANNEL | GROUP
  channelUsername?: string | null;
  channelId?: string | null;
  channelTitle?: string | null;
  channelSnapshot?: Record<string, unknown> | null;
  escrowHolderId?: number | null;
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
    dealType = DEAL_TYPE.P2P,
    channelUsername = null,
    channelId = null,
    channelTitle = null,
    channelSnapshot = null,
    escrowHolderId = null,
  } = params;

  const normalizedType = ['P2P','CHANNEL','GROUP'].includes(String(dealType).toUpperCase()) ? String(dealType).toUpperCase() : DEAL_TYPE.P2P;
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
        created_at,
        deal_type,
        channel_username,
        channel_id,
        channel_title,
        channel_snapshot,
        channel_verified,
        escrow_holder_id
      ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,now(),now(),$15,$16,$17,$18,$19::jsonb,false,$20) RETURNING *`,
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
      normalizedType,
      channelUsername,
      channelId,
      channelTitle,
      channelSnapshot ? JSON.stringify(channelSnapshot) : '{}',
      escrowHolderId,
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

/** Build bot deep link for deal invite — t.me bot link, not website */
export function getBotDeepLink(dealId: number | string, token: string, botUsername?: string): string {
  const username = (botUsername || process.env.BOT_USERNAME || 'uzsavdochibot').replace(/^@/, '');
  // Telegram start param max 64 chars, allowed A-Za-z0-9_- ; token is uuid with hyphens, so use join_<id>_<token>
  return `https://t.me/${username}?start=join_${dealId}_${token}`;
}

/** Create a pending join request (for bot approval flow) */
export async function createJoinRequest(params: {
  dealId: number;
  token: string;
  requesterTelegramId: number;
  requesterUsername?: string | null;
  requesterFirstName?: string | null;
  requesterPhotoUrl?: string | null;
}) {
  const { dealId, token, requesterTelegramId, requesterUsername, requesterFirstName, requesterPhotoUrl } = params;
  // Upsert: if same requester already pending for same deal+token, return existing
  const existing = await db.query(
    `SELECT * FROM deal_join_requests WHERE deal_id = $1 AND token = $2 AND requester_telegram_id = $3 AND status = 'pending' LIMIT 1`,
    [dealId, token, requesterTelegramId]
  );
  if (existing.rows[0]) return existing.rows[0];
  const res = await db.query(
    `INSERT INTO deal_join_requests (deal_id, token, requester_telegram_id, requester_username, requester_first_name, requester_photo_url, status)
     VALUES ($1,$2,$3,$4,$5,$6,'pending') RETURNING *`,
    [dealId, token, requesterTelegramId, requesterUsername || null, requesterFirstName || null, requesterPhotoUrl || null]
  );
  return res.rows[0];
}

export async function getJoinRequestById(id: number) {
  const res = await db.query('SELECT * FROM deal_join_requests WHERE id = $1 LIMIT 1', [id]);
  return res.rows[0] || null;
}

export async function getPendingRequest(dealId: number, token: string, requesterId: number) {
  const res = await db.query(
    `SELECT * FROM deal_join_requests WHERE deal_id = $1 AND token = $2 AND requester_telegram_id = $3 AND status = 'pending' LIMIT 1`,
    [dealId, token, requesterId]
  );
  return res.rows[0] || null;
}

export async function updateJoinRequestStatus(id: number, status: 'approved' | 'rejected' | 'pending') {
  await db.query('UPDATE deal_join_requests SET status = $1, updated_at = now() WHERE id = $2', [status, id]);
}

/** Approve a join request — atomic: assign role + consume link + mark request approved
 *  Desired flow: ONLY buyer can approve seller joining. Buyer is creator.
 */
export async function approveJoinRequest(requestId: number, approverTelegramId: number): Promise<'buyer' | 'seller'> {
  const req = await getJoinRequestById(requestId);
  if (!req) throw new Error('request_not_found');
  if (req.status !== 'pending') throw new Error('request_already_handled');
  const deal = await getDealById(req.deal_id);
  if (!deal) throw new Error('deal_not_found');
  // Only the BUYER (creator) can approve — per desired flow: bot asks buyer "Are you trading with this person?"
  const isBuyer = deal.buyer_telegram_id != null && Number(deal.buyer_telegram_id) === approverTelegramId;
  if (!isBuyer) throw new Error('not_authorized_to_approve: only_buyer_can_approve');
  // Perform atomic join
  const role = await atomicJoinDeal(req.deal_id, req.token, req.requester_telegram_id);
  await updateJoinRequestStatus(requestId, 'approved');
  return role;
}

export async function rejectJoinRequest(requestId: number, approverTelegramId: number) {
  const req = await getJoinRequestById(requestId);
  if (!req) throw new Error('request_not_found');
  if (req.status !== 'pending') throw new Error('request_already_handled');
  const deal = await getDealById(req.deal_id);
  if (!deal) throw new Error('deal_not_found');
  const isBuyer = deal.buyer_telegram_id != null && Number(deal.buyer_telegram_id) === approverTelegramId;
  if (!isBuyer) throw new Error('not_authorized_to_approve: only_buyer_can_approve');
  await updateJoinRequestStatus(requestId, 'rejected');
}

/** Cleanup expired deal links */
export async function purgeExpiredLinks() {
  await db.query('DELETE FROM deal_links WHERE expires_at < now()');
}

// ── CHANNEL/GROUP escrow helpers (custodial via @gramchioka) ──
export async function updateChannelVerification(dealId: number, opts: { channelId?: string | null; channelTitle?: string | null; channelSnapshot?: Record<string, unknown> | null; verified?: boolean }) {
  const sets: string[] = []; const params: unknown[] = []; let idx=1;
  if (opts.channelId !== undefined) { sets.push(`channel_id = $${idx++}`); params.push(opts.channelId); }
  if (opts.channelTitle !== undefined) { sets.push(`channel_title = $${idx++}`); params.push(opts.channelTitle); }
  if (opts.channelSnapshot !== undefined) { sets.push(`channel_snapshot = $${idx++}::jsonb`); params.push(JSON.stringify(opts.channelSnapshot || {})); }
  if (opts.verified !== undefined) {
    sets.push(`channel_verified = $${idx++}`); params.push(!!opts.verified);
    if (opts.verified) sets.push(`channel_verified_at = now()`);
  }
  if (!sets.length) return;
  sets.push(`updated_at = now()`);
  params.push(dealId);
  await db.query(`UPDATE deals SET ${sets.join(', ')} WHERE id = $${idx}`, params);
}
export async function setEscrowHolder(dealId: number, holderId: number) {
  await db.query('UPDATE deals SET escrow_holder_id = $1, updated_at = now() WHERE id = $2', [holderId, dealId]);
}
export async function setTransferToEscrow(dealId: number) {
  await db.query('UPDATE deals SET transfer_to_escrow_at = now(), updated_at = now() WHERE id = $1', [dealId]);
}
export async function setTransferToBuyer(dealId: number, newOwner: string) {
  await db.query('UPDATE deals SET transfer_to_buyer_at = now(), pending_new_owner = $1, updated_at = now() WHERE id = $2', [newOwner, dealId]);
}
export async function setPendingNewOwner(dealId: number, newOwner: string) {
  await db.query('UPDATE deals SET pending_new_owner = $1, updated_at = now() WHERE id = $2', [newOwner, dealId]);
}
