import winston from 'winston';

const logger = winston.createLogger({
  level: process.env.LOG_LEVEL || 'info',
  format: winston.format.combine(winston.format.timestamp(), winston.format.json()),
  transports: [
    new winston.transports.Console({
      format: winston.format.combine(winston.format.colorize(), winston.format.simple()),
    }),
  ],
});

export default logger;

export function redact(obj: Record<string, unknown>): Record<string, unknown> {
  const c = { ...obj };
  for (const k of ['session', 'session_encrypted', 'ENCRYPTION_KEY', 'API_HASH', 'code', 'phoneCode']) {
    if (k in c) c[k] = '[REDACTED]';
  }
  return c;
}
