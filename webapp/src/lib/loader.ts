// loader.ts — premium 2s Three.js loading screen
// Luxury escrow vault: dual wire rings + faceted core + particle field + aurora
// - Duration exactly 2000ms, smooth ease, 60fps
// - Guards: prefers-reduced-motion / low-end → CSS fallback only (no Three)
// - Auto-disposes, resolves promise when faded out

import { prefersReducedMotion } from './motion';

const ACCENT = 0x3b82f6;
const ACCENT2 = 0x6366f1;
const PURPLE = 0x8b5cf6;
const SUCCESS = 0x34d399;

function lowEnd(): boolean {
  try {
    const nav: any = navigator;
    // relaxed for Telegram Mini App — only skip Three on very low devices
    if (nav.deviceMemory && nav.deviceMemory <= 1.5) return true;
    if (nav.hardwareConcurrency && nav.hardwareConcurrency <= 1) return true;
    const c = nav.connection || nav.mozConnection || nav.webkitConnection;
    if (c && c.saveData) return true;
  } catch {}
  return false;
}

function easeInOutCubic(t: number): number {
  return t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2;
}
function easeOutExpo(t: number): number {
  return t === 1 ? 1 : 1 - Math.pow(2, -10 * t);
}

export function mountLoader(): Promise<void> {
  const root = document.getElementById('app-loader') as HTMLElement | null;
  if (!root) return Promise.resolve();

  const canvasWrap = root.querySelector('.loader-canvas-wrap') as HTMLElement | null;
  const fill = root.querySelector('.loader-fill') as HTMLElement | null;
  const pctEl = root.querySelector('.loader-pct') as HTMLElement | null;
  const prefersReduced = prefersReducedMotion();
  const isLowEnd = lowEnd();

  // progress driver — drives both bar and text, decoupled from Three clock
  let progress = 0;
  const setProgress = (p: number) => {
    progress = Math.max(0, Math.min(1, p));
    if (fill) fill.style.width = (progress * 100).toFixed(2) + '%';
    if (pctEl) pctEl.textContent = Math.round(progress * 100) + '%';
  };

  // animate progress 0→1 over 2000ms with easeInOutCubic
  const t0 = performance.now();
  const DURATION = 2000;
  let rafProg = 0;
  let doneResolve: () => void;
  const donePromise = new Promise<void>((r) => (doneResolve = r));

  function tickProgress(now: number) {
    const t = Math.min(1, (now - t0) / DURATION);
    setProgress(easeInOutCubic(t));
    if (t < 1) rafProg = requestAnimationFrame(tickProgress);
  }
  rafProg = requestAnimationFrame(tickProgress);

  // reduced / low-end: no Three, just progress + fade
  if (prefersReduced || isLowEnd || !canvasWrap) {
    setTimeout(() => {
      cancelAnimationFrame(rafProg);
      setProgress(1);
      root.classList.add('hide');
      // allow CSS transition (420ms) then remove
      setTimeout(() => {
        try { root.remove(); } catch { root.style.display = 'none'; }
        doneResolve();
      }, 460);
    }, DURATION);
    return donePromise;
  }

  // —— Premium Three.js scene ——
  let disposed = false;
  let renderer: any = null;
  let raf = 0;

  import('three')
    .then((THREE) => {
      if (disposed || !canvasWrap) return;

      const W = () => canvasWrap.clientWidth || 320;
      const H = () => canvasWrap.clientHeight || 320;
      const isCompact = W() < 360 || window.innerWidth < 500; // Telegram Mini App

      renderer = new THREE.WebGLRenderer({ alpha: true, antialias: !isCompact, powerPreference: isCompact ? 'low-power' : 'high-performance' });
      renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, isCompact ? 1.35 : 1.6));
      renderer.setSize(W(), H());
      renderer.domElement.style.width = '100%';
      renderer.domElement.style.height = '100%';
      renderer.domElement.style.display = 'block';
      canvasWrap.appendChild(renderer.domElement);

      const scene = new THREE.Scene();
      // fog for depth — subtle
      scene.fog = new THREE.Fog(0x0b0e14, isCompact ? 7 : 9, isCompact ? 14 : 18);

      const camera = new THREE.PerspectiveCamera(isCompact ? 46 : 44, W() / H(), 0.1, 40);
      camera.position.set(0, isCompact ? 0.32 : 0.45, isCompact ? 5.4 : 6.2);

      // lights — premium soft
      const ambient = new THREE.AmbientLight(0xffffff, 0.55);
      scene.add(ambient);
      const dir = new THREE.DirectionalLight(0xffffff, 1.15);
      dir.position.set(3, 5, 4);
      scene.add(dir);
      const accentLight = new THREE.PointLight(ACCENT, 18, 12);
      accentLight.position.set(-2.2, 1.2, 2.5);
      scene.add(accentLight);
      const purpleLight = new THREE.PointLight(PURPLE, 14, 12);
      purpleLight.position.set(2.2, -1.0, 2.0);
      scene.add(purpleLight);

      // —— core vault gem (faceted) — compact for Mini App ——
      const s = isCompact ? 0.82 : 1;
      const coreGeo = new THREE.IcosahedronGeometry(1.05 * s, 2);
      const coreMat = new THREE.MeshStandardMaterial({
        color: 0xeef3ff,
        metalness: 0.55,
        roughness: 0.18,
        emissive: ACCENT,
        emissiveIntensity: 0.18,
        flatShading: true,
      });
      const core = new THREE.Mesh(coreGeo, coreMat);
      scene.add(core);

      // inner glow shell (slightly larger, transparent backface)
      const shellGeo = new THREE.IcosahedronGeometry(1.14 * s, 1);
      const shellMat = new THREE.MeshBasicMaterial({
        color: ACCENT2,
        wireframe: true,
        transparent: true,
        opacity: 0.11,
      });
      const shell = new THREE.Mesh(shellGeo, shellMat as any);
      scene.add(shell);

      // —— dual escrow rings (vault door) — scaled for compact canvas ——
      const ringMatOuter = new THREE.MeshStandardMaterial({
        color: ACCENT,
        metalness: 0.72,
        roughness: 0.28,
        emissive: ACCENT,
        emissiveIntensity: 0.16,
      });
      const ringMatInner = new THREE.MeshStandardMaterial({
        color: PURPLE,
        metalness: 0.68,
        roughness: 0.31,
        emissive: PURPLE,
        emissiveIntensity: 0.14,
      });
      const seg = isCompact ? 64 : 96;
      const torusOuter = new THREE.Mesh(new THREE.TorusGeometry(1.92 * s, 0.055 * s, 20, seg), ringMatOuter);
      torusOuter.rotation.x = Math.PI / 2.35;
      scene.add(torusOuter);

      const torusInner = new THREE.Mesh(new THREE.TorusGeometry(1.52 * s, 0.042 * s, 18, seg), ringMatInner);
      torusInner.rotation.x = Math.PI / 2.35;
      torusInner.rotation.y = 0.45;
      scene.add(torusInner);

      // thin accent ring (wire)
      const accentRing = new THREE.Mesh(
        new THREE.TorusGeometry(2.18 * s, 0.012 * s, 12, seg),
        new THREE.MeshBasicMaterial({ color: SUCCESS, transparent: true, opacity: 0.36 }),
      );
      accentRing.rotation.x = Math.PI / 2.35;
      scene.add(accentRing);

      // —— orbital nodes (small gems on ring) ——
      const nodeGeo = new THREE.SphereGeometry(0.075, 10, 10);
      const nodeMat = new THREE.MeshStandardMaterial({ color: 0xffffff, emissive: 0xffffff, emissiveIntensity: 0.5, metalness: 0.2, roughness: 0.5 });
      const nodes: THREE.Mesh[] = [];
      for (let i = 0; i < 3; i++) {
        const m = new THREE.Mesh(nodeGeo, nodeMat);
        scene.add(m);
        nodes.push(m);
      }

      // —— particle field — lighter for Mini App (220 vs 420) ——
      const pCount = isCompact ? 180 : 260;
      const pPos = new Float32Array(pCount * 3);
      const pSizes = new Float32Array(pCount);
      for (let i = 0; i < pCount; i++) {
        const r = (isCompact ? 3.6 : 4.5) + Math.random() * (isCompact ? 4.2 : 5.5);
        const theta = Math.random() * Math.PI * 2;
        const y = (Math.random() - 0.5) * (isCompact ? 6 : 8.5);
        pPos[i * 3] = Math.cos(theta) * r;
        pPos[i * 3 + 1] = y;
        pPos[i * 3 + 2] = Math.sin(theta) * r * 0.35 - 2.2;
        pSizes[i] = Math.random() * 0.9 + 0.2;
      }
      const pGeo = new THREE.BufferGeometry();
      pGeo.setAttribute('position', new THREE.BufferAttribute(pPos, 3));
      const pMat = new THREE.PointsMaterial({
        color: 0x93c5fd,
        size: 0.058,
        transparent: true,
        opacity: 0.42,
        sizeAttenuation: true,
        blending: THREE.AdditiveBlending,
        depthWrite: false,
      });
      const particles = new THREE.Points(pGeo, pMat);
      scene.add(particles);

      // —— ground reflection disc (subtle) ——
      const disc = new THREE.Mesh(
        new THREE.CircleGeometry((isCompact ? 2.5 : 3.2), 40),
        new THREE.MeshBasicMaterial({ color: ACCENT, transparent: true, opacity: 0.055 }),
      );
      disc.rotation.x = -Math.PI / 2;
      disc.position.y = isCompact ? -1.45 : -1.85;
      scene.add(disc);

      // animation + timeline
      let tStart = performance.now();
      // expose hide hook
      const hideAfter = () => {
        // final pose snap
        setProgress(1);
      };

      function tick() {
        if (disposed) return;
        raf = requestAnimationFrame(tick);
        const now = performance.now();
        const elapsed = now - tStart;
        const u = Math.min(1, elapsed / DURATION); // 0..1 over 2s
        const eased = easeInOutCubic(u); // progress eased
        // keep progress in sync (also driven by separate raf, but lerp here so Three timeline is authoritative if faster)
        if (fill && Math.abs(progress - eased) > 0.01) setProgress(eased);

        // rotations — continuous, but ease in/out slightly
        const s = 0.35 + eased * 0.65; // speed ramp

        core.rotation.y += 0.012 * s;
        core.rotation.x = Math.sin(elapsed * 0.00055) * 0.18;
        core.rotation.z = Math.cos(elapsed * 0.00042) * 0.08;
        core.scale.setScalar(0.96 + Math.sin(elapsed * 0.0018) * 0.025 + eased * 0.03);
        (coreMat as any).emissiveIntensity = 0.16 + Math.sin(elapsed * 0.0022) * 0.04 + eased * 0.06;

        shell.rotation.y -= 0.008 * s;
        shell.rotation.x = core.rotation.x * 0.6;
        (shellMat as any).opacity = 0.09 + eased * 0.03;

        torusOuter.rotation.z += 0.010 * s;
        torusInner.rotation.z -= 0.014 * s;
        accentRing.rotation.z += 0.006 * s;

        // breathing rings scale
        const breath = 1 + Math.sin(elapsed * 0.0014) * 0.008;
        torusOuter.scale.setScalar(breath);
        torusInner.scale.setScalar(1 / breath);
        accentRing.scale.setScalar(breath);

        // orbital nodes
        nodes.forEach((n, i) => {
          const a = (elapsed * 0.0009 + (i * 2.094)) % (Math.PI * 2);
          const r = 1.92 * s;
          n.position.set(Math.cos(a) * r, Math.sin(a * 0.9) * 0.22 * s, Math.sin(a) * r);
          (n as any).material.emissiveIntensity = 0.45 + Math.sin(elapsed * 0.003 + i) * 0.2;
        });

        // particles drift
        particles.rotation.y += 0.0007 * s;
        particles.rotation.z += 0.00015;
        (pMat as any).opacity = 0.36 + Math.sin(elapsed * 0.001) * 0.06;

        // camera dolly + subtle parallax — compact keeps vault centered
        const baseZ = isCompact ? 5.45 : 6.25;
        camera.position.z = baseZ - eased * (isCompact ? 0.38 : 0.55);
        camera.position.x = Math.sin(elapsed * 0.00045) * (isCompact ? 0.28 : 0.45);
        camera.position.y = (isCompact ? 0.32 : 0.45) + Math.sin(elapsed * 0.00062) * 0.10;
        camera.lookAt(0, -0.02, 0);

        // lights pulse
        accentLight.intensity = 17 + Math.sin(elapsed * 0.002) * 2.5;
        purpleLight.intensity = 13 + Math.cos(elapsed * 0.0017) * 2;

        (disc.material as any).opacity = 0.045 + eased * 0.02;

        renderer.render(scene, camera);

        if (u >= 1) {
          // hold final frame, allow hide transition
          hideAfter();
        }
      }

      const onResize = () => {
        if (disposed) return;
        const w = W(), h = H();
        camera.aspect = w / h;
        camera.updateProjectionMatrix();
        renderer.setSize(w, h);
      };
      window.addEventListener('resize', onResize);

      // start
      raf = requestAnimationFrame(tick);

      // cleanup hook saved for dispose
      (renderer as any).__onResize = onResize;
      (renderer as any).__scene = scene;

      // ensure external timer can dispose
      const prevDisposed = () => disposed;
      (root as any).__threeDispose = () => {
        disposed = true;
        cancelAnimationFrame(raf);
        window.removeEventListener('resize', onResize);
        try {
          torusOuter.geometry.dispose();
          torusInner.geometry.dispose();
          (accentRing.geometry as any).dispose?.();
          coreGeo.dispose();
          shellGeo.dispose();
          nodeGeo.dispose();
          pGeo.dispose();
          (coreMat as any).dispose?.();
          (shellMat as any).dispose?.();
          (ringMatOuter as any).dispose?.();
          (ringMatInner as any).dispose?.();
          (pMat as any).dispose?.();
          (disc.geometry as any).dispose?.();
          (disc.material as any).dispose?.();
          renderer.dispose();
          renderer.domElement.remove();
        } catch {}
      };
    })
    .catch(() => {
      // fallback: keep CSS loader only
    });

  // schedule hide at exactly 2s
  setTimeout(() => {
    cancelAnimationFrame(rafProg);
    setProgress(1);
    // trigger CSS hide transition
    root.classList.add('hide');
    // dispose three after fade (allow 420ms)
    setTimeout(() => {
      disposed = true;
      try {
        const d = (root as any).__threeDispose as (() => void) | undefined;
        if (d) d();
      } catch {}
      cancelAnimationFrame(raf);
      try { root.remove(); } catch { root.style.display = 'none'; }
      doneResolve();
    }, 460);
  }, DURATION);

  return donePromise;
}
