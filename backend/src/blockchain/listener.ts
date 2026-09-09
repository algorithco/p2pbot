import { client } from './tonClient';
import { Address, Cell } from '@ton/core';
import type { Transaction } from '@ton/core';
import { updateDealStatus, dealLike } from '../services/dealService';
import { db } from '../db/queries';
import { toBaseUnits, fromBaseUnits, dealPricing } from '../utils/money';
import { parseDepositComment, parseTonComment, parseJettonForwardComment } from '../utils/comments';
import { decryptCommentString } from '../utils/tonPayload';
import { encryptField } from '../utils/encryption';
import { config } from '../config';
import { sendTon, sendJetton } from './signerClient';
import * as notify from '../bot/notify';
import logger from '../logger';

const JETTON_TRANSFER_NOTIFICATION_OP = 0x7362d09c;

const monitoredAddresses = new Set<string>();
/** Per-address cursor so only NEW transactions (higher lt) are processed. */
const cursors = new Map<string, { lt: string; hash: string }>();

async function loadPersistedCursors() {
  try {
    const res = await db.query('SELECT address, lt, hash FROM listener_cursors');
    for (const r of res.rows) {
      cursors.set(String(r.address), { lt: String(r.lt), hash: String(r.hash) });
    }
    if (res.rows.length) logger.info(`Listener: loaded ${res.rows.length} persisted cursors`);
  } catch (e) {
    logger.warn('Listener: could not load persisted cursors', e);
  }
}

async function persistCursor(address: string, lt: string, hash: string) {
  try {
    await db.query(
      `INSERT INTO listener_cursors (address, lt, hash, updated_at) VALUES ($1,$2,$3,now())
       ON CONFLICT (address) DO UPDATE SET lt = EXCLUDED.lt, hash = EXCLUDED.hash, updated_at = now()`,
      [address, lt, hash]
    );
  } catch (e) {
    logger.warn(`Listener: could not persist cursor for ${address}`, e);
  }
}

async function seedMonitoredAddressesFromDB() {
  try {
    const res = await db.query(`SELECT DISTINCT payment_address FROM deals WHERE status = 'AWAITING_DEPOSIT' AND payment_address IS NOT NULL AND payment_address <> ''`);
    let added = 0;
    for (const r of res.rows) {
      const addr = String(r.payment_address).trim();
      if (addr && !monitoredAddresses.has(addr)) {
        monitoredAddresses.add(addr);
        added++;
      }
    }
    if (added) logger.info(`Listener: seeded ${added} monitored addresses from awaiting deals`);
  } catch (e) {
    logger.warn('Listener: could not seed monitored addresses', e);
  }
}

export function addAddressToMonitor(address: string) {
  const normalized = address.trim();
  if (!normalized || monitoredAddresses.has(normalized)) return;
  monitoredAddresses.add(normalized);
  // New address: first poll will seed cursor without processing (avoid replaying old history)
  logger.info(`Listener: added ${normalized} to monitor`);
}

interface DealRow {
  id: number;
  asset: string | null;
  amount: string | null;
  fee_bps: number | null;
  buyer_telegram_id: number | null;
  seller_telegram_id: number | null;
  payment_address: string | null;
  terms: string | null;
}

async function findAwaitingDealById(dealId: number, paymentAddress?: string): Promise<DealRow | null> {
  const res = await db.query(
    `SELECT id, asset, amount, fee_bps, buyer_telegram_id, seller_telegram_id, payment_address, terms
     FROM deals WHERE id = $1 AND status = $2 LIMIT 1`,
    [dealId, 'AWAITING_DEPOSIT']
  );
  const row = res.rows[0] as DealRow | undefined;
  if (!row) return null;
  if (paymentAddress && row.payment_address && row.payment_address !== paymentAddress) {
    try {
      if (Address.parse(row.payment_address).toRawString() !== Address.parse(paymentAddress).toRawString()) {
        return null;
      }
    } catch {
      // best-effort: unparsable address falls back to plain string compare.
      if (row.payment_address !== paymentAddress) return null;
    }
  }
  return row;
}

function expectedForDeal(deal: DealRow): bigint {
  // Single source: same pricing the deal creator, the payout path and the UI see.
  return dealPricing(
    String(deal.amount ?? '0'),
    String(deal.asset ?? 'TON'),
    (deal as { fee_bps?: unknown }).fee_bps as number | undefined ?? config.feeBps ?? 100
  ).expectedDeposit;
}

