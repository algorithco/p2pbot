import { client } from './tonClient';
import { Address, Cell } from '@ton/core';
import type { Transaction } from '@ton/core';
import { updateDealStatus, getDealById } from '../services/dealService';
import { db } from '../db/queries';
import { toBaseUnits } from '../utils/money';
import { depositComment, parseDepositComment, parseTonComment, parseJettonForwardComment } from '../utils/comments';
import { decryptCommentString } from '../utils/tonPayload';
import { getBot } from '../bot/bot';
import logger from '../logger';

const JETTON_TRANSFER_NOTIFICATION_OP = 0x7362d09c;

const monitoredAddresses = new Set<string>();
/** Per-address cursor so only NEW transactions (higher lt) are processed. */
const cursors = new Map<string, { lt: string; hash: string }>();

export function addAddressToMonitor(address: string) {
  const normalized = address.trim();
  if (!normalized || monitoredAddresses.has(normalized)) return;
  monitoredAddresses.add(normalized);
  // Seed lazily on first poll; existing history must not trigger old deals.
}

interface DealRow {
  id: number;
  asset: string | null;
  amount: string | null;
  buyer_telegram_id: number | null;
  seller_telegram_id: number | null;
  payment_address: string | null;
  terms: string | null;
}

async function findAwaitingDeal(paymentAddress: string): Promise<DealRow | null> {
  const res = await db.query(
    `SELECT id, asset, amount, buyer_telegram_id, seller_telegram_id, payment_address, terms
     FROM deals WHERE payment_address = $1 AND status = $2
     ORDER BY id DESC LIMIT 1`,
    [paymentAddress, 'AWAITING_DEPOSIT']
  );
  return res.rows[0] || null;
}

async function findAwaitingDealById(dealId: number, paymentAddress?: string): Promise<DealRow | null> {
  const res = await db.query(
    `SELECT id, asset, amount, buyer_telegram_id, seller_telegram_id, payment_address, terms
     FROM deals WHERE id = $1 AND status = $2 LIMIT 1`,
    [dealId, 'AWAITING_DEPOSIT']
  );
  const row = res.rows[0] as DealRow | undefined;
  if (!row) return null;
  // If paymentAddress is provided, ensure it matches (or is empty for off-chain fallback)
  if (paymentAddress && row.payment_address && row.payment_address !== paymentAddress) {
    // For shared custodial wallet, paymentAddress will be the custodial address for all deals,
    // so this check should be lenient: only reject if row has a distinct contract address
    // that doesn't match the monitored address.
    // We allow custodial matches.
    try {
      if (Address.parse(row.payment_address).toRawString() !== Address.parse(paymentAddress).toRawString()) {
        // Different contract address — not a match
        return null;
      }
    } catch {
      if (row.payment_address !== paymentAddress) return null;
    }
  }
  return row;
}

function addressesEqual(a: string, b: string): boolean {
  try {
    return Address.parse(a).toRawString() === Address.parse(b).toRawString();
  } catch {
    return false;
  }
}

async function notifySellerOnly(deal: DealRow, text: string) {
  const bot = getBot();
  if (!bot) return;
  const sellerId = deal.seller_telegram_id;
  if (sellerId == null) return;
  try {
    const { InlineKeyboard } = await import('grammy');
    const kb = new InlineKeyboard().text('📦 I sent the item', `item_sent:${deal.id}`);
    await bot.api.sendMessage(sellerId, text, { parse_mode: 'HTML', reply_markup: kb });
  } catch (err) {
    logger.warn(`Could not notify seller ${sellerId} about deal #${deal.id}`, err);
    // Fallback without keyboard
    try {
      const bot2 = getBot();
      if (bot2) await bot2.api.sendMessage(sellerId, text, { parse_mode: 'HTML' });
    } catch {}
  }
}

async function notifyBuyer(deal: DealRow, text: string) {
  const bot = getBot();
  if (!bot) return;
  const buyerId = deal.buyer_telegram_id;
  if (buyerId == null) return;
  try {
    await bot.api.sendMessage(buyerId, text, { parse_mode: 'HTML' });
  } catch (err) {
    logger.warn(`Could not notify buyer ${buyerId} about deal #${deal.id}`, err);
  }
}

// Keep legacy alias for any external usage (no longer used internally)
async function notifyParties(deal: DealRow, text: string) {
  const bot = getBot();
  if (!bot) return;
  const targets = [deal.buyer_telegram_id, deal.seller_telegram_id].filter(
    (v): v is number => v != null
  );
  for (const chatId of targets) {
    try {
      await bot.api.sendMessage(chatId, text);
    } catch (err) {
      logger.warn(`Could not notify ${chatId} about deal #${deal.id}`, err);
    }
  }
}

