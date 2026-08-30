import dotenv from 'dotenv';
dotenv.config();

function requireMnemonic(): string[] {
  const raw = (process.env.SIGNER_MNEMONIC || '').trim();
  if (!raw) return [];
  return raw.split(/\s+/).filter(Boolean);
}

export const config = {
  mnemonic: requireMnemonic(),
  network: (process.env.TON_NETWORK || 'testnet').toLowerCase() as 'testnet' | 'mainnet',
  tonApiEndpoint: process.env.TON_API_ENDPOINT || '',
  toncenterApiKey: process.env.TONCENTER_API_KEY || '',
  apiKey: process.env.SIGNER_API_KEY || '',
  port: Number(process.env.PORT || 3001),
  corsOrigin: process.env.CORS_ORIGIN || '',
  workchain: Number(process.env.WALLET_WORKCHAIN || 0),
};

export function validateMnemonic(mnemonic: string[]): { valid: boolean; reason?: string } {
  if (mnemonic.length === 0) return { valid: false, reason: 'SIGNER_MNEMONIC is empty — signer will run in read-only/no-wallet mode' };
  if (mnemonic.length !== 24) return { valid: false, reason: `SIGNER_MNEMONIC must be 24 words, got ${mnemonic.length}` };
  if (!mnemonic.every((w) => /^[a-z]+$/.test(w))) return { valid: false, reason: 'SIGNER_MNEMONIC words must be lowercase a-z only' };
  return { valid: true };
}
