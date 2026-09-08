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

const isProd = process.env.NODE_ENV === 'production';
const logLevel = process.env.LOG_LEVEL || 'info';

const baseFormat = winston.format.combine(
  winston.format.timestamp(),
  winston.format.errors({ stack: true }),
  winston.format.printf(({ level, message, timestamp, stack, ...meta }) => {
    const metaStr = Object.keys(meta).length ? ' ' + JSON.stringify(redact(meta)) : '';
    const msgStr = typeof message === 'string' ? message : JSON.stringify(redact(message as unknown as Record<string, unknown>));
    const stackStr = stack ? `\n${String(stack).slice(0, 800)}` : '';
    return `${timestamp} ${level}: ${msgStr}${metaStr}${stackStr}`;
  })
);

const jsonFormat = winston.format.combine(winston.format.timestamp(), winston.format.errors({ stack: true }), winston.format.json());

const transports: winston.transport[] = [
  new winston.transports.Console({
    format: isProd ? jsonFormat : winston.format.combine(winston.format.colorize(), winston.format.simple(), baseFormat),
  }),
];

// In production try to add file transport if available (winston-daily-rotate-file)
if (isProd) {
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports, @typescript-eslint/no-var-requires
    const DailyRotateFile = require('winston-daily-rotate-file');
    transports.push(
      new DailyRotateFile({
        filename: 'logs/ubot-%DATE%.log',
        datePattern: 'YYYY-MM-DD',
        maxSize: '20m',
        maxFiles: '14d',
        format: jsonFormat,
        level: logLevel,
      })
    );
  } catch {
    // fallback: no file transport
  }
}

const logger = winston.createLogger({
  level: logLevel,
  format: baseFormat,
  transports,
  // Avoid exit on handled exceptions
  exitOnError: false,
});

export default logger;

// Helper to redact secrets
export function redactSecrets(obj: Record<string, unknown>): Record<string, unknown> {
  return redact(obj) as Record<string, unknown>;
}

/**
 * Sanitize user-controlled values before embedding in log messages.
 * Escapes control characters (newlines, CR, ANSI) so attackers cannot
 * forge/spoof log lines, and truncates overly long values.
 */
export function sanitizeLogValue(v: unknown, max = 200): string {
  let s: string;
  if (typeof v === 'string') s = v;
  else if (v === null || v === undefined) s = '';
  else {
    try { s = JSON.stringify(v); } catch { s = String(v); }
  }
  const escaped = s.replace(/[\x00-\x1F\x7F]/g, (c) => {
    if (c === '\n') return '\\n';
    if (c === '\r') return '\\r';
    return `\\x${c.charCodeAt(0).toString(16).padStart(2, '0')}`;
  });
  return escaped.length > max ? escaped.slice(0, max) + '…' : escaped;
}