async function postChatSystemMessage(dealId: number, text: string) {
  try {
    const { addDealMessage } = await import('../services/dealService');
    await addDealMessage(dealId, 0, text);
  } catch (e) {
    logger.warn(`Could not post chat system message for deal #${dealId}`, e);
  }
}

async function unknownToAdminsAndSave(info: { amount: string | number; asset: string; address: string; memo: string }): Promise<void> {
  try {
    await notify.unknownDepositToAdmins(info);
  } catch (e) {
    logger.warn('unknownDepositToAdmins failed', e);
  }
  try {
    const { saveAdminAlert } = await import('../db/queries');
    const text = `Noma'lum to'lov: ${info.amount} ${info.asset} — ${info.memo}`.slice(0, 500);
    await saveAdminAlert('unknown_deposit', text, { amount: String(info.amount), asset: info.asset, address: info.address, memo: info.memo });
  } catch {} // best-effort: Telegram notify above already attempted; alert persistence must not break deposit handling.
}

async function notifySellerDeposit(deal: DealRow) {
  if (deal.seller_telegram_id == null) return;
  try {
    await notify.depositToSeller(Number(deal.seller_telegram_id), dealLike(deal));
  } catch (e) {
    logger.warn(`depositToSeller notify failed for deal #${deal.id}`, e);
  }
  void postChatSystemMessage(deal.id, `Tizim: To'lov qabul qilindi (Deal #${deal.id}) — ${String(deal.amount)} ${String(deal.asset)}.`);
}

