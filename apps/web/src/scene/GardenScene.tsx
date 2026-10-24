import { useEffect, useRef } from 'react';

/**
 * The autumn backdrop behind every page: a dusk sky, hills and gnarled trees
 * that sketch themselves in when the page opens, a stone garden wall with
 * pumpkins and a lantern, drifting fog, falling leaves and fireflies.
 *
 * Everything is procedural (seeded, so a page always shows the same woods)
 * and drawn on one canvas. Static layers are cached to offscreen canvases
 * once they have finished drawing in; each frame then only blits them and
 * moves the particles. Reduced-motion users get the finished still picture.
 */

export type SceneVariant = 'home' | 'lobby' | 'table';

interface Seg {
  x1: number;
  y1: number;
  x2: number;
  y2: number;
  w: number;
  /** Distance from the root at the segment start (drives the growth). */
  d0: number;
  len: number;
}

interface Tree {
  segs: Seg[];
  maxD: number;
  t0: number;
  dur: number;
}

interface Ridge {
  pts: Array<[number, number]>;
  color: string;
  edge: string;
  t0: number;
  dur: number;
}

interface Stone {
  x: number;
  y: number;
  w: number;
  h: number;
  shade: string;
  bumps: number[];
  t: number;
}

interface Pumpkin {
  x: number;
  y: number;
  r: number;
  t: number;
}

interface Leaf {
  x: number;
  y: number;
  vy: number;
  sway: number;
  phase: number;
  spin: number;
  rot: number;
  flip: number;
  size: number;
  sprite: number;
}

interface Fly {
  x: number;
  y: number;
  vx: number;
  vy: number;
  phase: number;
}

interface World {
  W: number;
  H: number;
  horizon: number;
  ground: number;
  ridges: Ridge[];
  pines: Array<{ x: number; base: number; h: number; t: number }>;
  farTrees: Tree[];
  nearTrees: Tree[];
  stones: Stone[];
  pumpkins: Pumpkin[];
  lantern: { x: number; y: number; t: number } | null;
  stars: Array<{ x: number; y: number; r: number; p: number }>;
  moon: { x: number; y: number; r: number };
  leaves: Leaf[];
  flies: Fly[];
  /** When everything has finished drawing in (seconds). */
  doneAt: number;
}

const LEAF_COLORS = ['#c4561d', '#d9822b', '#9b3418', '#e0ae4a', '#7a3d1c', '#b8742a'];

