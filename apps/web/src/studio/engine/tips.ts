/**
 * Brush tips, paper grain and a small seeded random generator. Tips are
 * white alpha masks drawn once and tinted per colour; grain is a tiling
 * noise texture fixed to the paper, like a real pencil on real paper.
 */

import type { Brush, TipShape } from './brushes.js';

export type Canvas2D = HTMLCanvasElement;

export function makeCanvas(w: number, h: number): Canvas2D {
  const c = document.createElement('canvas');
  c.width = Math.max(1, Math.ceil(w));
  c.height = Math.max(1, Math.ceil(h));
  return c;
}

export function ctx2d(c: Canvas2D, willRead = false): CanvasRenderingContext2D {
  return c.getContext('2d', willRead ? { willReadFrequently: true } : undefined)!;
}

/** mulberry32: fast, seedable, identical on every browser. */
export function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// ---------------------------------------------------------------------------
// Tips
// ---------------------------------------------------------------------------

const TIP_RES = 128;
const maskCache = new Map<string, Canvas2D>();

function tipKey(b: Brush): string {
  return `${b.tip}:${b.hardness}`;
}

/** The tip as a white alpha mask, TIP_RES square, centred. */
export function tipMask(b: Brush): Canvas2D {
  const key = tipKey(b);
  let c = maskCache.get(key);
  if (c) return c;
  c = makeCanvas(TIP_RES, TIP_RES);
  drawTip(ctx2d(c), b.tip, b.hardness, TIP_RES);
  maskCache.set(key, c);
  return c;
}

