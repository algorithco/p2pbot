// hero-scene.ts — optional Three.js hero backdrop for the Home view.
// Lazy: three.js is dynamically imported only when the guard passes.
// Guards: reduced motion, low-end devices, hidden tab, hard dispose.
import { prefersReducedMotion } from './motion';

const ACCENT = 0x3b82f6;
const ACCENT_2 = 0x6366f1;
const SUCCESS = 0x34d399;

function lowEnd(): boolean {
  try {
    const nav = navigator as any;
    if (nav.deviceMemory && nav.deviceMemory < 4) return true;
    if (nav.hardwareConcurrency && nav.hardwareConcurrency <= 2) return true;
    const c = nav.connection || nav.mozConnection || nav.webkitConnection;
    if (c && c.saveData) return true;
  } catch { /* ignore */ }
  return false;
}

export function mountHeroScene(host: HTMLElement): () => void {
  if (!host) return () => {};
  if (prefersReducedMotion() || lowEnd()) {
    host.classList.add('hero-aurora');
    return () => { try { host.classList.remove('hero-aurora'); } catch {} };
  }

  let disposed = false;
  let cleanup: (() => void) | null = null;

  import('three').then((THREE) => {
    if (disposed) return;

    const width = () => host.clientWidth || 320;
    const height = () => host.clientHeight || 160;

    const renderer = new THREE.WebGLRenderer({ alpha: true, antialias: true, powerPreference: 'low-power' });
    renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 1.5));
    renderer.setSize(width(), height());
    renderer.domElement.className = 'hero-canvas';
    host.insertBefore(renderer.domElement, host.firstChild);

    const scene = new THREE.Scene();
    const camera = new THREE.PerspectiveCamera(50, width() / height(), 0.1, 50);
    camera.position.set(0, 0, 7.5);

    // Wireframe icosahedron — premium "orbit" centerpiece
    const geo = new THREE.IcosahedronGeometry(2.35, 1);
    const wire = new THREE.LineSegments(
      new THREE.WireframeGeometry(geo),
      new THREE.LineBasicMaterial({ color: ACCENT, transparent: true, opacity: 0.28 }),
    );
    scene.add(wire);

    // Soft vertex glow points
    const pts = new THREE.Points(
      geo,
      new THREE.PointsMaterial({ color: ACCENT_2, size: 0.07, transparent: true, opacity: 0.85 }),
    );
    scene.add(pts);

    // Drifting particle field
    const count = 140;
    const positions = new Float32Array(count * 3);
    for (let i = 0; i < count; i++) {
      positions[i * 3] = (Math.random() - 0.5) * 14;
      positions[i * 3 + 1] = (Math.random() - 0.5) * 7;
      positions[i * 3 + 2] = (Math.random() - 0.5) * 6 - 1;
    }
    const fieldGeo = new THREE.BufferGeometry();
    fieldGeo.setAttribute('position', new THREE.BufferAttribute(positions, 3));
    const field = new THREE.Points(
      fieldGeo,
      new THREE.PointsMaterial({ color: SUCCESS, size: 0.045, transparent: true, opacity: 0.35 }),
    );
    scene.add(field);

    let raf = 0;
    let running = true;
    const clock = { t: 0, last: performance.now() };

    function tick() {
      if (!running) return;
      raf = requestAnimationFrame(tick);
      const now = performance.now();
      clock.t += Math.min(50, now - clock.last) / 1000;
      clock.last = now;
      wire.rotation.y = clock.t * 0.14;
      wire.rotation.x = Math.sin(clock.t * 0.11) * 0.22;
      pts.rotation.copy(wire.rotation);
      pts.position.y = Math.sin(clock.t * 0.5) * 0.12;
      field.rotation.z = clock.t * 0.012;
      camera.position.x = Math.sin(clock.t * 0.1) * 0.35;
      camera.lookAt(0, 0, 0);
      renderer.render(scene, camera);
    }

    function onVis() {
      if (document.hidden) {
        running = false;
        cancelAnimationFrame(raf);
      } else if (!disposed) {
        running = true;
        clock.last = performance.now();
        tick();
      }
    }
    function onResize() {
      if (disposed) return;
      const w = width(), h = height();
      camera.aspect = w / h;
      camera.updateProjectionMatrix();
      renderer.setSize(w, h);
    }

    document.addEventListener('visibilitychange', onVis);
    window.addEventListener('resize', onResize);
    raf = requestAnimationFrame(tick);

    cleanup = () => {
      disposed = true;
      running = false;
      cancelAnimationFrame(raf);
      document.removeEventListener('visibilitychange', onVis);
      window.removeEventListener('resize', onResize);
      try {
        renderer.domElement.remove();
        geo.dispose();
        fieldGeo.dispose();
        wire.geometry.dispose();
        (wire.material as any).dispose?.();
        (pts.material as any).dispose?.();
        (field.material as any).dispose?.();
        renderer.dispose();
      } catch { /* ignore */ }
    };
  }).catch(() => {
    // three failed to load — static gradient fallback
    host.classList.add('hero-aurora');
  });

  return () => {
    disposed = true;
    if (cleanup) cleanup();
    else host.classList.remove('hero-aurora');
  };
}
