// lib/gooey-nav.ts — vanilla TypeScript port of React Bits GooeyNav (JS + CSS variant).
// Gooey pill + bubble particles, adapted to our bottom nav: the buttons stay
// circular/transparent/background-free, so the effect tracks the icon circle
// (`.float-circle`) instead of the whole item — the goo stays circular, never
// a rectangle. The sliding text effect is kept in DOM but hidden by CSS
// (icons don't need moving text). Framework-free so the legacy hash router
// keeps working: selection is reported via onSelect, external route changes
// (back button, programmatic go()) sync silently via sync().

export interface GooeyNavItem {
  label: string;
  /** Hash route, e.g. '#/home'. Used for href (a11y) and silent sync matching. */
  hash: string;
  /** Inline SVG string rendered inside the circular touch target. */
  icon?: string;
}

export interface GooeyNavOptions {
  items: GooeyNavItem[];
  animationTime?: number;
  particleCount?: number;
  particleDistances?: [number, number];
  particleR?: number;
  timeVariance?: number;
  colors?: number[];
  initialActiveIndex?: number;
  onSelect?: (index: number, item: GooeyNavItem) => void;
}

export interface GooeyNavHandle {
  /** Activate an item. animate=false moves the pill silently (route sync). */
  setActive(index: number, animate?: boolean): void;
  /** Match a location.hash to an item; unknown hashes keep the current one. */
  sync(hash: string): void;
  destroy(): void;
}

interface ParticleSpec {
  start: [number, number];
  end: [number, number];
  time: number;
  scale: number;
  color: number;
  rotate: number;
}

