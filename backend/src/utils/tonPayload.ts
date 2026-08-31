import { beginCell, Address, Cell } from '@ton/core';
import { JETTON_OPS } from '../blockchain/jettonUtils';

/**
 * TON payload helpers — ensures memo in ALL on-chain transactions.
 * Deposits: buyer -> escrow with `escrow#<id>` comment (op 0)
 * Releases/refunds: escrow -> seller/buyer with `For <terms> — <amount> <asset> — Escrow #<id>` comment
 * Jetton forward: forwardPayload contains same deposit comment
 */

/** Create a simple comment cell (op 0 + stringTail) and return base64 BOC for TON Connect payload. */
export function commentToPayloadB64(comment: string): string {
  const cell = beginCell().storeUint(0, 32).storeStringTail(comment).endCell();
  return cell.toBoc().toString('base64');
}

/** Create comment cell (not BOC) for internal use (signer). */
export function commentToCell(comment: string): Cell {
  return beginCell().storeUint(0, 32).storeStringTail(comment).endCell();
}

/** Decode a comment payload base64 (BOC) back to string, for verification. */
export function payloadB64ToComment(b64: string): string | null {
  try {
    const cell = Cell.fromBoc(Buffer.from(b64, 'base64'))[0];
    const slice = cell.beginParse();
    const op = slice.loadUint(32);
    if (op !== 0) return null;
    return slice.loadStringTail();
  } catch {
    return null;
  }
}

/** Build a Jetton transfer payload (TEP-74) with forward comment.
 *  Structure:
 *   0x0f8a7ea5 | queryId:uint64 | amount:coins | destination:Addr | responseDestination:Addr? | customPayload:Maybe<ref> | forwardTonAmount:coins | forwardPayload:Slice
 *  For escrow deposits, forwardPayload is a comment cell `escrow#<id>`.
 */
export function jettonTransferPayload(params: {
  amount: bigint;
  destination: Address;
  responseDestination?: Address | null;
  forwardTonAmount?: bigint;
  forwardComment?: string | null;
  queryId?: bigint;
}): string {
  const queryId = params.queryId ?? 0n;
  const forwardTonAmount = params.forwardTonAmount ?? 1000000n; // 0.001 TON minimal for forward notification gas
  let forwardPayload: Cell | null = null;
  if (params.forwardComment) {
    forwardPayload = commentToCell(params.forwardComment);
  }
  const builder = beginCell()
    .storeUint(JETTON_OPS.transfer, 32)
    .storeUint(queryId, 64)
    .storeCoins(params.amount)
    .storeAddress(params.destination)
    .storeAddress(params.responseDestination ?? null)
    .storeBit(0) // customPayload null
    .storeCoins(forwardTonAmount);

  if (forwardPayload) {
    // forwardPayload as remaining slice via maybe ref? TEP-74 uses slice, but we store as ref for simplicity if needed
    // For small comment, it fits inline as slice (no ref)
    builder.storeBit(1).storeRef(forwardPayload);
  } else {
    builder.storeBit(0);
  }

  return builder.endCell().toBoc().toString('base64');
}

/** Build Jetton transfer notification forward payload comment extraction helper (for tests). */
export function createForwardPayloadComment(comment: string): string {
  return commentToPayloadB64(comment);
}
