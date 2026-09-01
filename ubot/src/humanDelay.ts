/**
 * Human-like delay helpers to reduce ban risk.
 * All delays are jittered to avoid bot-like regularity.
 */

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Sleep for a random duration between minMs and maxMs.
 * Default 800-2500ms mirrors typical human pacing.
 */
export async function humanDelay(minMs = 800, maxMs = 2500): Promise<void> {
  const lo = Math.max(0, minMs);
  const hi = Math.max(lo, maxMs);
  const ms = lo + Math.random() * (hi - lo);
  await sleep(ms);
}

/**
 * Jittered delay around a base value.
 * @param base - base delay in ms
 * @param jitter - max jitter in ms (applied as ±jitter)
 * Sleeps for base ± jitter (clamped to >=0).
 * Example: jitteredDelay(1000, 300) => 700-1300ms
 */
export async function jitteredDelay(base: number, jitter: number): Promise<void> {
  const b = Math.max(0, base);
  const j = Math.max(0, jitter);
  const delta = (Math.random() * 2 - 1) * j; // -j .. +j
  const ms = Math.max(0, b + delta);
  await sleep(ms);
}

/**
 * Synchronous helper to get a random delay value without sleeping.
 * Useful for logging or for callers that need the value.
 */
export function randomDelayMs(minMs = 800, maxMs = 2500): number {
  const lo = Math.max(0, minMs);
  const hi = Math.max(lo, maxMs);
  return lo + Math.random() * (hi - lo);
}