export function mountGooeyNav(container: HTMLElement, opts: GooeyNavOptions): GooeyNavHandle {
  const animationTime = opts.animationTime ?? 600;
  const particleCount = opts.particleCount ?? 15;
  const particleDistances = opts.particleDistances ?? ([90, 10] as [number, number]);
  const particleR = opts.particleR ?? 100;
  const timeVariance = opts.timeVariance ?? 300;
  const colors = opts.colors ?? [1, 2, 3, 1, 2, 3, 1, 4];
  const items = opts.items ?? [];
  const maxIndex = Math.max(0, items.length - 1);
  let activeIndex = Math.min(Math.max(opts.initialActiveIndex ?? 0, 0), maxIndex);
  let destroyed = false;

  const timers = new Set<number>();
  const later = (fn: () => void, ms: number): void => {
    const id = window.setTimeout(() => {
      timers.delete(id);
      if (!destroyed) fn();
    }, ms);
    timers.add(id);
  };

  const reducedMotion = (): boolean => {
    try {
      return window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    } catch {
      return false;
    }
  };

  // ── DOM: ul > li.float-item > a.float-tab > span.float-circle + span.float-label ──
  const root = document.createElement('div');
  root.className = 'gooey-nav-container float-nav';
  const nav = document.createElement('nav');
  nav.setAttribute('aria-label', 'Main navigation');
  const ul = document.createElement('ul');
  ul.className = 'float-list';
  const lis: HTMLElement[] = [];
  const links: HTMLAnchorElement[] = [];
  items.forEach((item, index) => {
    const li = document.createElement('li');
    li.className = 'float-item';
    if (index === activeIndex) li.classList.add('active');
    // First item (+ / create) is always emphasized — CSS hooks on .is-create.
    if (item.hash === '#/create') li.classList.add('is-create');
    const a = document.createElement('a');
    a.href = item.hash;
    a.className = 'float-tab';
    a.setAttribute('aria-label', item.label);
    if (index === activeIndex) a.setAttribute('aria-current', 'page');
    const circle = document.createElement('span');
    circle.className = 'float-circle';
    circle.setAttribute('aria-hidden', 'true');
    if (item.icon) circle.innerHTML = item.icon;
    const lb = document.createElement('span');
    lb.className = 'float-label';
    lb.textContent = item.label;
    a.appendChild(circle);
    a.appendChild(lb);
    a.addEventListener('click', (e) => {
      e.preventDefault();
      handleClick(index);
    });
    a.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault();
        handleClick(index);
      }
    });
    li.appendChild(a);
    ul.appendChild(li);
    lis.push(li);
    links.push(a);
  });
  nav.appendChild(ul);
  const filter = document.createElement('span');
  filter.className = 'effect filter';
  const text = document.createElement('span');
  text.className = 'effect text';
  root.appendChild(nav);
  root.appendChild(filter);
  root.appendChild(text);
  container.appendChild(root);

  // ── Physics (ported 1:1 from the React Bits source) ──
  const noise = (n = 1): number => n / 2 - Math.random() * n;

  const getXY = (distance: number, pointIndex: number, totalPoints: number): [number, number] => {
    const angle = ((360 + noise(8)) / totalPoints) * pointIndex * (Math.PI / 180);
    return [distance * Math.cos(angle), distance * Math.sin(angle)];
  };

  const createParticle = (i: number, t: number, d: [number, number], r: number): ParticleSpec => {
    const rotate = noise(r / 10);
    return {
      start: getXY(d[0], particleCount - i, particleCount),
      end: getXY(d[1] + noise(7), particleCount - i, particleCount),
      time: t,
      scale: 1 + noise(0.2),
      color: colors[Math.floor(Math.random() * colors.length)],
      rotate: rotate > 0 ? (rotate + r / 20) * 10 : (rotate - r / 20) * 10,
    };
  };

  const makeParticles = (element: HTMLElement): void => {
    if (reducedMotion()) return;
    const d = particleDistances;
    const r = particleR;
    const bubbleTime = animationTime * 2 + timeVariance;
    element.style.setProperty('--time', `${bubbleTime}ms`);

    for (let i = 0; i < particleCount; i++) {
      const t = animationTime * 2 + noise(timeVariance * 2);
      const p = createParticle(i, t, d, r);
      element.classList.remove('active');

      later(() => {
        const particle = document.createElement('span');
        const point = document.createElement('span');
        particle.classList.add('particle');
        particle.style.setProperty('--start-x', `${p.start[0]}px`);
        particle.style.setProperty('--start-y', `${p.start[1]}px`);
        particle.style.setProperty('--end-x', `${p.end[0]}px`);
        particle.style.setProperty('--end-y', `${p.end[1]}px`);
        particle.style.setProperty('--time', `${p.time}ms`);
        particle.style.setProperty('--scale', `${p.scale}`);
        particle.style.setProperty('--color', `var(--color-${p.color}, white)`);
        particle.style.setProperty('--rotate', `${p.rotate}deg`);

        point.classList.add('point');
        particle.appendChild(point);
        element.appendChild(particle);
        requestAnimationFrame(() => {
          element.classList.add('active');
        });
        later(() => {
          try {
            element.removeChild(particle);
          } catch {
            // Do nothing
          }
        }, t);
      }, 30);
    }
  };

  // The pill follows the icon circle (not the whole item) so the gooey
  // highlight stays circular and the label below never gets covered.
  const updateEffectPosition = (item: HTMLElement): void => {
    const anchor = item.querySelector('.float-circle') ?? item;
    const containerRect = root.getBoundingClientRect();
    const pos = anchor.getBoundingClientRect();
    const styles: Record<string, string> = {
      left: `${pos.x - containerRect.x}px`,
      top: `${pos.y - containerRect.y}px`,
      width: `${pos.width}px`,
      height: `${pos.height}px`,
    };
    Object.assign(filter.style, styles);
    Object.assign(text.style, styles);
    // Label span only — badges/extra nodes appended to the item must not
    // leak into the sliding text (e.g. "Bosh sahifa3").
    try {
      text.innerText = item.querySelector('.float-label')?.textContent ?? item.innerText;
    } catch {
      text.innerText = item.innerText;
    }
  };

  const clearParticles = (): void => {
    try {
      filter.querySelectorAll('.particle').forEach((p) => filter.removeChild(p));
    } catch {
      // Do nothing
    }
  };

  function setActive(index: number, animate = true): void {
    if (destroyed || index < 0 || index > maxIndex) return;
    const liEl = lis[index];
    if (!liEl) return;
    const changed = index !== activeIndex;
    activeIndex = index;
    lis.forEach((li, i) => li.classList.toggle('active', i === index));
    links.forEach((a, i) => {
      if (i === index) a.setAttribute('aria-current', 'page');
      else a.removeAttribute('aria-current');
    });
    updateEffectPosition(liEl);
    // Keep the goo pill persistently visible: mount + silent syncs never run
    // makeParticles (previously the only place adding .active to filter),
    // which left the dark active icon on the dark background with no pill.
    filter.classList.remove('active');
    void filter.offsetWidth;
    filter.classList.add('active');
    text.classList.remove('active');
    void text.offsetWidth;
    text.classList.add('active');
    if (changed && animate) {
      clearParticles();
      makeParticles(filter);
    }
  }

  function handleClick(index: number): void {
    if (index !== activeIndex) setActive(index, true);
    try {
      opts.onSelect?.(index, items[index]);
    } catch {
      // Do nothing — navigation must never break the animation.
    }
  }

  function sync(hash: string): void {
    const h = hash || '#/home';
    let found = -1;
    for (let i = 0; i < items.length; i++) {
      const ih = items[i].hash;
      if (h === ih) {
        found = i;
        break;
      }
      // Deep links (#/deal/…, #/create/…) keep the closest parent tab highlighted.
      if (ih === '#/home' && (h === '' || h === '#/home')) {
        found = i;
        break;
      }
      if (ih !== '#/home' && ih !== '#/create' && h.startsWith(ih)) {
        found = i;
        break;
      }
    }
    if (found !== -1 && found !== activeIndex) setActive(found, false);
  }

  function destroy(): void {
    destroyed = true;
    try {
      ro.disconnect();
    } catch {
      // Do nothing
    }
    try {
      window.removeEventListener('resize', reposition);
    } catch {
      // Do nothing
    }
    timers.forEach((id) => window.clearTimeout(id));
    timers.clear();
    try {
      root.remove();
    } catch {
      // Do nothing
    }
  }

  // ── Mount positioning + resize tracking ──
  const reposition = (): void => {
    if (destroyed) return;
    const liEl = lis[activeIndex];
    if (liEl) {
      updateEffectPosition(liEl);
      filter.classList.add('active');
      text.classList.add('active');
    }
  };
  const ro = new ResizeObserver(() => reposition());
  try {
    ro.observe(root);
  } catch {
    // Do nothing
  }
  window.addEventListener('resize', reposition);
  requestAnimationFrame(() => reposition());
  try {
    (document as Document).fonts?.ready.then(() => reposition()).catch(() => {});
  } catch {
    // Do nothing
  }

  return { setActive, sync, destroy };
}