async function processTonDeposit(addr: string, src: Address | null, value: bigint, txHash: string, comment: string | null) {
  // Memo is encrypted and auto-injected — decrypt before parsing (fallback to plaintext for old tx)
  const decryptedComment = decryptCommentString(comment);
  const commentForLog = decryptedComment || comment;
  // Try comment-based lookup first (most reliable for shared custodial address)
  let deal: DealRow | null = null;
  const expectedId = parseDepositComment(decryptedComment);
  if (expectedId != null) {
    deal = await findAwaitingDealById(expectedId, addr);
    if (deal) {
      logger.info(`Deal #${deal.id}: matched by comment "${comment}" from ${src?.toString() || 'unknown'}`);
    } else {
      logger.warn(`Deposit to ${addr} with comment "${comment}" -> no awaiting deal #${expectedId} (or address mismatch), falling back to amount-based lookup`);
    }
  }

  // Fallback: find latest awaiting deal for this paymentAddress
  if (!deal) {
    deal = await findAwaitingDeal(addr);
    if (!deal) return;
    // If we expected a comment but didn't get one, log but still allow (backwards compat)
    const expectedMemo = depositComment(deal.id);
    if (decryptedComment == null || decryptedComment.trim() === '') {
      logger.info(`Deal #${deal.id}: TON deposit without comment (expected encrypted memo) from ${src?.toString() || 'unknown'} — accepting by amount`);
    } else if (parseDepositComment(decryptedComment) == null) {
      // Comment present but not matching escrow# pattern — could be user error, but still check amount
      logger.warn(`Deal #${deal.id}: TON deposit with unexpected comment "${commentForLog}" (expected "${expectedMemo}") — checking amount`);
    } else if (expectedId == null || expectedId !== deal.id) {
      // Comment is escrow# but for different deal id
      logger.warn(`Deal #${deal.id}: TON deposit comment "${commentForLog}" does not match this deal's expected "${expectedMemo}" — checking amount anyway`);
    }
  } else {
    // We already matched by comment, but still need to ensure paymentAddress matches (already checked)
  }

  if (!deal) return;

  let expected: bigint;
  try {
    expected = BigInt(toBaseUnits(String(deal.amount ?? ''), String(deal.asset ?? '')));
  } catch (err) {
    logger.warn(`Deal #${deal.id}: cannot compute base units (${(err as Error).message})`);
    return;
  }
  if (value !== expected) {
    logger.info(`Deal #${deal.id}: TON deposit amount mismatch: got ${value} expected ${expected} (memo "${commentForLog}")`);
    return;
  }

  // If the buyer's TON address is known, require the funds to come from them.
  if (src && deal.buyer_telegram_id != null) {
    const userRes = await db.query(
      'SELECT ton_address FROM users WHERE telegram_id = $1 LIMIT 1',
      [deal.buyer_telegram_id]
    );
    const buyerTon = userRes.rows[0]?.ton_address;
    if (buyerTon && !addressesEqual(buyerTon, src.toString())) {
      logger.warn(`Deal #${deal.id}: TON deposit from unexpected source ${src.toString()} (expected ${buyerTon})`);
      return;
    }
  }

  await updateDealStatus(deal.id, 'DEPOSIT_CONFIRMED', txHash);
  // Desired flow: notify ONLY seller "I've received the TON; please send the item to the buyer" with product type
  const productTon = deal.terms ? `"${String(deal.terms).slice(0, 100)}"` : 'the item';
  const sellerMsgTon = [
    `✅ <b>I've received ${String(deal.amount)} ${String(deal.asset)} for deal #${deal.id}</b>`,
    `Product: ${productTon}`,
    ``,
    `Please send ${productTon} to the buyer (ID <code>${deal.buyer_telegram_id}</code>).`,
    `When done, tap "I sent the item" below or in the web app.`,
  ].join('\n');
  await notifySellerOnly(deal, sellerMsgTon);
}

interface JettonNotification {
  queryId: bigint;
  amount: bigint;
  sender: Address | null;
}

function parseJettonNotification(body: Cell): JettonNotification | null {
  try {
    const cs = body.beginParse();
    const op = cs.loadUint(32);
    if (op !== JETTON_TRANSFER_NOTIFICATION_OP) return null;
    const queryId = cs.loadUintBig(64);
    const amount = cs.loadCoins();
    const sender = cs.loadAddress();
    return { queryId, amount, sender };
  } catch {
    return null;
  }
}

