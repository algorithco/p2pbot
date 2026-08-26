import dotenv from 'dotenv';
dotenv.config();

export const config = {
  botToken: process.env.BOT_TOKEN!,
  adminTelegramIds: (process.env.ADMIN_TELEGRAM_IDS || '').split(',').map(Number),
  databaseUrl: process.env.DATABASE_URL!,
  tonApiEndpoint: process.env.TON_API_ENDPOINT || 'https://tonapi.io',
  tonNetwork: process.env.TON_NETWORK || 'mainnet',
  mnemonic: process.env.MNEMONIC ? process.env.MNEMONIC.split(' ') : [],
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
  toncenterApiKey: process.env.TONCENTER_API_KEY || '',
  requireOnchain: process.env.REQUIRE_ONCHAIN === 'true',
  walletAddress: process.env.WALLET_ADDRESS || '',
};