function rng(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const clamp01 = (v: number) => (v < 0 ? 0 : v > 1 ? 1 : v);
const easeOut = (v: number) => 1 - Math.pow(1 - clamp01(v), 3);

function growTree(
  rand: () => number,
  x: number,
  y: number,
  height: number,
  lean: number,
  depth: number,
  t0: number,
  dur: number,
): Tree {
  const segs: Seg[] = [];
  let maxD = 0;
  const branch = (bx: number, by: number, ang: number, len: number, w: number, d: number, level: number) => {
    // A crooked limb: two or three short kinks rather than one straight line.
    const kinks = level < 2 ? 3 : 2;
    let cx = bx;
    let cy = by;
    let a = ang;
    let dist = d;
    for (let k = 0; k < kinks; k++) {
      a += (rand() - 0.5) * 0.5;
      const l = len / kinks;
      const nx = cx + Math.cos(a) * l;
      const ny = cy + Math.sin(a) * l;
      const ww = w * (1 - (k / kinks) * 0.3);
      segs.push({ x1: cx, y1: cy, x2: nx, y2: ny, w: ww, d0: dist, len: l });
      dist += l;
      cx = nx;
      cy = ny;
    }
    maxD = Math.max(maxD, dist);
    if (level >= depth || w < 0.6) return;
    const kids = rand() < 0.25 && level > 1 ? 3 : 2;
    for (let i = 0; i < kids; i++) {
      const spread = 0.35 + rand() * 0.45;
      const dir = kids === 2 ? (i === 0 ? -1 : 1) : i - 1;
      branch(cx, cy, a + dir * spread + (rand() - 0.5) * 0.3, len * (0.62 + rand() * 0.16), w * 0.66, dist, level + 1);
    }
  };
  branch(x, y, -Math.PI / 2 + lean, height * 0.34, Math.max(2, height * 0.045), 0, 0);
  return { segs, maxD, t0, dur };
}

function buildWorld(W: number, H: number, variant: SceneVariant, speed: number): World {
  const rand = rng(variant === 'home' ? 17 : variant === 'lobby' ? 29 : 41);
  const horizon = H * (variant === 'table' ? 0.46 : variant === 'lobby' ? 0.64 : 0.6);
  const ground = H * (variant === 'home' ? 0.86 : 0.9);
  const S = speed;

  const ridge = (base: number, amp: number, freq: number, color: string, edge: string, t0: number, dur: number): Ridge => {
    const pts: Array<[number, number]> = [];
    const ph1 = rand() * 6;
    const ph2 = rand() * 6;
    for (let x = -60; x <= W + 60; x += 14) {
      const y =
        base -
        amp * (0.55 * Math.sin(x * freq + ph1) + 0.3 * Math.sin(x * freq * 2.7 + ph2) + 0.15 * Math.sin(x * freq * 6.1));
      pts.push([x, y]);
    }
    return { pts, color, edge, t0: t0 * S, dur: dur * S };
  };

  const ridges = [
    ridge(horizon - H * 0.02, H * 0.06, 0.0042, '#5d4f5f', 'rgba(240, 200, 160, 0.35)', 0.15, 1.3),
    ridge(horizon + H * 0.07, H * 0.05, 0.0061, '#3f3343', 'rgba(240, 190, 140, 0.25)', 0.7, 1.2),
    ridge(ground - H * 0.02, H * 0.035, 0.0033, '#1d1518', 'rgba(230, 160, 100, 0.22)', 1.2, 1.1),
  ];

  // A line of little pines along the second ridge.
  const pines: World['pines'] = [];
  const r2 = ridges[1]!;
  for (let x = -20; x < W + 20; x += 9 + rand() * 16) {
    if (rand() < 0.35) continue;
    const idx = Math.max(0, Math.min(r2.pts.length - 1, Math.round((x + 60) / 14)));
    const base = r2.pts[idx]![1] + 4;
    pines.push({ x, base, h: H * (0.03 + rand() * 0.05), t: (0.9 + (x / W) * 1.1) * S });
  }

  // Bare, crooked trees: a few small ones mid-distance, big ones at the edges.
  const farTrees: Tree[] = [];
  const nFar = Math.round(W / 220);
  for (let i = 0; i < nFar; i++) {
    const x = (i + 0.2 + rand() * 0.6) * (W / nFar);
    if (variant !== 'table' && Math.abs(x - W / 2) < W * 0.16) continue;
    const r3 = ridges[2]!;
    const idx = Math.max(0, Math.min(r3.pts.length - 1, Math.round((x + 60) / 14)));
    const y = r3.pts[idx]![1] + 6;
    farTrees.push(growTree(rand, x, y, H * (0.12 + rand() * 0.1), (rand() - 0.5) * 0.3, 6, (1.3 + rand() * 0.8) * S, 1.6 * S));
  }
  const nearTrees: Tree[] = [
    growTree(rand, W * (0.03 + rand() * 0.04), H + 10, H * 0.78, 0.12, 8, 1.6 * S, 2.4 * S),
    growTree(rand, W * (0.95 + rand() * 0.03), H + 10, H * 0.7, -0.14, 8, 1.9 * S, 2.4 * S),
  ];
  if (W > 900 && variant !== 'table') {
    nearTrees.push(growTree(rand, W * 0.16, H + 10, H * 0.42, 0.25, 7, 2.3 * S, 2 * S));
  }

  // The garden wall: a low run of rounded stones along the ground line.
  const stones: Stone[] = [];
  if (variant !== 'table') {
    const wallTop = ground - H * 0.055;
    const wallFrom = W * 0.04;
    const wallTo = variant === 'home' ? W * 0.96 : W * 0.98;
    for (let row = 0; row < 3; row++) {
      let x = wallFrom - (row % 2) * 14;
      const rowH = H * 0.021;
      while (x < wallTo) {
        const w = 18 + rand() * 34;
        const shadeL = 13 + Math.round(rand() * 9);
        stones.push({
          x,
          y: wallTop + row * rowH + (rand() - 0.5) * 3,
          w,
          h: rowH * (0.85 + rand() * 0.4),
          shade: `hsl(${12 + rand() * 20}, ${8 + rand() * 10}%, ${shadeL}%)`,
          bumps: Array.from({ length: 9 }, () => 0.86 + rand() * 0.16),
          t: (2.0 + ((x - wallFrom) / (wallTo - wallFrom)) * 1.2 + row * 0.12) * S,
        });
        x += w - 1;
      }
    }
  }

  const pumpkins: Pumpkin[] =
    variant === 'home'
      ? [
          { x: W * 0.22, y: ground + H * 0.03, r: H * 0.034, t: 3.1 * S },
          { x: W * 0.26, y: ground + H * 0.045, r: H * 0.022, t: 3.25 * S },
          { x: W * 0.8, y: ground + H * 0.04, r: H * 0.028, t: 3.4 * S },
        ]
      : variant === 'lobby'
        ? [{ x: W * 0.9, y: ground + H * 0.04, r: H * 0.026, t: 3.1 * S }]
        : [];
  const lantern = variant === 'home' ? { x: W * 0.865, y: ground - H * 0.16, t: 3.3 * S } : null;

  const stars: World['stars'] = [];
  for (let i = 0; i < Math.round((W * H) / 16000); i++) {
    stars.push({ x: rand() * W, y: rand() * horizon * 0.8, r: 0.4 + rand() * 1.1, p: rand() * 6 });
  }

  const leafCount = variant === 'table' ? 14 : variant === 'lobby' ? 18 : 30;
  const leaves: Leaf[] = [];
  for (let i = 0; i < leafCount; i++) leaves.push(newLeaf(rand, W, H, true));
  const flies: Fly[] = [];
  for (let i = 0; i < (variant === 'table' ? 8 : 14); i++) {
    flies.push({
      x: rand() * W,
      y: horizon + rand() * (H - horizon),
      vx: (rand() - 0.5) * 12,
      vy: (rand() - 0.5) * 8,
      phase: rand() * 6,
    });
  }

  return {
    W,
    H,
    horizon,
    ground,
    ridges,
    pines,
    farTrees,
    nearTrees,
    stones,
    pumpkins,
    lantern,
    stars,
    moon: {
      x: W * (variant === 'table' ? 0.82 : W < 700 ? 0.8 : 0.76),
      y: H * (variant === 'table' ? 0.12 : W < 700 ? 0.1 : 0.2),
      r: Math.min(W, H) * 0.045,
    },
    leaves,
    flies,
    doneAt: 4.2 * S,
  };
}

function newLeaf(rand: () => number, W: number, H: number, scatter: boolean): Leaf {
  return {
    x: rand() * W * 1.2 - W * 0.1,
    y: scatter ? rand() * H : -20 - rand() * H * 0.3,
    vy: 18 + rand() * 26,
    sway: 20 + rand() * 40,
    phase: rand() * Math.PI * 2,
    spin: (rand() - 0.5) * 2.4,
    rot: rand() * Math.PI * 2,
    flip: 0.8 + rand() * 1.6,
    size: 7 + rand() * 9,
    sprite: Math.floor(rand() * LEAF_COLORS.length),
  };
}

/** One leaf sprite per colour: a lobed oak-ish leaf with a pale midrib. */
function makeLeafSprites(): HTMLCanvasElement[] {
  return LEAF_COLORS.map((color) => {
    const c = document.createElement('canvas');
    c.width = 40;
    c.height = 40;
    const g = c.getContext('2d')!;
    g.translate(20, 20);
    g.fillStyle = color;
    g.beginPath();
    g.moveTo(0, -17);
    const lobes = 4;
    for (let i = 0; i <= lobes; i++) {
      const t = i / lobes;
      const y = -17 + t * 30;
      const w = Math.sin(t * Math.PI) * 11 + 2;
      g.quadraticCurveTo(w + 4, y - 4, w * 0.7, y + 2);
    }
    g.lineTo(0, 15);
    for (let i = lobes; i >= 0; i--) {
      const t = i / lobes;
      const y = -17 + t * 30;
      const w = Math.sin(t * Math.PI) * 11 + 2;
      g.quadraticCurveTo(-w - 4, y + 4, -w * 0.7, y - 2);
    }
    g.closePath();
    g.fill();
    g.strokeStyle = 'rgba(255, 230, 190, 0.45)';
    g.lineWidth = 1.2;
    g.beginPath();
    g.moveTo(0, -14);
    g.lineTo(0, 19);
    g.stroke();
    return c;
  });
}

function makeGlowSprite(color: string, size: number): HTMLCanvasElement {
  const c = document.createElement('canvas');
  c.width = c.height = size;
  const g = c.getContext('2d')!;
  const grad = g.createRadialGradient(size / 2, size / 2, 0, size / 2, size / 2, size / 2);
  grad.addColorStop(0, color);
  grad.addColorStop(1, 'rgba(0,0,0,0)');
  g.fillStyle = grad;
  g.fillRect(0, 0, size, size);
  return c;
}

function drawSky(g: CanvasRenderingContext2D, w: World, variant: SceneVariant) {
  const grad = g.createLinearGradient(0, 0, 0, w.ground);
  if (variant === 'table') {
    grad.addColorStop(0, '#120f16');
    grad.addColorStop(0.5, '#241c26');
    grad.addColorStop(1, '#4a3029');
  } else {
    grad.addColorStop(0, '#171b28');
    grad.addColorStop(0.42, '#352f40');
    grad.addColorStop(0.72, '#7b5146');
    grad.addColorStop(0.9, '#c4834e');
    grad.addColorStop(1, '#d99a5c');
  }
  g.fillStyle = grad;
  g.fillRect(0, 0, w.W, w.H);
  // Warm haze low on the horizon.
  const haze = g.createRadialGradient(w.W * 0.45, w.horizon, 0, w.W * 0.45, w.horizon, w.W * 0.6);
  haze.addColorStop(0, variant === 'table' ? 'rgba(200, 120, 60, 0.18)' : 'rgba(240, 170, 100, 0.35)');
  haze.addColorStop(1, 'rgba(240, 170, 100, 0)');
  g.fillStyle = haze;
  g.fillRect(0, 0, w.W, w.H);
}

function drawMoon(g: CanvasRenderingContext2D, w: World, p: number) {
  if (p <= 0) return;
  const { x, y, r } = w.moon;
  g.save();
  g.globalAlpha = easeOut(p);
  const halo = g.createRadialGradient(x, y, r * 0.6, x, y, r * 5);
  halo.addColorStop(0, 'rgba(246, 230, 196, 0.28)');
  halo.addColorStop(1, 'rgba(246, 230, 196, 0)');
  g.fillStyle = halo;
  g.fillRect(x - r * 5, y - r * 5, r * 10, r * 10);
  g.fillStyle = '#f1e4c4';
  g.beginPath();
  g.arc(x, y, r, 0, Math.PI * 2);
  g.fill();
  // A soft shadow bite makes it a waxing moon rather than a plain disc.
  g.beginPath();
  g.arc(x, y, r, 0, Math.PI * 2);
  g.clip();
  g.fillStyle = 'rgba(120, 100, 110, 0.3)';
  g.beginPath();
  g.arc(x + r * 0.5, y - r * 0.12, r * 0.92, 0, Math.PI * 2);
  g.fill();
  g.restore();
}

function drawRidge(g: CanvasRenderingContext2D, r: Ridge, w: World, t: number) {
  const p = clamp01((t - r.t0) / r.dur);
  if (p <= 0) return;
  // First an ink line runs along the ridge, then the hill fills in beneath it.
  const line = easeOut(p / 0.6);
  const fill = easeOut((p - 0.35) / 0.65);
  const lift = (1 - fill) * w.H * 0.04;
  g.save();
  if (fill > 0) {
    g.globalAlpha = fill;
    g.beginPath();
    g.moveTo(r.pts[0]![0], w.H);
    for (const [x, y] of r.pts) g.lineTo(x, y + lift);
    g.lineTo(r.pts[r.pts.length - 1]![0], w.H);
    g.closePath();
    g.fillStyle = r.color;
    g.fill();
  }
  g.globalAlpha = 1;
  const upto = Math.max(1, Math.floor(line * (r.pts.length - 1)));
  g.beginPath();
  for (let i = 0; i <= upto; i++) {
    const [x, y] = r.pts[i]!;
    if (i === 0) g.moveTo(x, y + lift);
    else g.lineTo(x, y + lift);
  }
  g.strokeStyle = r.edge;
  g.lineWidth = fill < 1 ? 1.8 : 1.3;
  g.stroke();
  g.restore();
}

function drawPine(g: CanvasRenderingContext2D, x: number, base: number, h: number, p: number) {
  if (p <= 0) return;
  const hh = h * easeOut(p);
  g.beginPath();
  g.moveTo(x, base - hh);
  const tiers = 4;
  for (let i = 1; i <= tiers; i++) {
    const y = base - hh + (hh * i) / tiers;
    const half = (h * 0.22 * i) / tiers + 1;
    g.lineTo(x + half, y);
    g.lineTo(x + half * 0.45, y - 1);
  }
  for (let i = tiers; i >= 1; i--) {
    const y = base - hh + (hh * i) / tiers;
    const half = (h * 0.22 * i) / tiers + 1;
    g.lineTo(x - half * 0.45, y - 1);
    g.lineTo(x - half, y);
  }
  g.closePath();
  g.fill();
}

function drawTree(g: CanvasRenderingContext2D, tree: Tree, t: number, color: string) {
  const p = clamp01((t - tree.t0) / tree.dur);
  if (p <= 0) return;
  const reach = easeOut(p) * tree.maxD;
  g.strokeStyle = color;
  g.lineCap = 'round';
  for (const s of tree.segs) {
    if (s.d0 >= reach) continue;
    const f = Math.min(1, (reach - s.d0) / s.len);
    g.lineWidth = s.w;
    g.beginPath();
    g.moveTo(s.x1, s.y1);
    g.lineTo(s.x1 + (s.x2 - s.x1) * f, s.y1 + (s.y2 - s.y1) * f);
    g.stroke();
  }
}

function drawStones(g: CanvasRenderingContext2D, w: World, t: number) {
  for (const s of w.stones) {
    const p = easeOut((t - s.t) / 0.35);
    if (p <= 0) continue;
    g.save();
    g.globalAlpha = p;
    g.translate(s.x + s.w / 2, s.y + s.h / 2 + (1 - p) * 6);
    // A lumpy fieldstone: a closed curve through jittered points on an ellipse.
    g.fillStyle = s.shade;
    g.beginPath();
    const n = s.bumps.length;
    for (let i = 0; i <= n; i++) {
      const k = i % n;
      const a = (k / n) * Math.PI * 2;
      const px = Math.cos(a) * (s.w / 2) * s.bumps[k]!;
      const py = Math.sin(a) * (s.h / 2) * s.bumps[k]!;
      if (i === 0) g.moveTo(px, py);
      else g.lineTo(px, py);
    }
    g.closePath();
    g.fill();
    g.strokeStyle = 'rgba(8, 4, 4, 0.75)';
    g.lineWidth = 1.4;
    g.stroke();
    g.fillStyle = 'rgba(255, 200, 150, 0.06)';
    g.beginPath();
    g.ellipse(-s.w * 0.08, -s.h * 0.22, s.w * 0.3, s.h * 0.16, 0, 0, Math.PI * 2);
    g.fill();
    g.restore();
  }
}

function drawPumpkin(g: CanvasRenderingContext2D, pk: Pumpkin, t: number) {
  const p = easeOut((t - pk.t) / 0.5);
  if (p <= 0) return;
  const r = pk.r * (0.6 + 0.4 * p);
  g.save();
  g.globalAlpha = p;
  g.translate(pk.x, pk.y);
  g.fillStyle = 'rgba(0,0,0,0.35)';
  g.beginPath();
  g.ellipse(0, r * 0.75, r * 1.3, r * 0.25, 0, 0, Math.PI * 2);
  g.fill();
  const ribs = [
    [-0.55, 0.62, '#a8461a'],
    [0.55, 0.62, '#a8461a'],
    [-0.25, 0.7, '#c45a1f'],
    [0.25, 0.7, '#c45a1f'],
    [0, 0.62, '#d9722a'],
  ] as const;
  for (const [ox, rx, col] of ribs) {
    g.fillStyle = col;
    g.beginPath();
    g.ellipse(ox * r, 0, rx * r, r * 0.78, 0, 0, Math.PI * 2);
    g.fill();
  }
  g.strokeStyle = '#3d2a14';
  g.lineWidth = Math.max(2, r * 0.14);
  g.lineCap = 'round';
  g.beginPath();
  g.moveTo(0, -r * 0.7);
  g.quadraticCurveTo(r * 0.05, -r * 1.05, r * 0.25, -r * 1.15);
  g.stroke();
  g.restore();
}

function drawLantern(g: CanvasRenderingContext2D, w: World, t: number, glow: HTMLCanvasElement) {
  const l = w.lantern;
  if (!l) return;
  const p = easeOut((t - l.t) / 0.6);
  if (p <= 0) return;
  // Flicker: a few incommensurate sines read as a living flame.
  const flick = 0.82 + 0.1 * Math.sin(t * 7.3) + 0.06 * Math.sin(t * 13.1 + 1) + 0.04 * Math.sin(t * 23.7);
  g.save();
  g.globalAlpha = p;
  g.strokeStyle = '#1a1210';
  g.lineWidth = 4;
  g.beginPath();
  g.moveTo(l.x, w.ground + 4);
  g.lineTo(l.x, l.y - 30);
  g.lineTo(l.x - 22, l.y - 30);
  g.stroke();
  g.lineWidth = 1.5;
  g.beginPath();
  g.moveTo(l.x - 22, l.y - 30);
  g.lineTo(l.x - 22, l.y - 14);
  g.stroke();
  const gs = 260 * flick;
  g.globalAlpha = p * 0.85 * flick;
  g.globalCompositeOperation = 'lighter';
  g.drawImage(glow, l.x - 22 - gs / 2, l.y - gs / 2, gs, gs);
  g.globalCompositeOperation = 'source-over';
  g.globalAlpha = p;
  g.fillStyle = '#1a1210';
  g.fillRect(l.x - 30, l.y - 15, 16, 4);
  g.fillStyle = `rgba(255, ${190 + Math.round(30 * flick)}, 110, 1)`;
  g.fillRect(l.x - 28, l.y - 11, 12, 18);
  g.strokeStyle = '#1a1210';
  g.lineWidth = 2;
  g.strokeRect(l.x - 28, l.y - 11, 12, 18);
  g.beginPath();
  g.moveTo(l.x - 22, l.y - 11);
  g.lineTo(l.x - 22, l.y + 7);
  g.stroke();
  g.fillRect(l.x - 30, l.y + 7, 16, 4);
  g.restore();
}

export default function GardenScene({ variant }: { variant: SceneVariant }) {
  const ref = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const canvas = ref.current;
    const ctx = canvas?.getContext('2d');
    if (!canvas || !ctx) return;
    const reduce = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches ?? false;
    // The full sketch-in plays once per visit; later pages draw in quickly.
    let seen = false;
    try {
      seen = sessionStorage.getItem('garden-drawn') === '1';
      sessionStorage.setItem('garden-drawn', '1');
    } catch {
      /* storage unavailable: always play the full sketch */
    }
    const speed = seen ? 0.35 : 1;
    const leafSprites = makeLeafSprites();
    const flyGlow = makeGlowSprite('rgba(255, 226, 140, 0.9)', 32);
    const lanternGlow = makeGlowSprite('rgba(255, 180, 90, 0.55)', 128);
    const rand = rng(7);

    let world = buildWorld(1, 1, variant, speed);
    let dpr = 1;
    let farCache: HTMLCanvasElement | null = null;
    let nearCache: HTMLCanvasElement | null = null;
    let start = performance.now();
    let last = start;
    let raf = 0;
    const mouse = { x: 0, y: 0, tx: 0, ty: 0 };
    const frameGap = variant === 'table' ? 1000 / 30 : 0;
    let lastDraw = 0;

    const layer = (paint: (g: CanvasRenderingContext2D) => void): HTMLCanvasElement => {
      const c = document.createElement('canvas');
      c.width = Math.ceil(world.W * dpr);
      c.height = Math.ceil(world.H * dpr);
      const g = c.getContext('2d')!;
      g.scale(dpr, dpr);
      paint(g);
      return c;
    };

    const paintFar = (g: CanvasRenderingContext2D, t: number) => {
      drawSky(g, world, variant);
      drawMoon(g, world, (t - 0.3 * speed) / (0.9 * speed));
      drawRidge(g, world.ridges[0]!, world, t);
      drawRidge(g, world.ridges[1]!, world, t);
      g.fillStyle = '#33283a';
      for (const p of world.pines) drawPine(g, p.x, p.base, p.h, (t - p.t) / (0.6 * speed));
    };
    const paintNear = (g: CanvasRenderingContext2D, t: number) => {
      drawRidge(g, world.ridges[2]!, world, t);
      for (const tree of world.farTrees) drawTree(g, tree, t, '#21181c');
      // Foreground ground band below the wall.
      const gp = easeOut((t - 1.6 * speed) / (0.8 * speed));
      if (gp > 0) {
        g.save();
        g.globalAlpha = gp;
        const grad = g.createLinearGradient(0, world.ground - 10, 0, world.H);
        grad.addColorStop(0, '#191113');
        grad.addColorStop(1, '#0d0809');
        g.fillStyle = grad;
        g.fillRect(-60, world.ground - 6, world.W + 120, world.H);
        g.restore();
      }
      drawStones(g, world, t);
      for (const pk of world.pumpkins) drawPumpkin(g, pk, t);
      for (const tree of world.nearTrees) drawTree(g, tree, t, '#0f0a0b');
    };

    const resize = () => {
      const W = window.innerWidth;
      const H = window.innerHeight;
      dpr = Math.min(window.devicePixelRatio || 1, variant === 'table' ? 1.25 : 1.75);
      canvas.width = Math.ceil(W * dpr);
      canvas.height = Math.ceil(H * dpr);
      canvas.style.width = `${W}px`;
      canvas.style.height = `${H}px`;
      const prevDone = farCache !== null;
      world = buildWorld(W, H, variant, speed);
      farCache = null;
      nearCache = null;
      if (prevDone || reduce) {
        // Resizing after the sketch finished: draw the new size complete.
        farCache = layer((g) => paintFar(g, 1e6));
        nearCache = layer((g) => paintNear(g, 1e6));
      }
    };

    const draw = (now: number) => {
      const t = (now - start) / 1000;
      const dt = Math.min(0.05, (now - last) / 1000);
      last = now;
      const { W, H } = world;
      if (!farCache && t > world.doneAt) {
        farCache = layer((g) => paintFar(g, 1e6));
        nearCache = layer((g) => paintNear(g, 1e6));
      }
      mouse.x += (mouse.tx - mouse.x) * 0.04;
      mouse.y += (mouse.ty - mouse.y) * 0.04;
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.clearRect(0, 0, W, H);

      // Sky + far hills (with a gentle parallax).
      ctx.save();
      ctx.translate(mouse.x * -4, mouse.y * -2);
      if (farCache) ctx.drawImage(farCache, -0, 0, W, H);
      else paintFar(ctx, t);
      ctx.restore();

      // Stars twinkle over the sky only.
      const starA = clamp01((t - 0.4 * speed) / speed);
      if (starA > 0) {
        ctx.fillStyle = '#f6ead0';
        for (const s of world.stars) {
          ctx.globalAlpha = starA * (0.35 + 0.35 * Math.sin(t * 1.7 + s.p));
          ctx.fillRect(s.x - mouse.x * 4, s.y, s.r, s.r);
        }
        ctx.globalAlpha = 1;
      }

      // Fog drifting between the far and near layers.
      const fogA = clamp01((t - 0.8 * speed) / speed);
      if (fogA > 0) {
        for (let i = 0; i < 3; i++) {
          const y = world.horizon + H * (0.02 + i * 0.07);
          const x = ((t * (6 + i * 4) + i * 400) % (W + 800)) - 400;
          const grad = ctx.createRadialGradient(x, y, 0, x, y, W * 0.45);
          grad.addColorStop(0, `rgba(222, 190, 160, ${0.13 * fogA})`);
          grad.addColorStop(1, 'rgba(222, 190, 160, 0)');
          ctx.save();
          ctx.translate(0, y);
          ctx.scale(1, 0.18);
          ctx.translate(0, -y);
          ctx.fillStyle = grad;
          ctx.fillRect(x - W * 0.45, y - W * 0.45, W * 0.9, W * 0.9);
          ctx.restore();
        }
      }

      ctx.save();
      ctx.translate(mouse.x * -10, mouse.y * -4);
      if (nearCache) ctx.drawImage(nearCache, 0, 0, W, H);
      else paintNear(ctx, t);
      drawLantern(ctx, world, t, lanternGlow);
      ctx.restore();

      // Fireflies near the ground.
      const flyA = clamp01((t - 2.4 * speed) / speed);
      if (flyA > 0) {
        ctx.globalCompositeOperation = 'lighter';
        for (const f of world.flies) {
          if (!reduce) {
            f.vx += (rand() - 0.5) * 30 * dt;
            f.vy += (rand() - 0.5) * 30 * dt;
            f.vx *= 0.98;
            f.vy *= 0.98;
            f.x += f.vx * dt;
            f.y += f.vy * dt;
            if (f.x < 0) f.x += W;
            if (f.x > W) f.x -= W;
            if (f.y < world.horizon) f.vy += 4 * dt * 10;
            if (f.y > H) f.vy -= 4 * dt * 10;
          }
          const a = flyA * Math.max(0, Math.sin(t * 1.3 + f.phase)) ** 2;
          if (a < 0.02) continue;
          ctx.globalAlpha = a;
          ctx.drawImage(flyGlow, f.x - 10, f.y - 10, 20, 20);
        }
        ctx.globalAlpha = 1;
        ctx.globalCompositeOperation = 'source-over';
      }

      // Falling leaves, tumbling in 3D (the y-scale fakes the flip).
      const leafA = clamp01((t - 1.2 * speed) / (0.8 * speed));
      if (leafA > 0) {
        for (const l of world.leaves) {
          if (!reduce) {
            l.y += l.vy * dt;
            l.phase += dt * 1.4;
            l.rot += l.spin * dt;
            if (l.y > H + 30) Object.assign(l, newLeaf(rand, W, H, false));
          }
          const x = l.x + Math.sin(l.phase) * l.sway;
          const fadeLow = l.y > H * 0.88 ? clamp01((H + 20 - l.y) / (H * 0.12)) : 1;
          ctx.save();
          ctx.globalAlpha = leafA * fadeLow * 0.92;
          ctx.translate(x, l.y);
          ctx.rotate(l.rot);
          ctx.scale(1, Math.cos(l.phase * l.flip) * 0.85 + 0.15);
          ctx.drawImage(leafSprites[l.sprite]!, -l.size, -l.size, l.size * 2, l.size * 2);
          ctx.restore();
        }
      }
    };

    const loop = (now: number) => {
      raf = requestAnimationFrame(loop);
      if (document.hidden) return;
      if (frameGap && now - lastDraw < frameGap) return;
      lastDraw = now;
      draw(now);
    };

    let resizeTimer = 0;
    const onResize = () => {
      window.clearTimeout(resizeTimer);
      resizeTimer = window.setTimeout(() => {
        resize();
        if (reduce) draw(performance.now());
      }, 120);
    };
    const onMove = (e: PointerEvent) => {
      mouse.tx = e.clientX / window.innerWidth - 0.5;
      mouse.ty = e.clientY / window.innerHeight - 0.5;
    };

    resize();
    if (reduce) {
      start = performance.now() - 1e6;
      draw(performance.now());
    } else {
      start = performance.now();
      last = start;
      raf = requestAnimationFrame(loop);
    }
    window.addEventListener('resize', onResize);
    window.addEventListener('pointermove', onMove, { passive: true });
    return () => {
      cancelAnimationFrame(raf);
      window.clearTimeout(resizeTimer);
      window.removeEventListener('resize', onResize);
      window.removeEventListener('pointermove', onMove);
    };
  }, [variant]);

  return <canvas ref={ref} className={`garden-scene garden-${variant}`} aria-hidden />;
}
