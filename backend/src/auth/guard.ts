// src/auth/guard.ts
import type { NextFunction, Request, RequestHandler, Response } from 'express';
import { createHash, timingSafeEqual } from 'node:crypto';
import { config } from '../config';
import logger from '../logger';
import { validateInitData } from './initData';

let devWarned = false;

/** Timing-safe string comparison: sha256 both sides first so lengths always match. */
export function timingSafeStringEqual(a: unknown, b: unknown): boolean {
  const ha = createHash('sha256').update(String(a)).digest();
  const hb = createHash('sha256').update(String(b)).digest();
  return timingSafeEqual(ha, hb);
}

export function isValidPositiveInt(value: unknown): boolean {
  const n = Number(value);
  return Number.isInteger(n) && n > 0;
}

function extractProvidedApiKey(req: Request): string | null {
  const header = req.headers['x-api-key'];
  if (typeof header === 'string' && header.length > 0) return header;
  const query = req.query.api_key;
  if (typeof query === 'string' && query.length > 0) return query;
  if (Array.isArray(query) && query.length > 0 && typeof query[0] === 'string') {
    return query[0];
  }
  return null;
}

function apiKeyMatches(req: Request): boolean {
  if (!config.apiKey) return false;
  const provided = extractProvidedApiKey(req);
  return provided !== null && timingSafeStringEqual(provided, config.apiKey);
}

/**
 * Attach-only identity middleware — never rejects.
 * Priority: valid Telegram initData > api-key > dev header fallback > anonymous.
 */
export const identityAuth: RequestHandler = (req, _res, next) => {
  const initDataHeader = req.headers['x-init-data'];
  if (typeof initDataHeader === 'string' && initDataHeader.length > 0 && config.botToken) {
    const result = validateInitData(initDataHeader, config.botToken);
    if (result.ok && result.user) {
      req.user = result.user;
      req.authMode = 'telegram';
      return next();
    }
  }

  if (apiKeyMatches(req)) {
    req.authMode = 'api-key';
    return next();
  }

  if (!config.botToken && !config.apiKey) {
    if (!devWarned) {
      devWarned = true;
      logger.warn('AUTH DEV MODE — do not run in prod');
    }
    const headerId = req.headers['x-telegram-user-id'];
    const id = Number(Array.isArray(headerId) ? headerId[0] : headerId);
    if (isValidPositiveInt(id)) {
      req.user = { id };
      req.authMode = 'dev';
    }
  }

  return next(); // anonymous
};

/** 401 unless a verified user is attached or the caller authenticated via api-key. */
export const requireIdentity: RequestHandler = (req, res, next) => {
  if (req.user || req.authMode === 'api-key') return next();
  return res.status(401).json({ error: 'identity_required' });
};

/**
 * Best-known caller telegram id.
 * Verified req.user.id wins; body.telegramId override only for trusted api-key callers.
 */
export function getIdentityId(req: Request): number | null {
  if (req.user && isValidPositiveInt(req.user.id)) return req.user.id;
  if (
    req.authMode === 'api-key' &&
    req.body &&
    typeof req.body === 'object' &&
    isValidPositiveInt((req.body as Record<string, unknown>).telegramId)
  ) {
    return Number((req.body as Record<string, unknown>).telegramId);
  }
  return null;
}

/** Admins pass via verified identity membership; api-key callers are server-to-server admins. */
export const requireAdmin: RequestHandler = (req, res, next) => {
  if (req.authMode === 'api-key') return next();
  if (
    req.user &&
    isValidPositiveInt(req.user.id) &&
    config.adminTelegramIds.map(Number).includes(Number(req.user.id))
  ) {
    return next();
  }
  return res.status(403).json({ error: 'forbidden' });
};

export interface RateLimitOptions {
  windowMs: number;
  max: number;
  /** Route bucket name used in the per-ip key (e.g. 'notify', 'chat-post'). */
  name?: string;
}

/**
 * In-memory sliding-window rate limiter keyed by ip + route-bucket name.
 * Returns 429 {error:'rate_limited'} with Retry-After once max hits/window exceeded.
 */
export function rateLimit(options: RateLimitOptions): RequestHandler {
  const windowMs = Math.max(1, Math.floor(options.windowMs));
  const max = Math.max(1, Math.floor(options.max));
  const hits = new Map<string, number[]>();

  const pruneExpired = (now: number) => {
    for (const [key, times] of hits) {
      const alive = times.filter((t) => now - t < windowMs);
      if (alive.length === 0) hits.delete(key);
      else hits.set(key, alive);
    }
  };

  return (req, res, next) => {
    const now = Date.now();
    if (hits.size > 10000) pruneExpired(now);

    const ip = req.ip || req.socket?.remoteAddress || 'unknown';
    const key = `${ip}|${options.name || 'default'}`;
    const times = (hits.get(key) || []).filter((t) => now - t < windowMs);

    if (times.length >= max) {
      const retryAfterSec = Math.max(1, Math.ceil((times[0] + windowMs - now) / 1000));
      res.setHeader('Retry-After', String(retryAfterSec));
      return res.status(429).json({ error: 'rate_limited' });
    }

    times.push(now);
    hits.set(key, times);
    return next();
  };
}