async function processTonDeposit(addr: string, src: Address | null, value: bigint, txHash: string, comment: string | null) {
  const decrypted = decryptCommentString(comment) ?? comment ?? '';
  const raw = comment ?? '';
  const dealId = parseDepositComment(decrypted) ?? parseDepositComment(raw);

  if (dealId == null) {
    let human = '';
    try {
      human = fromBaseUnits(value, 'TON');
    } catch {
      human = value.toString();
    }
    logger.warn(`Unknown TON deposit to ${addr} value ${value} memo "${decrypted || raw || '(memosiz)'}" — no memo match`);
    try {
      await unknownToAdminsAndSave({
        amount: human,
        asset: 'TON',
        address: addr,
        memo: decrypted || raw || '(memosiz)',
      });
    } catch (e) {
      logger.warn('unknownDepositToAdmins failed', e);
    }
    return;
  }

  const deal = await findAwaitingDealById(dealId, addr);
  if (!deal) {
    let human = '';
    try {
      human = fromBaseUnits(value, 'TON');
    } catch {
      human = value.toString();
    }
    logger.warn(`TON deposit memo escrow#${dealId} to ${addr} — no AWAITING_DEPOSIT deal, ignoring`);
    try {
      await unknownToAdminsAndSave({
        amount: human,
        asset: 'TON',
        address: addr,
        memo: decrypted || raw || `escrow#${dealId}`,
      });
    } catch {}
    return;
  }

  const assetUpper = String(deal.asset ?? 'TON').toUpperCase();
  if (assetUpper !== 'TON') {
    let human = '';
    try {
      human = fromBaseUnits(value, 'TON');
    } catch {
      human = value.toString();
    }
    logger.warn(`Deal #${deal.id} expects ${assetUpper} but got TON tx — ignoring`);
    try {
      await unknownToAdminsAndSave({
        amount: human,
        asset: 'TON',
        address: addr,
        memo: `Noto'g'ri aktiv Deal #${deal.id}: ${decrypted || raw}`,
      });
    } catch {}
    return;
  }

  let expected: bigint;
  try {
    expected = expectedForDeal(deal);
  } catch (err) {
    logger.warn(`Deal #${deal.id}: cannot compute expected (${(err as Error).message})`);
    return;
  }

  if (value === expected) {
    await updateDealStatus(deal.id, 'DEPOSIT_CONFIRMED', txHash);
    logger.info(`Deal #${deal.id}: TON deposit exact ${value} confirmed`);
    await notifySellerDeposit(deal);
    return;
  }

  if (value > expected) {
    const excess = value - expected;
    await updateDealStatus(deal.id, 'DEPOSIT_CONFIRMED', txHash);
    logger.info(`Deal #${deal.id}: TON overpay got ${value} expected ${expected}, excess ${excess} — confirming + refunding`);
    if (src) {
      try {
        const excessHuman = fromBaseUnits(excess, 'TON');
        const memoEnc = encryptField(`Ortiqcha qaytarildi Deal #${deal.id}`);
        await sendTon({ to: src.toString(), value: excessHuman, comment: memoEnc, bounce: false });
        logger.info(`Deal #${deal.id}: refunded excess ${excessHuman} TON to ${src.toString()}`);
      } catch (e) {
        logger.warn(`Deal #${deal.id}: excess refund failed`, e);
        try {
          let exHuman = excess.toString();
          try {
            exHuman = fromBaseUnits(excess, 'TON');
          } catch {}
          await unknownToAdminsAndSave({
            amount: exHuman,
            asset: 'TON',
            address: addr,
            memo: `Qaytarish xatosi Deal #${deal.id}: ${(e as Error).message}`,
          });
        } catch {}
      }
    } else {
      logger.warn(`Deal #${deal.id}: overpay but no sender address — refund skipped`);
    }
    await notifySellerDeposit(deal);
    return;
  }

  // Underpay — do NOT confirm
  let gotHuman = value.toString();
  let expHuman = expected.toString();
  try {
    gotHuman = fromBaseUnits(value, 'TON');
    expHuman = fromBaseUnits(expected, 'TON');
  } catch {}
  logger.info(`Deal #${deal.id}: TON underpay got ${value} expected ${expected} — waiting`);
  try {
    await unknownToAdminsAndSave({
      amount: gotHuman,
      asset: 'TON',
      address: addr,
      memo: `Kam to'lov Deal #${deal.id}: keldi ${gotHuman} kutilgan ${expHuman} memo ${decrypted || raw}`,
    });
  } catch {}
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
  const decrypted = decryptCommentString(forwardComment) ?? forwardComment ?? '';
  const raw = forwardComment ?? '';
  const dealId = parseDepositComment(decrypted) ?? parseDepositComment(raw);

  if (dealId == null) {
    let human = note.amount.toString();
    try {
      human = fromBaseUnits(note.amount, 'USDT');
    } catch {}
    logger.warn(`Unknown USDT deposit to ${addr} amount ${note.amount} forward "${decrypted || raw || '(memosiz)'}"`);
    try {
      await unknownToAdminsAndSave({
        amount: human,
        asset: 'USDT',
        address: addr,
        memo: decrypted || raw || '(memosiz)',
      });
    } catch {}
    return;
  }

  const deal = await findAwaitingDealById(dealId, addr);
  if (!deal) {
    let human = note.amount.toString();
    try {
      human = fromBaseUnits(note.amount, 'USDT');
    } catch {}
    logger.warn(`USDT deposit forward escrow#${dealId} to ${addr} — no AWAITING_DEPOSIT deal`);
    try {
      await unknownToAdminsAndSave({
        amount: human,
        asset: 'USDT',
        address: addr,
        memo: decrypted || raw || `escrow#${dealId}`,
      });
    } catch {}
    return;
  }

  const assetUpper = String(deal.asset ?? 'USDT').toUpperCase();
  if (assetUpper !== 'USDT') {
    let human = note.amount.toString();
    try {
      human = fromBaseUnits(note.amount, assetUpper);
    } catch {
      try {
        human = fromBaseUnits(note.amount, 'USDT');
      } catch {}
    }
    logger.warn(`Deal #${deal.id} expects ${assetUpper} but got USDT jetton — ignoring`);
    try {
      await unknownToAdminsAndSave({
        amount: human,
        asset: 'USDT',
        address: addr,
        memo: `Noto'g'ri aktiv Deal #${deal.id}: ${decrypted || raw}`,
      });
    } catch {}
    return;
  }

  let expected: bigint;
  try {
    expected = expectedForDeal(deal);
  } catch (err) {
    logger.warn(`Deal #${deal.id}: cannot compute expected (${(err as Error).message})`);
    return;
  }

  if (note.amount === expected) {
    await updateDealStatus(deal.id, 'DEPOSIT_CONFIRMED', txHash);
    logger.info(`Deal #${deal.id}: USDT deposit exact ${note.amount} confirmed`);
    await notifySellerDeposit(deal);
    return;
  }

  if (note.amount > expected) {
    const excess = note.amount - expected;
    await updateDealStatus(deal.id, 'DEPOSIT_CONFIRMED', txHash);
    logger.info(`Deal #${deal.id}: USDT overpay got ${note.amount} expected ${expected}, excess ${excess}`);
    const senderAddr = note.sender ? note.sender.toString() : null;
    if (senderAddr) {
      try {
        const jettonMaster = config.jettonMasterAddress || config.usdtJettonAddress;
        if (!jettonMaster) throw new Error('jetton_master_not_configured');
        const excessHuman = fromBaseUnits(excess, assetUpper);
        const memoEnc = encryptField(`Ortiqcha qaytarildi Deal #${deal.id}`);
        await sendJetton({
          jettonMasterAddress: jettonMaster,
          to: senderAddr,
          amount: excessHuman,
          forwardComment: memoEnc,
          forwardTonAmount: '0.01',
        });
        logger.info(`Deal #${deal.id}: refunded excess ${excessHuman} ${assetUpper} to ${senderAddr}`);
      } catch (e) {
        logger.warn(`Deal #${deal.id}: USDT excess refund failed`, e);
        try {
          let exHuman = excess.toString();
          try {
            exHuman = fromBaseUnits(excess, assetUpper);
          } catch {}
          await unknownToAdminsAndSave({
            amount: exHuman,
            asset: assetUpper,
            address: addr,
            memo: `Qaytarish xatosi Deal #${deal.id}: ${(e as Error).message}`,
          });
        } catch {}
      }
    } else {
      logger.warn(`Deal #${deal.id}: USDT overpay but no sender — refund skipped`);
    }
    await notifySellerDeposit(deal);
    return;
  }

  let gotHuman = note.amount.toString();
  let expHuman = expected.toString();
  try {
    gotHuman = fromBaseUnits(note.amount, assetUpper);
    expHuman = fromBaseUnits(expected, assetUpper);
  } catch {}
  logger.info(`Deal #${deal.id}: USDT underpay got ${note.amount} expected ${expected}`);
  try {
    await unknownToAdminsAndSave({
      amount: gotHuman,
      asset: assetUpper,
      address: addr,
      memo: `Kam to'lov Deal #${deal.id}: keldi ${gotHuman} kutilgan ${expHuman} memo ${decrypted || raw}`,
    });
  } catch {}
}

