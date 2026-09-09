// lib/true-focus.ts — vanilla TypeScript port of React Bits TrueFocus (JS + CSS variant).
// Word-by-word focus animation: inactive words blurred, corner-bracket frame
// glides to the active word. Framework-free; the frame moves via CSS
// transition (same duration prop as upstream's motion.div) with a smooth
// easeInOut glide, auto-cycling via interval. Reduced-motion: static sharp
// render, no cycling.

// Smooth glide for the frame, soft fade for the blur — no linear steps.
const FRAME_EASE = 'cubic-bezier(0.65, 0, 0.35, 1)';
const BLUR_EASE = 'cubic-bezier(0.4, 0, 0.2, 1)';

export interface TrueFocusOptions {
  sentence?: string;
  separator?: string;
  manualMode?: boolean;
  blurAmount?: number;
  borderColor?: string;
  glowColor?: string;
  /** Seconds per word transition. */
  animationDuration?: number;
  /** Seconds to hold each word in auto mode. */
  pauseBetweenAnimations?: number;
  /** Extra class on the container (e.g. size variants). */
  className?: string;
}

export interface TrueFocusHandle {
  destroy(): void;
  setIndex(index: number): void;
}

export function mountTrueFocus(container: HTMLElement, opts: TrueFocusOptions = {}): TrueFocusHandle {
  const {
    sentence = 'True Focus',
    separator = ' ',
    manualMode = false,
    blurAmount = 5,
    borderColor = 'green',
    glowColor = 'rgba(0, 255, 0, 0.6)',
    animationDuration = 0.5,
    pauseBetweenAnimations = 1,
    className = '',
  } = opts;

  const words = sentence.split(separator);
  const maxIndex = Math.max(0, words.length - 1);
  let currentIndex = 0;
  let lastActiveIndex: number | null = null;
  let destroyed = false;
  let timer = 0;

  const reducedMotion = (): boolean => {
    try {
      return window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    } catch {
      return false;
    }
  };
  const staticMode = reducedMotion();

  const root = document.createElement('div');
  root.className = `focus-container${className ? ` ${className}` : ''}`;

  const wordEls: HTMLElement[] = [];
  words.forEach((word, index) => {
    const w = document.createElement('span');
    w.className = 'focus-word';
    if (manualMode) w.classList.add('manual');
    w.textContent = word;
    w.style.setProperty('--border-color', borderColor);
    w.style.setProperty('--glow-color', glowColor);
    w.style.transition = `filter ${animationDuration}s ${BLUR_EASE}`;
    if (manualMode) {
      w.addEventListener('mouseenter', () => {
        lastActiveIndex = index;
        setIndex(index);
      });
      w.addEventListener('mouseleave', () => {
        if (lastActiveIndex !== null) setIndex(lastActiveIndex);
      });
    }
    root.appendChild(w);
    wordEls.push(w);
  });

  const frame = document.createElement('div');
  frame.className = 'focus-frame';
  frame.setAttribute('aria-hidden', 'true');
  frame.style.setProperty('--border-color', borderColor);
  frame.style.setProperty('--glow-color', glowColor);
  frame.style.transition = `left ${animationDuration}s ${FRAME_EASE}, top ${animationDuration}s ${FRAME_EASE}, width ${animationDuration}s ${FRAME_EASE}, height ${animationDuration}s ${FRAME_EASE}, opacity ${animationDuration}s ease`;
  frame.style.opacity = '0';
  ['top-left', 'top-right', 'bottom-left', 'bottom-right'].forEach((pos) => {
    const c = document.createElement('span');
    c.className = `corner ${pos}`;
    frame.appendChild(c);
  });
  root.appendChild(frame);
  container.appendChild(root);

  function paint(): void {
    wordEls.forEach((w, i) => {
      const isActive = i === currentIndex;
      w.classList.toggle('active', isActive && !manualMode);
      w.style.filter = isActive ? 'blur(0px)' : `blur(${blurAmount}px)`;
    });
    const active = wordEls[currentIndex];
    if (!active) {
      frame.style.opacity = '0';
      return;
    }
    try {
      const parentRect = root.getBoundingClientRect();
      const r = active.getBoundingClientRect();
      frame.style.left = `${r.left - parentRect.left}px`;
      frame.style.top = `${r.top - parentRect.top}px`;
      frame.style.width = `${r.width}px`;
      frame.style.height = `${r.height}px`;
      frame.style.opacity = '1';
    } catch {
      // Do nothing — frame stays hidden until measurable.
    }
  }

  function setIndex(index: number): void {
    if (destroyed || index < 0 || index > maxIndex) return;
    currentIndex = index;
    paint();
  }

  // Mount positioning (fonts/layout shift the words after first paint).
  const reposition = (): void => {
    if (!destroyed) paint();
  };
  requestAnimationFrame(() => paint());
  try {
    (document as Document).fonts?.ready.then(() => reposition()).catch(() => {});
  } catch {
    // Do nothing
  }
  window.addEventListener('resize', reposition);

  if (!manualMode && !staticMode && words.length > 1) {
    timer = window.setInterval(
      () => {
        if (destroyed) return;
        currentIndex = (currentIndex + 1) % words.length;
        paint();
      },
      (animationDuration + pauseBetweenAnimations) * 1000,
    );
  } else {
    paint();
  }

  function destroy(): void {
    destroyed = true;
    try {
      window.clearInterval(timer);
    } catch {
      // Do nothing
    }
    try {
      window.removeEventListener('resize', reposition);
    } catch {
      // Do nothing
    }
    try {
      root.remove();
    } catch {
      // Do nothing
    }
  }

  return { destroy, setIndex };
}
