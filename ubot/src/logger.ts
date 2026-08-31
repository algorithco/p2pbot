import winston from 'winston';

const SENSITIVE_KEYS = ['session', 'UBOT_SESSION_STRING', 'ENCRYPTION_KEY', 'API_HASH', 'TWO_FA_PASSWORD', 'password', 'passwd', 'api_key', 'x-api-key'];

function redact(obj: unknown): unknown {
  if (!obj || typeof obj !== 'object') return obj;
  if (obj instanceof Error) {
    const msg = String((obj as Error).message || '');
    // Redact password hashes if error contains them (rare)
    let redacted = msg;
    for (const k of SENSITIVE_KEYS) {
      if (redacted.includes(k)) redacted = redacted.replace(new RegExp(k, 'gi'), '[REDACTED]');
    }
    return { message: redacted, stack: (obj as Error).stack?.slice(0, 500) };
  }
  const copy: Record<string, unknown> = { ...(obj as Record<string, unknown>) };
  for (const k of SENSITIVE_KEYS) {
    for (const key of Object.keys(copy)) {
      if (key.toLowerCase().includes(k.toLowerCase())) copy[key] = '[REDACTED]';
      if (typeof copy[key] === 'string' && String(copy[key]).length > 100 && /^[A-Za-z0-9+/=]+$/.test(String(copy[key]))) {
        // Long base64 string likely session — redact partially
        const s = String(copy[key]);
        copy[key] = s.slice(0, 8) + '...[REDACTED]...' + s.slice(-8);
      }
    }
  }
  return copy;
}

const logger = winston.createLogger({
  level: process.env.LOG_LEVEL || 'info',
  format: winston.format.combine(
    winston.format.timestamp(),
    winston.format.printf(({ level, message, timestamp, ...meta }) => {
      const metaStr = Object.keys(meta).length ? ' ' + JSON.stringify(redact(meta)) : '';
      const msgStr = typeof message === 'string' ? message : JSON.stringify(redact(message as unknown as Record<string, unknown>));
      return `${timestamp} ${level}: ${msgStr}${metaStr}`;
    })
  ),
  transports: [new winston.transports.Console({ format: winston.format.combine(winston.format.colorize(), winston.format.simple()) })],
});

export default logger;

// Helper to redact secrets
export function redactSecrets(obj: Record<string, unknown>): Record<string, unknown> {
  return redact(obj) as Record<string, unknown>;
}
