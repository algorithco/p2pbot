// lib/gooey-nav.ts — floating transparent circular bottom nav.
// Replaces the old GooeyNav pill with a minimal premium design:
// transparent shell, 5 circular buttons, outline icons, subtle circular
// active highlight. API kept (mountGooeyNav / sync / setActive) so the
// hash router in patches.ts keeps working unchanged.

export interface GooeyNavItem {
  label: string;
  /** Hash route, e.g. '#/home'. Used for href (a11y) and silent sync matching. */
  hash: string;
  /** Inline SVG string rendered above the label. */
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
  /** Activate an item. animate is kept for compat (no-op, CSS handles it). */
  setActive(index: number, animate?: boolean): void;
  /** Match a location.hash to an item; unknown hashes keep the current one. */
  sync(hash: string): void;
  destroy(): void;
}

export function mountGooeyNav(container: HTMLElement, opts: GooeyNavOptions): GooeyNavHandle {
  const items = opts.items ?? [];
  const maxIndex = Math.max(0, items.length - 1);
  let activeIndex = Math.min(Math.max(opts.initialActiveIndex ?? 0, 0), maxIndex);
  let destroyed = false;

  // ── DOM: ul > li > a.float-tab > span.float-circle + span.float-label ──
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
  root.appendChild(nav);
  container.appendChild(root);

  function setActive(index: number, _animate = true): void {
    if (destroyed || index < 0 || index > maxIndex) return;
    if (!lis[index]) return;
    activeIndex = index;
    lis.forEach((li, i) => li.classList.toggle('active', i === index));
    links.forEach((a, i) => {
      if (i === index) a.setAttribute('aria-current', 'page');
      else a.removeAttribute('aria-current');
    });
    void _animate;
  }

  function handleClick(index: number): void {
    if (index === activeIndex) {
      // Re-tap on active tab still navigates (e.g. scroll-to-top handled by router).
      try {
        opts.onSelect?.(index, items[index]);
      } catch {
        // Navigation must never throw.
      }
      return;
    }
    setActive(index, true);
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
      root.remove();
    } catch {
      // Do nothing
    }
  }

  return { setActive, sync, destroy };
}
