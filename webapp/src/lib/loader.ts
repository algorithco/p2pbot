// loader.ts — 4.5s Mini App loading screen with TrueFocus word animation.
// "Xafsiz Savdo" cycles word-by-word (2.25s each: 0.7s glide + 1.55s hold),
// progress bar eased over the same 4500ms, then fade out + dispose.
// No Three.js — CSS aurora gradient only. Resolves when faded out.

import { prefersReducedMotion } from './motion';
import { mountTrueFocus, type TrueFocusHandle } from './true-focus';

const DURATION = 4500;

function easeInOutCubic(t: number): number {
  return t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2;
}

export function mountLoader(): Promise<void> {
  const root = document.getElementById('app-loader') as HTMLElement | null;
  if (!root) return Promise.resolve();

  const focusHost = root.querySelector('#loader-focus') as HTMLElement | null;
  const fill = root.querySelector('.loader-fill') as HTMLElement | null;
  const pctEl = root.querySelector('.loader-pct') as HTMLElement | null;

  // progress driver — 0→1 over 4500ms with easeInOutCubic
  let progress = 0;
  const setProgress = (p: number) => {
    progress = Math.max(0, Math.min(1, p));
    if (fill) fill.style.width = (progress * 100).toFixed(2) + '%';
    if (pctEl) pctEl.textContent = Math.round(progress * 100) + '%';
  };

  const t0 = performance.now();
  let rafProg = 0;
  let doneResolve: () => void;
  const donePromise = new Promise<void>((r) => (doneResolve = r));

  function tickProgress(now: number) {
    const t = Math.min(1, (now - t0) / DURATION);
    setProgress(easeInOutCubic(t));
    if (t < 1) rafProg = requestAnimationFrame(tickProgress);
  }
  rafProg = requestAnimationFrame(tickProgress);

  // TrueFocus hero: 2 words × (0.7s glide + 1.55s hold) = 4.5s exactly.
  let focus: TrueFocusHandle | null = null;
  try {
    if (focusHost) {
      focus = mountTrueFocus(focusHost, {
        sentence: 'Xafsiz Savdo',
        blurAmount: 5,
        borderColor: '#3b82f6',
        glowColor: 'rgba(59, 130, 246, 0.6)',
        animationDuration: 0.7,
        pauseBetweenAnimations: 1.55,
        className: 'focus-loader',
      });
    }
  } catch {
    // Do nothing — bar + fade still run without the word animation.
  }

  const finish = () => {
    cancelAnimationFrame(rafProg);
    setProgress(1);
    root.classList.add('hide');
    // allow CSS transition (420ms) then remove
    setTimeout(() => {
      try {
        focus?.destroy();
      } catch {}
      try {
        root.remove();
      } catch {
        root.style.display = 'none';
      }
      doneResolve();
    }, 460);
  };

  // Reduced motion: static frame is handled inside TrueFocus; timing unchanged.
  void prefersReducedMotion();
  setTimeout(finish, DURATION);
  return donePromise;
}
