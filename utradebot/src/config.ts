import dotenv from 'dotenv';
dotenv.config();

function num(v: string | undefined, def: number): number {
  const n = Number(v);
  return Number.isFinite(n) ? n : def;
}

export const config = {
  botToken: process.env.UTRADE_BOT_TOKEN || process.env.BOT_TOKEN || '',
  apiId: num(process.env.API_ID, 0),
  apiHash: process.env.API_HASH || '',
  adminTelegramIds: (process.env.ADMIN_TELEGRAM_IDS || '').split(',').map(Number).filter(Boolean),
  databaseUrl: process.env.DATABASE_URL || '',
  encryptionKey: process.env.ENCRYPTION_KEY || '',
  port: num(process.env.PORT, 3003),
  apiKey: process.env.UTRADE_API_KEY || '',
  logLevel: process.env.LOG_LEVEL || 'info',
};

export function validateConfig(): string[] {
  const errs: string[] = [];
  if (!config.botToken) errs.push('UTRADE_BOT_TOKEN required (@BotFather)');
  if (!config.apiId) errs.push('API_ID required (https://my.telegram.org)');
  if (!config.apiHash) errs.push('API_HASH required');
  if (!config.databaseUrl) errs.push('DATABASE_URL required');
  if (config.encryptionKey && !/^[a-fA-F0-9]{64}$/.test(config.encryptionKey)) {
    errs.push('ENCRYPTION_KEY must be 64 hex chars (32 bytes)');
  }
  return errs;
}