function drawTip(g: CanvasRenderingContext2D, tip: TipShape, hardness: number, n: number): void {
  const r = n / 2;
  const R = rng(0x5eed + tip.length * 977);
  g.fillStyle = '#fff';
  switch (tip) {
    case 'round':
    case 'flat':
    case 'dot': {
      g.beginPath();
      g.arc(r, r, r - 1.5, 0, Math.PI * 2);
      g.fill();
      return;
    }
    case 'soft': {
      const grad = g.createRadialGradient(r, r, 0, r, r, r);
      const h = Math.min(0.98, Math.max(0, hardness));
      grad.addColorStop(0, 'rgba(255,255,255,1)');
      grad.addColorStop(h, 'rgba(255,255,255,1)');
      // A smooth tail: approximate a gaussian with a few stops.
      for (let i = 1; i <= 6; i++) {
        const t = i / 6;
        const pos = h + (1 - h) * t;
        grad.addColorStop(Math.min(1, pos), `rgba(255,255,255,${Math.exp(-4.5 * t * t) * (1 - t * 0.15)})`);
      }
      grad.addColorStop(1, 'rgba(255,255,255,0)');
      g.fillStyle = grad;
      g.fillRect(0, 0, n, n);
      return;
    }
    case 'wash': {
      const grad = g.createRadialGradient(r, r, 0, r, r, r);
      grad.addColorStop(0, 'rgba(255,255,255,0.55)');
      grad.addColorStop(0.6, 'rgba(255,255,255,0.7)');
      grad.addColorStop(0.85, 'rgba(255,255,255,0.9)');
      grad.addColorStop(1, 'rgba(255,255,255,0)');
      g.fillStyle = grad;
      g.fillRect(0, 0, n, n);
      return;
    }
    case 'pencil': {
      g.beginPath();
      g.arc(r, r, r * 0.72, 0, Math.PI * 2);
      g.fill();
      for (let i = 0; i < 160; i++) {
        const a = R() * Math.PI * 2;
        const d = r * (0.6 + R() * 0.38);
        g.globalAlpha = 0.3 + R() * 0.6;
        g.fillRect(r + Math.cos(a) * d, r + Math.sin(a) * d, 2, 2);
      }
      g.globalAlpha = 1;
      return;
    }
    case 'chalk': {
      for (let i = 0; i < 420; i++) {
        const a = R() * Math.PI * 2;
        const d = r * Math.sqrt(R()) * 0.95;
        g.globalAlpha = 0.25 + R() * 0.6;
        const s = 2 + R() * 6;
        g.beginPath();
        g.ellipse(r + Math.cos(a) * d, r + Math.sin(a) * d, s, s * (0.4 + R() * 0.6), R() * Math.PI, 0, Math.PI * 2);
        g.fill();
      }
      g.globalAlpha = 1;
      return;
    }
    case 'bristle': {
      // A faint body of paint, then hairs across the width, each a streak with its own strength.
      g.globalAlpha = 0.35;
      g.beginPath();
      g.ellipse(r, r, r * 0.92, r * 0.7, 0, 0, Math.PI * 2);
      g.fill();
      for (let i = 0; i < 46; i++) {
        const x = r + (R() * 2 - 1) * r * 0.92;
        const len = r * (0.55 + R() * 0.4);
        g.globalAlpha = 0.35 + R() * 0.65;
        const w = 1.5 + R() * 3.5;
        g.beginPath();
        g.ellipse(x, r + (R() - 0.5) * r * 0.2, w, len, 0, 0, Math.PI * 2);
        g.fill();
      }
      g.globalAlpha = 1;
      return;
    }
    case 'spatter': {
      for (let i = 0; i < 70; i++) {
        const a = R() * Math.PI * 2;
        const d = r * Math.pow(R(), 0.7) * 0.92;
        const s = 1 + R() * R() * 9;
        g.globalAlpha = 0.5 + R() * 0.5;
        g.beginPath();
        g.arc(r + Math.cos(a) * d, r + Math.sin(a) * d, s, 0, Math.PI * 2);
        g.fill();
      }
      g.globalAlpha = 1;
      return;
    }
    case 'star': {
      g.beginPath();
      for (let i = 0; i < 10; i++) {
        const a = -Math.PI / 2 + (i * Math.PI) / 5;
        const d = i % 2 === 0 ? r * 0.96 : r * 0.42;
        const x = r + Math.cos(a) * d, y = r + Math.sin(a) * d;
        if (i === 0) g.moveTo(x, y); else g.lineTo(x, y);
      }
      g.closePath();
      g.fill();
      return;
    }
    case 'heart': {
      const s = n / 32;
      g.beginPath();
      g.moveTo(16 * s, 28 * s);
      g.bezierCurveTo(4 * s, 20 * s, 1 * s, 12 * s, 6 * s, 7 * s);
      g.bezierCurveTo(10 * s, 3 * s, 15 * s, 5 * s, 16 * s, 10 * s);
      g.bezierCurveTo(17 * s, 5 * s, 22 * s, 3 * s, 26 * s, 7 * s);
      g.bezierCurveTo(31 * s, 12 * s, 28 * s, 20 * s, 16 * s, 28 * s);
      g.fill();
      return;
    }
    case 'leaf': {
      g.beginPath();
      g.moveTo(r, 2);
      g.quadraticCurveTo(n - 6, r, r, n - 2);
      g.quadraticCurveTo(6, r, r, 2);
      g.fill();
      g.globalCompositeOperation = 'destination-out';
      g.lineWidth = 2.5;
      g.strokeStyle = '#fff';
      g.globalAlpha = 0.6;
      g.beginPath();
      g.moveTo(r, 8);
      g.lineTo(r, n - 8);
      g.stroke();
      g.globalAlpha = 1;
      g.globalCompositeOperation = 'source-over';
      return;
    }
  }
}

const tintCache = new Map<string, Canvas2D>();

/** The tip in one colour (cached; the cache is small and trimmed). */
export function tintedTip(b: Brush, color: string): Canvas2D {
  const key = `${tipKey(b)}|${color}`;
  let c = tintCache.get(key);
  if (c) return c;
  const mask = tipMask(b);
  c = makeCanvas(TIP_RES, TIP_RES);
  const g = ctx2d(c);
  g.drawImage(mask, 0, 0);
  g.globalCompositeOperation = 'source-in';
  g.fillStyle = color;
  g.fillRect(0, 0, TIP_RES, TIP_RES);
  if (tintCache.size > 256) tintCache.delete(tintCache.keys().next().value!);
  tintCache.set(key, c);
  return c;
}

export const TIP_SIZE = TIP_RES;

// ---------------------------------------------------------------------------
// Paper grain
// ---------------------------------------------------------------------------

const GRAIN_TILE = 256;
let grainTile: Canvas2D | null = null;

