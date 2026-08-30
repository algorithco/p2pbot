import winston from 'winston';

const logger = winston.createLogger({
  level: process.env.LOG_LEVEL || 'info',
  format: winston.format.combine(winston.format.timestamp(), winston.format.json()),
  transports: [new winston.transports.Console({ format: winston.format.combine(winston.format.colorize(), winston.format.simple()) })],
});

export default logger;

// Helper to redact secrets
export function redactSecrets(obj: Record<string, unknown>): Record<string, unknown> {
  const copy = { ...obj };
  for (const k of ['session', 'UBOT_SESSION_STRING', 'ENCRYPTION_KEY', 'API_HASH', 'TWO_FA_PASSWORD']) {
    if (k in copy) copy[k] = '[REDACTED]';
  }
  return copy;
}