async function handleTransaction(addr: string, tx: Transaction) {
  const txHash = tx.hash().toString('hex');
  if (!tx.inMessage) return;

  // Try jetton first
  const note = parseJettonNotification(tx.inMessage.body);
  if (note) {
    let forwardComment: string | null = null;
    try {
      const bodySlice = tx.inMessage.body.beginParse();
      bodySlice.loadUint(32); // op
      bodySlice.loadUintBig(64); // queryId
      bodySlice.loadCoins(); // amount
      bodySlice.loadAddress(); // sender
      if (bodySlice.remainingBits > 0 || bodySlice.remainingRefs > 0) {
        try {
          if (bodySlice.remainingRefs > 0) {
            const fwd = bodySlice.loadRef().beginParse();
            forwardComment = parseTonComment(fwd) ?? parseJettonForwardComment(fwd);
          } else {
            forwardComment = parseTonComment(bodySlice) ?? parseJettonForwardComment(bodySlice);
          }
        } catch {
          // best-effort: unparsable forward payload means "no memo" (deposit handled as unknown), never crash the poll loop.
          forwardComment = null;
        }
      }
    } catch {
      // best-effort: same as above for the outer notification-field parse.
      forwardComment = null;
    }
    await processJettonDeposit(addr, note, forwardComment, txHash);
    return;
  }

  if (tx.inMessage.info.type === 'internal') {
    const value = tx.inMessage.info.value.coins;
    const src = tx.inMessage.info.src;
    if (value > 0n) {
      let comment: string | null = null;
      try {
        comment = parseTonComment(tx.inMessage.body);
      } catch {
        // best-effort: unparsable body means "no memo" (deposit handled as unknown).
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
    // Persist to DB so restart doesn't reseed and skip deposits (fix 2.4)
    await persistCursor(addr, maxSeen.lt, maxSeen.hash);
  }
}

/** Immediately poll one monitored address once (for "Toldim, tekshiring" button). */
export async function recheckAddress(address: string): Promise<void> {
  const a = String(address || '').trim();
  if (!a) return;
  if (!monitoredAddresses.has(a)) monitoredAddresses.add(a);
  try {
    await pollAddress(a);
  } catch (err) {
    logger.warn(`recheckAddress failed for ${a}`, err);
  }
}

export async function startListener() {
  logger.info('Blockchain listener started');
  // Fix 2.4: restore persisted cursors and seed monitored addresses from DB
  await loadPersistedCursors();
  await seedMonitoredAddressesFromDB();
  const timer = setInterval(async () => {
    for (const addr of monitoredAddresses) {
      try {
        await pollAddress(addr);
      } catch (err) {
        logger.error(`Listener error for ${addr}:`, err);
      }
    }
  }, 10000);
  (timer as unknown as { unref?: () => void }).unref?.();
}
