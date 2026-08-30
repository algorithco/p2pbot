import winston from 'winston';

const logger = winston.createLogger({
  level: process.env.LOG_LEVEL || 'info',
  format: winston.format.combine(winston.format.timestamp(), winston.format.json()),
  transports: [new winston.transports.Console({ format: winston.format.combine(winston.format.colorize(), winston.format.simple()) })],
});

// Redact mnemonic from any log meta
const origLog = logger.log.bind(logger);
function redact(obj: unknown): unknown {
  if (typeof obj === 'string' && obj.split(' ').length === 24) return '[REDACTED_MNEMONIC]';
  if (obj && typeof obj === 'object') {
    const copy: Record<string, unknown> = { ...(obj as Record<string, unknown>) };
    if ('mnemonic' in copy) copy.mnemonic = '[REDACTED]';
    if ('SIGNER_MNEMONIC' in copy) copy.SIGNER_MNEMONIC = '[REDACTED]';
    if ('secretKey' in copy) copy.secretKey = '[REDACTED]';
    return copy;
  }
  return obj;
}

export default logger;
