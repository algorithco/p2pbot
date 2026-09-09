import { withFloodWait } from './client';
import logger, { sanitizeLogValue } from './logger';

/**
 * Simple LRU cache with TTL (5m default, max 1000 entries).
 * Uses Map to preserve insertion order for LRU eviction.
 * Each entry stores { value, exp } where exp is epoch ms.
 */

interface CacheEntry<T> {
  value: T;
  exp: number;
}

export class EntityCache {
  private map = new Map<string, CacheEntry<unknown>>();
  private max: number;
  private ttlMs: number;

  constructor(max = 1000, ttlMs = 5 * 60 * 1000) {
    this.max = max;
    this.ttlMs = ttlMs;
  }

  get<T = unknown>(key: string): T | undefined {
    const k = String(key);
    const entry = this.map.get(k) as CacheEntry<T> | undefined;
    if (!entry) return undefined;
    if (Date.now() > entry.exp) {
      this.map.delete(k);
      return undefined;
    }
    // LRU: move to end (most recently used)
    this.map.delete(k);
    this.map.set(k, entry);
    return entry.value;
  }

  set<T = unknown>(key: string, value: T, ttlMs?: number): void {
    const k = String(key);
    const ttl = typeof ttlMs === 'number' ? ttlMs : this.ttlMs;
    const exp = Date.now() + ttl;
    if (this.map.has(k)) this.map.delete(k);
    this.map.set(k, { value, exp });
    // Evict oldest if over capacity
    while (this.map.size > this.max) {
      const oldestKey = this.map.keys().next().value as string | undefined;
      if (oldestKey === undefined) break;
      this.map.delete(oldestKey);
    }
  }

  has(key: string): boolean {
    const v = this.get(key);
    return v !== undefined;
  }

  delete(key: string): boolean {
    return this.map.delete(String(key));
  }

  clear(): void {
    this.map.clear();
  }

  /** Current size (excluding expired entries that haven't been accessed). */
  size(): number {
    return this.map.size;
  }

  /** Purge expired entries proactively. */
  purgeExpired(): void {
    const now = Date.now();
    for (const [k, e] of this.map) {
      if (now > e.exp) this.map.delete(k);
    }
  }
}

// Singleton used across the app — 5min TTL, 1000 entries max
export const entityCache = new EntityCache(1000, 5 * 60 * 1000);

// Backwards-compatible alias: some code may import `cache`
export const cache = entityCache;

// Separate cache for account.GetPassword (5min TTL) but we reuse same instance with distinct key prefix
// Alternatively a dedicated cache instance (kept for isolation)
export const passwordCache = new EntityCache(20, 5 * 60 * 1000);

/** Invalidate a cached entry by key. */
export function invalidate(key: string): void {
  entityCache.delete(key);
  // also try prefixed variants
  passwordCache.delete(key);
}

/** Alias for invalidate */
export const invalidateCache = invalidate;

/**
 * Cached wrapper for client.getEntity.
 * Checks cache first; on miss uses withFloodWait(client.getEntity) then caches.
 */
export async function cachedGetEntity(
  client: { getEntity: (id: string) => Promise<unknown> },
  idString: string,
): Promise<unknown> {
  const key = `entity:${String(idString)}`;
  const cached = entityCache.get(key);
  if (cached !== undefined) {
    logger.debug?.(`entityCache hit: ${sanitizeLogValue(key)}`);
    return cached;
  }
  const entity = await withFloodWait(() => client.getEntity(String(idString)) as Promise<unknown>);
  entityCache.set(key, entity);
  return entity;
}

/** Alias per task naming: getEntityCached */
export const getEntityCached = cachedGetEntity;
export const getCachedEntity = cachedGetEntity;

/**
 * Cached wrapper for client.getInputEntity (if available).
 * Falls back to getEntity caching if getInputEntity not present.
 */
export async function cachedGetInputEntity(
  client: { getInputEntity?: (id: string) => Promise<unknown>; getEntity: (id: string) => Promise<unknown> },
  idString: string,
): Promise<unknown> {
  const key = `inputEntity:${String(idString)}`;
  const cached = entityCache.get(key);
  if (cached !== undefined) return cached;
  let entity: unknown;
  if (typeof client.getInputEntity === 'function') {
    entity = await withFloodWait(() => (client.getInputEntity as (id: string) => Promise<unknown>)(String(idString)));
  } else {
    // Fallback: getEntity result can often be used as InputEntity
    entity = await cachedGetEntity(client as { getEntity: (id: string) => Promise<unknown> }, String(idString));
    // don't double-cache; already cached via cachedGetEntity
    return entity;
  }
  entityCache.set(key, entity);
  return entity;
}

export const getInputEntityCached = cachedGetInputEntity;

/**
 * Cached wrapper for account.GetPassword (5min TTL).
 * Uses dedicated passwordCache to avoid polluting entityCache.
 * Accepts a client with invoke method and Api namespace.
 */
export async function cachedGetPassword(client: { invoke: (req: unknown) => Promise<unknown> }): Promise<unknown> {
  const key = 'account:GetPassword';
  const cached = passwordCache.get(key);
  if (cached !== undefined) return cached;
  // Dynamic import to avoid hard dep on teleproto Api shape at top-level
  const { Api } = await import('teleproto');
  const res = await withFloodWait(() =>
    client.invoke(
      new (Api as unknown as { account: { GetPassword: new () => unknown } }).account.GetPassword() as unknown as never,
    ),
  );
  passwordCache.set(key, res);
  return res;
}

/** Invalidate the GetPassword cache (e.g., after password change). */
export function invalidatePasswordCache(): void {
  passwordCache.delete('account:GetPassword');
}
