// motion.ts — central animation & effects toolkit.
// Uses Motion mini (~5KB, vanilla-DOM friendly) + canvas-confetti (lazy).
// Every helper no-ops gracefully under prefers-reduced-motion.

export function prefersReducedMotion(): boolean {
  try { return window.matchMedia('(prefers-reduced-motion: reduce)').matches; } catch { return false; }
}

const EASE_OUT: [number, number, number, number] = [0.16, 1, 0.3, 1];

/** Fade + rise-in a single element. */
export function fadeUp(el: HTMLElement, opts: { dur?: number; delay?: number; y?: number } = {}) {
  if (prefersReducedMotion() || !el) return;
  import('motion/mini').then(({ animate }) => {
    animate(el,
      { opacity: [0, 1], transform: [`translateY(${opts.y ?? 12}px)`, 'translateY(0px)'] },
      { duration: opts.dur ?? 0.32, delay: opts.delay ?? 0, ease: EASE_OUT },
    );
  }).catch(() => { try { el.style.opacity = '1'; } catch {} });
}

/** Stagger a list of elements in (deals, requests, trades…). */
export function staggerIn(
  els: HTMLElement[] | NodeListOf<Element> | HTMLCollection,
  opts: { y?: number; dur?: number; gap?: number } = {},
) {
  const list = Array.from(els as ArrayLike<HTMLElement>).filter(Boolean);
  if (prefersReducedMotion() || !list.length) return;
  import('motion/mini').then(({ animate }) => {
    const gap = (opts.gap ?? 0.05) * 1000; // ms between items
    list.forEach((el, i) => {
      try {
        animate(el,
          { opacity: [0, 1], transform: [`translateY(${opts.y ?? 14}px)`, 'translateY(0px)'] },
          { duration: opts.dur ?? 0.34, delay: (i * gap) / 1000, ease: EASE_OUT },
        );
      } catch { try { el.style.opacity = '1'; } catch {} }
    });
  }).catch(() => { list.forEach(el => { try { el.style.opacity = '1'; } catch {} }); });
}

/** Animated number count-up (stats, balances, amounts). */
export function countUp(
  el: HTMLElement,
  to: number,
  opts: { dur?: number; decimals?: number; suffix?: string; prefix?: string } = {},
) {
  if (!el) return;
  const fmt = (n: number) => {
    let s = n.toFixed(opts.decimals ?? 0);
    s = s.replace(/\.0+$/, '').replace(/(\.\d*?[1-9])0+$/, '$1');
    return (opts.prefix || '') + s + (opts.suffix || '');
  };
  const target = Number(to) || 0;
  if (prefersReducedMotion()) { el.textContent = fmt(target); return; }
  const dur = (opts.dur ?? 0.7) * 1000;
  const t0 = performance.now();
  function tick(now: number) {
    const p = Math.min(1, (now - t0) / dur);
    const eased = 1 - Math.pow(1 - p, 3); // easeOutCubic
    el.textContent = fmt(target * eased);
    if (p < 1) requestAnimationFrame(tick);
  }
  requestAnimationFrame(tick);
}

/** One-shot error shake — pair with a toast + haptic. */
export function shake(el: HTMLElement) {
  if (!el || prefersReducedMotion()) return;
  el.classList.remove('shake');
  // restart animation
  void (el as any).offsetWidth;
  el.classList.add('shake');
  const off = () => { el.classList.remove('shake'); el.removeEventListener('animationend', off); };
  el.addEventListener('animationend', off);
}

/** Success confetti burst (lazy-loads canvas-confetti). */
export function confetti(opts: { particleCount?: number; spread?: number; origin?: { x?: number; y?: number } } = {}) {
  if (prefersReducedMotion()) return;
  import('canvas-confetti').then(({ default: confettiFn }) => {
    confettiFn({
      particleCount: opts.particleCount ?? 90,
      spread: opts.spread ?? 72,
      startVelocity: 38,
      origin: opts.origin ?? { y: 0.68 },
      colors: ['#3b82f6', '#34d399', '#fbbf24', '#8b5cf6', '#ffffff'],
      disableForReducedMotion: true,
      zIndex: 300,
    });
  }).catch(() => { /* cosmetic only */ });
}

/** FLIP helper: animate `fromEl` rect → `toEl` rect (shared-element feel). */
export function flip(fromEl: HTMLElement, toEl: HTMLElement, opts: { dur?: number } = {}) {
  if (!fromEl || !toEl || prefersReducedMotion()) return;
  const a = fromEl.getBoundingClientRect();
  const b = toEl.getBoundingClientRect();
  const dx = a.left - b.left;
  const dy = a.top - b.top;
  const s = Math.max(0.5, Math.min(1.4, a.width / Math.max(1, b.width)));
  if (!isFinite(dx) || !isFinite(dy)) return;
  import('motion/mini').then(({ animate }) => {
    animate(toEl,
      { transform: [`translate(${dx}px, ${dy}px) scale(${s})`, 'translate(0px, 0px) scale(1)'] },
      { duration: opts.dur ?? 0.4, ease: EASE_OUT },
    );
  }).catch(() => {});
}

export const FX = {
  prefersReducedMotion, fadeUp, staggerIn, countUp, shake, confetti, flip,
};
export default FX;
