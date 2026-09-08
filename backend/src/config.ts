import dotenv from 'dotenv';
dotenv.config();

export const config = {
  botToken: process.env.BOT_TOKEN!,
  botUsername: process.env.BOT_USERNAME || 'uzsavdochibot',
  adminTelegramIds: (process.env.ADMIN_TELEGRAM_IDS || '').split(',').map(Number),
  databaseUrl: process.env.DATABASE_URL!,
  tonApiEndpoint: process.env.TON_API_ENDPOINT || 'https://tonapi.io',
  tonNetwork: process.env.TON_NETWORK || 'mainnet',
  // Signer microservice (W5 wallet) — holds SIGNER_MNEMONIC isolated
  signerUrl: process.env.SIGNER_URL || 'http://signer:3001',
  signerApiKey: process.env.SIGNER_API_KEY || '',
  escrowContractCodeHex: process.env.ESCROW_CONTRACT_CODE_HEX || '',
  jettonMasterAddress: process.env.JETTON_MASTER_ADDRESS,
  jettonWalletCodeHash: (() => {
    try {
      return BigInt(process.env.JETTON_WALLET_CODE_HASH || '0');
    } catch (e) {
      return BigInt(0);
    }
  })(),
  feeAddress: process.env.FEE_ADDRESS || '',
  feeBps: Number(process.env.FEE_BPS || 100),
  feePercentage: Number(process.env.FEE_PERCENTAGE || 1), // percent
  usdtJettonAddress: process.env.USDT_JETTON_ADDRESS || '',
  minConfirmations: Number(process.env.MIN_CONFIRMATIONS || 3),
  adminAddress: process.env.ADMIN_ADDRESS || '',
  apiKey: process.env.API_KEY || undefined,
  webappUrl: process.env.WEBAPP_URL || '',
  frontendUrl: process.env.FRONTEND_URL || process.env.WEBAPP_URL || 'http://localhost:8080',
  serveStatic: process.env.SERVE_STATIC === 'true',
  toncenterApiKey: process.env.TONCENTER_API_KEY || '',
  requireOnchain: process.env.REQUIRE_ONCHAIN === 'true',
  walletAddress: process.env.WALLET_ADDRESS || '',
  // Seller-buyer chat E2E encryption: 64 hex chars (32 bytes) for AES-256-GCM. Must match ubot/utradebot when shared.
  // Generate: openssl rand -hex 32  (or PowerShell: -join (0..31 | % { "{0:X2}" -f (Get-Random -Max 256) }))
  encryptionKey: process.env.ENCRYPTION_KEY || '',
  // Internal microservices (proxied via backend, keep host-bound)
  ubotUrl: process.env.UBOT_URL || 'http://ubot:3002',
  ubotApiKey: process.env.UBOT_API_KEY || process.env.UBOT_API_KEY || '',
  utradeUrl: process.env.UTRADE_URL || 'http://utradebot:3003',
  utradeApiKey: process.env.UTRADE_API_KEY || '',
  // Fix 3.3: dev auth requires explicit opt-in, never in production by accident
  allowDevAuth: process.env.ALLOW_DEV_AUTH === 'true',
};
