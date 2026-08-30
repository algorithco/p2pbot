import dotenv from 'dotenv';
dotenv.config();

function num(v: string | undefined, def: number): number {
  const n = Number(v);
  return Number.isFinite(n) ? n : def;
}

export const config = {
  apiId: num(process.env.API_ID, 0),
  apiHash: process.env.API_HASH || '',
  sessionString: process.env.UBOT_SESSION_STRING || '',
  phone: process.env.UBOT_PHONE || '',
  twoFaPassword: process.env.TWO_FA_PASSWORD || '',
  encryptionKey: process.env.ENCRYPTION_KEY || '',
  port: num(process.env.PORT, 3002),
  apiKey: process.env.UBOT_API_KEY || '',
  databaseUrl: process.env.DATABASE_URL || '',
  logLevel: process.env.LOG_LEVEL || 'info',
};

export function validateConfig(): string[] {
  const errs: string[] = [];
  if (!config.apiId) errs.push('API_ID required (https://my.telegram.org)');
  if (!config.apiHash) errs.push('API_HASH required');
  if (config.encryptionKey && !/^[a-fA-F0-9]{64}$/.test(config.encryptionKey)) {
    errs.push('ENCRYPTION_KEY must be 64 hex chars (32 bytes)');
  }
  return errs;
}
