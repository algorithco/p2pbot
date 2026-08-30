/**
 * Shared TON RPC client (read-only).
 * Signing is handled exclusively by the isolated signer microservice (signer:3001).
 *
 * Endpoint resolution:
 *  1. An explicitly-provided TON_API_ENDPOINT env var wins verbatim. We check
 *     the raw env rather than config.tonApiEndpoint because that config field
 *     defaults to https://tonapi.io, which is an indexer API — not the
 *     jsonRPC endpoint @ton/ton requires.
 *  2. Otherwise the proper toncenter jsonRPC URL is derived from TON_NETWORK.
 * Optional TONCENTER_API_KEY is passed through TonClient's apiKey option.
 */
import { TonClient } from '@ton/ton';
import { config } from '../config';

const TONCENTER_MAINNET = 'https://toncenter.com/api/v2/jsonRPC';
const TONCENTER_TESTNET = 'https://testnet.toncenter.com/api/v2/jsonRPC';

function resolveEndpoint(): string {
  const override = process.env.TON_API_ENDPOINT;
  if (override !== undefined && override.trim() !== '') {
    return override.trim();
  }
  return config.tonNetwork === 'testnet' ? TONCENTER_TESTNET : TONCENTER_MAINNET;
}

export const client = new TonClient({
  endpoint: resolveEndpoint(),
  apiKey: process.env.TONCENTER_API_KEY || undefined,
});

/**
 * @deprecated Direct wallet access removed. Use signerClient.getSignerAddress()
 * Wallet keys now live only in signer service (SIGNER_MNEMONIC). This stub
 * is kept for backward-compat error messages.
 */
export async function getWallet(): Promise<never> {
  throw new Error('wallet_not_configured: MNEMONIC removed — use signer microservice (SIGNER_URL). Set SIGNER_MNEMONIC in signer/.env');
}

export async function getWalletAddress(): Promise<string> {
  const { getSignerAddress } = await import('./signerClient');
  return getSignerAddress();
}
