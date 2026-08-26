/**
 * Shared TON RPC client + bot wallet accessors.
 *
 * Endpoint resolution:
 *  1. An explicitly-provided TON_API_ENDPOINT env var wins verbatim. We check
 *     the raw env rather than config.tonApiEndpoint because that config field
 *     defaults to https://tonapi.io, which is an indexer API — not the
 *     jsonRPC endpoint @ton/ton requires.
 *  2. Otherwise the proper toncenter jsonRPC URL is derived from TON_NETWORK.
 * Optional TONCENTER_API_KEY is passed through TonClient's apiKey option.
 */
import { TonClient, WalletContractV4 } from '@ton/ton';
import { mnemonicToPrivateKey } from '@ton/crypto';
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

let cachedWallet: WalletContractV4 | null = null;

/** Bot hot wallet (V4) derived from MNEMONIC; throws when unconfigured. */
export async function getWallet(): Promise<WalletContractV4> {
  let w = cachedWallet;
  if (!w) {
    if (!Array.isArray(config.mnemonic) || config.mnemonic.length < 12) {
      throw new Error('wallet_not_configured: MNEMONIC missing or too short');
    }
    const key = await mnemonicToPrivateKey(config.mnemonic);
    w = WalletContractV4.create({ publicKey: key.publicKey, workchain: 0 });
    cachedWallet = w;
  }
  return w;
}

export async function getWalletAddress(): Promise<string> {
  return (await getWallet()).address.toString();
}