/** A tiling noise texture: white with alpha = how much the paper takes pigment. */
export function grainTexture(): Canvas2D {
  if (grainTile) return grainTile;
  const n = GRAIN_TILE;
  const c = makeCanvas(n, n);
  const g = ctx2d(c);
  const img = g.createImageData(n, n);
  const R = rng(1234567);
  // Tileable value noise at three octaves plus fibre streaks.
  const octave = (cells: number) => {
    const grid = Array.from({ length: cells * cells }, () => R());
    return (x: number, y: number) => {
      const fx = (x / n) * cells, fy = (y / n) * cells;
      const x0 = Math.floor(fx), y0 = Math.floor(fy);
      const tx = fx - x0, ty = fy - y0;
      const sx = tx * tx * (3 - 2 * tx), sy = ty * ty * (3 - 2 * ty);
      const at = (i: number, j: number) => grid[((j % cells) * cells) + (i % cells)]!;
      const a = at(x0, y0), b = at(x0 + 1, y0), c2 = at(x0, y0 + 1), d = at(x0 + 1, y0 + 1);
      return (a + (b - a) * sx) * (1 - sy) + (c2 + (d - c2) * sx) * sy;
    };
  };
  const o1 = octave(32), o2 = octave(85), o3 = octave(256);
  for (let y = 0; y < n; y++) {
    for (let x = 0; x < n; x++) {
      const v = 0.2 * o1(x, y) + 0.35 * o2(x, y) + 0.45 * o3(x, y);
      // Sharpen into peaks (paper tooth) and valleys.
      const t = Math.min(1, Math.max(0, (v - 0.32) * 2.6));
      const i = (y * n + x) * 4;
      img.data[i] = img.data[i + 1] = img.data[i + 2] = 255;
      img.data[i + 3] = Math.round(t * 255);
    }
  }
  g.putImageData(img, 0, 0);
  grainTile = c;
  return c;
}

const grainCache = new Map<number, Canvas2D>();

/**
 * Grain mask for a given strength: alpha = 1 - strength * (1 - grain).
 * Drawn with destination-in over a stroke, it leaves pigment on the tooth.
 */
export function grainMask(strength: number): Canvas2D {
  const key = Math.round(strength * 20);
  let c = grainCache.get(key);
  if (c) return c;
  const tile = grainTexture();
  c = makeCanvas(GRAIN_TILE, GRAIN_TILE);
  const g = ctx2d(c);
  g.fillStyle = `rgba(255,255,255,${1 - key / 20})`;
  g.fillRect(0, 0, GRAIN_TILE, GRAIN_TILE);
  g.globalAlpha = key / 20;
  g.drawImage(tile, 0, 0);
  grainCache.set(key, c);
  return c;
}

// ---------------------------------------------------------------------------
// Colour helpers
// ---------------------------------------------------------------------------

export function hexToRgb(hex: string): [number, number, number] {
  const n = Number.parseInt(hex.slice(1), 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

export function rgbToHex(r: number, g: number, b: number): string {
  const h = (v: number) => Math.round(Math.min(255, Math.max(0, v))).toString(16).padStart(2, '0');
  return `#${h(r)}${h(g)}${h(b)}`;
}

export function rgbToHsl(r: number, g: number, b: number): [number, number, number] {
  r /= 255; g /= 255; b /= 255;
  const max = Math.max(r, g, b), min = Math.min(r, g, b);
  const l = (max + min) / 2;
  if (max === min) return [0, 0, l];
  const d = max - min;
  const s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
  let h = max === r ? (g - b) / d + (g < b ? 6 : 0) : max === g ? (b - r) / d + 2 : (r - g) / d + 4;
  h /= 6;
  return [h, s, l];
}

export function hslToHex(h: number, s: number, l: number): string {
  h = ((h % 1) + 1) % 1;
  s = Math.min(1, Math.max(0, s));
  l = Math.min(1, Math.max(0, l));
  const q = l < 0.5 ? l * (1 + s) : l + s - l * s;
  const p = 2 * l - q;
  const f = (t: number) => {
    t = ((t % 1) + 1) % 1;
    if (t < 1 / 6) return p + (q - p) * 6 * t;
    if (t < 1 / 2) return q;
    if (t < 2 / 3) return p + (q - p) * (2 / 3 - t) * 6;
    return p;
  };
  return rgbToHex(f(h + 1 / 3) * 255, f(h) * 255, f(h - 1 / 3) * 255);
}

/** A colour shifted in hue and lightness (for jitter). */
export function shiftColor(hex: string, dh: number, dl: number): string {
  const [h, s, l] = rgbToHsl(...hexToRgb(hex));
  return hslToHex(h + dh, s + (dh !== 0 && s < 0.15 ? 0.3 : 0), l + dl);
}