async function processJettonDeposit(addr: string, note: JettonNotification, forwardComment: string | null, txHash: string) {
  // Forward memo is encrypted — decrypt before parsing
  const decryptedForward = decryptCommentString(forwardComment);
  // Try comment-based lookup first
  let deal: DealRow | null = null;
  const expectedId = parseDepositComment(decryptedForward);
  if (expectedId != null) {
    deal = await findAwaitingDealById(expectedId, addr);
    if (deal) {
      logger.info(`Deal #${deal.id}: matched by jetton forward comment "${forwardComment}"`);
    } else {
      logger.warn(`Jetton deposit to ${addr} with forward comment "${forwardComment}" -> no awaiting deal #${expectedId}`);
    }
  }
  if (!deal) {
    deal = await findAwaitingDeal(addr);
    if (!deal) return;
    const expectedMemo = depositComment(deal.id);
    if (!decryptedForward) {
      logger.info(`Deal #${deal.id}: USDT deposit without forward comment (expected encrypted memo) — accepting by amount`);
    } else if (parseDepositComment(decryptedForward) == null) {
      logger.warn(`Deal #${deal.id}: USDT deposit with unexpected forward comment "${decryptedForward}" (expected "${expectedMemo}")`);
    }
  }

  if (!deal) return;

  let expected: bigint;
  try {
    expected = BigInt(toBaseUnits(String(deal.amount ?? ''), String(deal.asset ?? '')));
  } catch (err) {
    logger.warn(`Deal #${deal.id}: cannot compute base units (${(err as Error).message})`);
    return;
  }
  if (note.amount !== expected) {
    logger.info(`Deal #${deal.id}: USDT deposit amount mismatch: got ${note.amount} expected ${expected} (forward "${forwardComment}")`);
    return;
  }

  await updateDealStatus(deal.id, 'DEPOSIT_CONFIRMED', txHash);
  const productJetton = deal.terms ? `"${String(deal.terms).slice(0, 100)}"` : 'the item';
  const sellerMsgUsdt = [
    `✅ <b>I've received ${String(deal.amount)} ${String(deal.asset)} for deal #${deal.id}</b>`,
    `Product: ${productJetton}`,
    ``,
    `Please send ${productJetton} to the buyer (ID <code>${deal.buyer_telegram_id}</code>).`,
    `When done, tap "I sent the item" below.`,
  ].join('\n');
  await notifySellerOnly(deal, sellerMsgUsdt);
}

async function handleTransaction(addr: string, tx: Transaction) {
  const txHash = tx.hash().toString('hex');
  if (!tx.inMessage) return;

  // Try jetton first
  const note = parseJettonNotification(tx.inMessage.body);
  if (note) {
    // Extract forward payload comment if present (remaining slice after jetton notification)
    let forwardComment: string | null = null;
    try {
      // The body has been consumed by parseJettonNotification, need to re-parse to get forwardPayload
      // Use the helper from comments utils
      const bodySlice = tx.inMessage.body.beginParse();
      bodySlice.loadUint(32); // op
      bodySlice.loadUintBig(64); // queryId
      bodySlice.loadCoins(); // amount
      bodySlice.loadAddress(); // sender
      // Remaining is forwardPayload
      // It may contain a comment cell
      if (bodySlice.remainingBits > 0 || bodySlice.remainingRefs > 0) {
        // Check if there's a forward payload
        // In TEP-74, after sender there is forwardPayload (slice)
        // We need to handle it: if there's a ref, load it
        try {
          if (bodySlice.remainingRefs > 0) {
            const fwd = bodySlice.loadRef().beginParse();
            forwardComment = parseTonComment(fwd) ?? parseJettonForwardComment(fwd);
          } else {
            forwardComment = parseTonComment(bodySlice) ?? parseJettonForwardComment(bodySlice);
          }
        } catch {
          forwardComment = null;
        }
      }
    } catch {
      forwardComment = null;
    }
    await processJettonDeposit(addr, note, forwardComment, txHash);
    return;
  }

  if (tx.inMessage.info.type === 'internal') {
    const value = tx.inMessage.info.value.coins;
    const src = tx.inMessage.info.src;
    if (value > 0n) {
      // Extract TON comment
      let comment: string | null = null;
      try {
        comment = parseTonComment(tx.inMessage.body);
      } catch {
        comment = null;
      }
      await processTonDeposit(addr, src, value, txHash, comment);
    }
  }
}

async function pollAddress(addr: string) {
  const txs = await client.getTransactions(Address.parse(addr), { limit: 10 });

  let cursor = cursors.get(addr);
  let maxSeen: { lt: string; hash: string } | null = cursor ? { ...cursor } : null;

  for (const tx of txs) {
    const lt = (tx.lt ?? 0n).toString();
    const entry = { lt, hash: tx.hash().toString('hex') };
    if (!maxSeen || BigInt(lt) > BigInt(maxSeen.lt)) maxSeen = entry;

    // First observation of this address only seeds the cursor.
    if (!cursor) continue;
    if (BigInt(lt) <= BigInt(cursor.lt)) continue;

    try {
      await handleTransaction(addr, tx);
    } catch (err) {
      logger.error(`Failed handling tx on ${addr} (lt ${lt})`, err);
    }
  }

  if (maxSeen && (!cursor || BigInt(maxSeen.lt) > BigInt(cursor.lt))) {
    cursors.set(addr, maxSeen);
  }
}

export async function startListener() {
  logger.info('Blockchain listener started');
  setInterval(async () => {
    for (const addr of monitoredAddresses) {
      try {
        await pollAddress(addr);
      } catch (err) {
        logger.error(`Listener error for ${addr}:`, err);
      }
    }
  }, 10000);
}
