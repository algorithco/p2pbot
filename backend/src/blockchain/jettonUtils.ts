/**
 * Jetton helpers: TEP-74/TEP-89 opcodes, transfer-notification parsing and
 * jetton-wallet address discovery via the master's get_wallet_address method.
 */
import { Address, beginCell, Cell, Slice } from '@ton/core';
import type { TonClient } from '@ton/ton';
import { client as defaultClient } from './tonClient';

export const JETTON_OPS = {
  /** jetton_wallet -> owner (0x7362d09c) */
  transferNotification: 0x7362d09c,
  /** owner -> jetton_wallet (0x0f8a7ea5) */
  transfer: 0x0f8a7ea5,
  /** jetton_master -> jetton_wallet (0x178d4519) */
  internalTransfer: 0x178d4519,
  /** owner -> jetton_wallet burn (0x595f07bc) */
  burn: 0x595f07bc,
} as const;

export interface JettonNotificationParts {
  queryId: bigint;
  amount: bigint;
  sender: Address;
  /** Remaining slice after the fixed fields (TEP-74 forward payload). */
  forwardPayload: Slice;
}

/** Parses a TEP-74 transfer_notification body; null on malformed input / op mismatch. */
export function parseJettonNotification(body: Cell | Slice): JettonNotificationParts | null {
  try {
    const slice = body instanceof Cell ? body.beginParse() : body;
    if (slice.loadUint(32) !== JETTON_OPS.transferNotification) {
      return null;
    }
    const queryId = slice.loadUintBig(64);
    const amount = slice.loadCoins();
    const sender = slice.loadAddress();
    return { queryId, amount, sender, forwardPayload: slice };
  } catch {
    // best-effort: malformed bodies are simply "not a jetton notification" for the listener.
    return null;
  }
}

/**
 * Resolves the jetton wallet of `ownerAddress` for jetton `jettonMasterAddress`
 * via the standard get_wallet_address get-method. Returns null on any RPC or
 * parsing failure — callers decide how hard that failure is for them.
 */
export async function getWalletAddress(
  cl: Pick<TonClient, 'runMethodWithError'>,
  jettonMasterAddress: Address,
  ownerAddress: Address,
): Promise<Address | null> {
  try {
    const ownerSlice = beginCell().storeAddress(ownerAddress).endCell();
    const res = await cl.runMethodWithError(jettonMasterAddress, 'get_wallet_address', [
      { type: 'slice', cell: ownerSlice },
    ]);
    return res.stack.readAddress();
  } catch {
    // best-effort: null return; callers surface their own explicit error (never silent).
    return null;
  }
}

/** Convenience overload bound to the shared TonClient. */
export async function computeJettonWalletAddress(
  jettonMasterAddress: Address,
  ownerAddress: Address,
): Promise<Address | null> {
  return getWalletAddress(defaultClient, jettonMasterAddress, ownerAddress);
}
