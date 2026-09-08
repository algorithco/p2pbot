// src/logger.ts
import winston from 'winston';

const logger = winston.createLogger({
  level: 'info',
  format: winston.format.combine(
    winston.format.timestamp({ format: 'YYYY-MM-DD HH:mm:ss' }),
    winston.format.errors({ stack: true }),
    winston.format.json()
  ),
  transports: [
    new winston.transports.Console({
      format: winston.format.combine(
        winston.format.colorize(),
        winston.format.simple()
      ),
    }),
    // You can add file transports if needed
  ],
});

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

export default logger;
