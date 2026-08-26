import { client } from './tonClient';
import { Address, Cell } from '@ton/core';
import type { Transaction } from '@ton/core';
import { updateDealStatus } from '../services/dealService';
import { db } from '../db/queries';
import { toBaseUnits } from '../utils/money';
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
}

async function findAwaitingDeal(paymentAddress: string): Promise<DealRow | null> {
  const res = await db.query(
    `SELECT id, asset, amount, buyer_telegram_id, seller_telegram_id
     FROM deals WHERE payment_address = $1 AND status = $2
     ORDER BY id DESC LIMIT 1`,
    [paymentAddress, 'AWAITING_DEPOSIT']
  );
  return res.rows[0] || null;
}

function addressesEqual(a: string, b: string): boolean {
  try {
    return Address.parse(a).toRawString() === Address.parse(b).toRawString();
  } catch {
    return false;
  }
}

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

async function processTonDeposit(addr: string, src: Address | null, value: bigint, txHash: string) {
  const deal = await findAwaitingDeal(addr);
  if (!deal) return;

  let expected: bigint;
  try {
    expected = BigInt(toBaseUnits(String(deal.amount ?? ''), String(deal.asset ?? '')));
  } catch (err) {
    logger.warn(`Deal #${deal.id}: cannot compute base units (${(err as Error).message})`);
    return;
  }
  if (value !== expected) return;

  // If the buyer's TON address is known, require the funds to come from them.
  if (src && deal.buyer_telegram_id != null) {
    const userRes = await db.query(
      'SELECT ton_address FROM users WHERE telegram_id = $1 LIMIT 1',
      [deal.buyer_telegram_id]
    );
    const buyerTon = userRes.rows[0]?.ton_address;
    if (buyerTon && !addressesEqual(buyerTon, src.toString())) {
      logger.warn(`Deal #${deal.id}: TON deposit from unexpected source ${src.toString()}`);
      return;
    }
  }

  await updateDealStatus(deal.id, 'DEPOSIT_CONFIRMED', txHash);
  await notifyParties(deal, `Deposit confirmed for deal #${deal.id}. Both parties can now confirm with /confirm ${deal.id}`);
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

async function processJettonDeposit(addr: string, note: JettonNotification, txHash: string) {
  const deal = await findAwaitingDeal(addr);
  if (!deal) return;

  let expected: bigint;
  try {
    expected = BigInt(toBaseUnits(String(deal.amount ?? ''), String(deal.asset ?? '')));
  } catch (err) {
    logger.warn(`Deal #${deal.id}: cannot compute base units (${(err as Error).message})`);
    return;
  }
  if (note.amount !== expected) return;
  // Optional strictness: when USDT master is configured the sending jetton wallet
  // should belong to it — skipped here because wallet->master derivation needs jettonUtils.

  await updateDealStatus(deal.id, 'DEPOSIT_CONFIRMED', txHash);
  await notifyParties(deal, `USDT deposit confirmed for deal #${deal.id}. Both parties can now confirm with /confirm ${deal.id}`);
}

async function handleTransaction(addr: string, tx: Transaction) {
  const txHash = tx.hash().toString('hex');
  if (!tx.inMessage) return;

  // TEP-74 transfer notifications arrive as internal messages that DO carry
  // positive attached TON (forward fee), so we must classify by body opcode
  // BEFORE treating the message as a native TON deposit.
  const note = parseJettonNotification(tx.inMessage.body);
  if (note) {
    await processJettonDeposit(addr, note, txHash);
    return;
  }

  if (tx.inMessage.info.type === 'internal') {
    const value = tx.inMessage.info.value.coins;
    const src = tx.inMessage.info.src;
    if (value > 0n) {
      await processTonDeposit(addr, src, value, txHash);
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
