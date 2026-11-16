/**
 * Pictures for the studio: shrinking an uploaded image to a sensible size,
 * and generated colouring pages (mandalas, a garden) for when nobody has
 * one at hand.
 */

import { ctx2d, makeCanvas, rng } from './engine/tips.js';

export const MAX_PICTURE_SIDE = 2400;

export interface PreparedPicture {
  blob: Blob;
  width: number;
  height: number;
}

function toBlob(c: HTMLCanvasElement, type = 'image/png', quality?: number): Promise<Blob> {
  return new Promise((resolve, reject) =>
    c.toBlob((b) => (b ? resolve(b) : reject(new Error('could not encode the picture'))), type, quality));
}

/**
 * Read a file the host picked, shrink it to at most MAX_PICTURE_SIDE, and
 * (for line art) turn near-white into transparent so it sits on the paper.
 */
export async function preparePicture(file: File, opts: { lineArt: boolean }): Promise<PreparedPicture> {
  const bitmap = await createImageBitmap(file);
  const k = Math.min(1, MAX_PICTURE_SIDE / Math.max(bitmap.width, bitmap.height));
  const w = Math.max(1, Math.round(bitmap.width * k));
  const h = Math.max(1, Math.round(bitmap.height * k));
  const c = makeCanvas(w, h);
  const g = ctx2d(c, true);
  if (opts.lineArt) {
    g.fillStyle = '#fff';
    g.fillRect(0, 0, w, h);
  }
  g.drawImage(bitmap, 0, 0, w, h);
  bitmap.close?.();
  if (opts.lineArt) {
    // Darkness becomes opacity: lines keep their tone, white paper disappears.
    const img = g.getImageData(0, 0, w, h);
    const d = img.data;
    for (let i = 0; i < d.length; i += 4) {
      const lum = d[i]! * 0.299 + d[i + 1]! * 0.587 + d[i + 2]! * 0.114;
      const ink = Math.max(0, Math.min(255, (255 - lum) * 1.25));
      const a = ink < 18 ? 0 : ink;
      // Keep the hue of coloured lines, darkened a touch.
      d[i] = Math.round(d[i]! * 0.6);
      d[i + 1] = Math.round(d[i + 1]! * 0.6);
      d[i + 2] = Math.round(d[i + 2]! * 0.6);
      d[i + 3] = a;
    }
    g.putImageData(img, 0, 0);
    return { blob: await toBlob(c), width: w, height: h };
  }
  // A photo or painting: JPEG is a fraction of the size and fine for tracing.
  return { blob: await toBlob(c, 'image/jpeg', 0.9), width: w, height: h };
}

export type PageKind = 'mandala' | 'flower' | 'garden';

export const PAGE_KINDS: { id: PageKind; name: string }[] = [
  { id: 'mandala', name: 'Mandala' },
  { id: 'flower', name: 'Flower' },
  { id: 'garden', name: 'Garden' },
];

/** A colouring page drawn from a seed: black lines on transparent. */
export async function makePage(kind: PageKind, seed: number, w = 1600, h = 1200): Promise<PreparedPicture> {
  const c = makeCanvas(w, h);
  const g = ctx2d(c);
  g.lineCap = 'round';
  g.lineJoin = 'round';
  g.strokeStyle = '#1b1b1b';
  const R = rng(seed);
  if (kind === 'mandala') drawMandala(g, w / 2, h / 2, Math.min(w, h) * 0.46, R);
  else if (kind === 'flower') drawFlowerPage(g, w, h, R);
  else drawGarden(g, w, h, R);
  return { blob: await toBlob(c), width: w, height: h };
}

function ring(g: CanvasRenderingContext2D, cx: number, cy: number, r: number, width: number): void {
  g.lineWidth = width;
  g.beginPath();
  g.arc(cx, cy, r, 0, Math.PI * 2);
  g.stroke();
}

function drawMandala(g: CanvasRenderingContext2D, cx: number, cy: number, R0: number, R: () => number): void {
  const bands = 5 + Math.floor(R() * 3);
  let r = R0 * 0.12;
  ring(g, cx, cy, r, 5);
  const step = (R0 - r) / bands;
  for (let b = 0; b < bands; b++) {
    const inner = r, outer = r + step;
    const n = [8, 10, 12, 16, 18, 24][Math.floor(R() * 6)]!;
    const style = Math.floor(R() * 4);
    g.lineWidth = 4;
    for (let i = 0; i < n; i++) {
      const a0 = (i / n) * Math.PI * 2;
      const a1 = ((i + 1) / n) * Math.PI * 2;
      const am = (a0 + a1) / 2;
      const p = (rad: number, a: number) => [cx + Math.cos(a) * rad, cy + Math.sin(a) * rad] as const;
      g.beginPath();
      if (style === 0) {
        // Petals.
        const [x0, y0] = p(inner, a0), [x1, y1] = p(inner, a1), [xt, yt] = p(outer, am);
        const [c0x, c0y] = p(outer * 0.92, a0), [c1x, c1y] = p(outer * 0.92, a1);
        g.moveTo(x0, y0);
        g.quadraticCurveTo(c0x, c0y, xt, yt);
        g.quadraticCurveTo(c1x, c1y, x1, y1);
      } else if (style === 1) {
        // Arches.
        const [x0, y0] = p(inner, a0);
        g.moveTo(x0, y0);
        const [x1, y1] = p(inner, a1);
        g.bezierCurveTo(...p(outer, a0), ...p(outer, a1), x1, y1);
      } else if (style === 2) {
        // Teardrops.
        const [xa, ya] = p(inner + step * 0.15, am);
        const [xb, yb] = p(outer - step * 0.1, am);
        const wid = ((a1 - a0) * (inner + outer)) / 2 * 0.35;
        const nx = -Math.sin(am) * wid, ny = Math.cos(am) * wid;
        g.moveTo(xa, ya);
        g.bezierCurveTo(xa + nx, ya + ny, xb + nx * 0.6, yb + ny * 0.6, xb, yb);
        g.bezierCurveTo(xb - nx * 0.6, yb - ny * 0.6, xa - nx, ya - ny, xa, ya);
      } else {
        // Zigzag spikes.
        const [x0, y0] = p(inner, a0), [xt, yt] = p(outer, am), [x1, y1] = p(inner, a1);
        g.moveTo(x0, y0);
        g.lineTo(xt, yt);
        g.lineTo(x1, y1);
      }
      g.stroke();
      if (R() < 0.5) {
        const [dx, dy] = p(inner + step * 0.5, am);
        g.beginPath();
        g.arc(dx, dy, Math.max(4, step * 0.1), 0, Math.PI * 2);
        g.lineWidth = 3;
        g.stroke();
      }
    }
    r = outer;
    ring(g, cx, cy, r, b === bands - 1 ? 6 : 3);
  }
}

function petalFlower(g: CanvasRenderingContext2D, x: number, y: number, size: number, petals: number, rot: number, width = 0.42): void {
  g.lineWidth = Math.max(3, size * 0.035);
  for (let i = 0; i < petals; i++) {
    const a = rot + (i / petals) * Math.PI * 2;
    const tipX = x + Math.cos(a) * size, tipY = y + Math.sin(a) * size;
    const side = size * width;
    const nx = -Math.sin(a) * side, ny = Math.cos(a) * side;
    const mx = x + Math.cos(a) * size * 0.55, my = y + Math.sin(a) * size * 0.55;
    g.beginPath();
    g.moveTo(x, y);
    g.quadraticCurveTo(mx + nx, my + ny, tipX, tipY);
    g.quadraticCurveTo(mx - nx, my - ny, x, y);
    g.stroke();
  }
  g.beginPath();
  g.arc(x, y, size * 0.22, 0, Math.PI * 2);
  g.stroke();
}

function leaf(g: CanvasRenderingContext2D, x: number, y: number, len: number, a: number): void {
  const tx = x + Math.cos(a) * len, ty = y + Math.sin(a) * len;
  const nx = -Math.sin(a) * len * 0.3, ny = Math.cos(a) * len * 0.3;
  const mx = (x + tx) / 2, my = (y + ty) / 2;
  g.beginPath();
  g.moveTo(x, y);
  g.quadraticCurveTo(mx + nx, my + ny, tx, ty);
  g.quadraticCurveTo(mx - nx, my - ny, x, y);
  g.moveTo(x, y);
  g.lineTo(mx + (tx - mx) * 0.6, my + (ty - my) * 0.6);
  g.stroke();
}

function drawFlowerPage(g: CanvasRenderingContext2D, w: number, h: number, R: () => number): void {
  const cx = w / 2, cy = h * 0.42;
  g.lineWidth = 6;
  g.beginPath();
  g.moveTo(cx, cy);
  g.bezierCurveTo(cx - 40, cy + 200, cx + 60, cy + 380, cx, h * 0.98);
  g.stroke();
  g.lineWidth = 5;
  leaf(g, cx + 6, cy + 300, 190, -0.5);
  leaf(g, cx - 4, cy + 420, 170, Math.PI + 0.45);
  const big = Math.min(w, h) * 0.3;
  petalFlower(g, cx, cy, big, 8 + Math.floor(R() * 4), R() * Math.PI, 0.3);
  // Clear the heart of the flower so the inner petals sit on clean paper.
  g.save();
  g.globalCompositeOperation = 'destination-out';
  g.beginPath();
  g.arc(cx, cy, big * 0.5, 0, Math.PI * 2);
  g.fill();
  g.restore();
  ring(g, cx, cy, big * 0.5, 5);
  petalFlower(g, cx, cy, big * 0.48, 7, R() * Math.PI, 0.32);
  for (let i = 0; i < 6; i++) {
    const x = R() * w, y = R() * h * 0.9;
    if (Math.hypot(x - cx, y - cy) < 420) continue;
    petalFlower(g, x, y, 40 + R() * 50, 5 + Math.floor(R() * 3), R() * Math.PI);
  }
}

function drawGarden(g: CanvasRenderingContext2D, w: number, h: number, R: () => number): void {
  // Ground line and hills.
  g.lineWidth = 6;
  g.beginPath();
  g.moveTo(0, h * 0.72);
  g.bezierCurveTo(w * 0.3, h * 0.62, w * 0.6, h * 0.8, w, h * 0.68);
  g.stroke();
  // Sun.
  ring(g, w * 0.82, h * 0.18, 80, 6);
  g.lineWidth = 5;
  for (let i = 0; i < 12; i++) {
    const a = (i / 12) * Math.PI * 2;
    g.beginPath();
    g.moveTo(w * 0.82 + Math.cos(a) * 105, h * 0.18 + Math.sin(a) * 105);
    g.lineTo(w * 0.82 + Math.cos(a) * 145, h * 0.18 + Math.sin(a) * 145);
    g.stroke();
  }
  // Clouds.
  for (const [x, y, s] of [[w * 0.2, h * 0.16, 1], [w * 0.5, h * 0.1, 0.8]] as const) {
    g.lineWidth = 5;
    g.beginPath();
    g.arc(x, y, 50 * s, Math.PI, 0);
    g.arc(x + 70 * s, y + 10 * s, 40 * s, Math.PI * 1.1, 0.1);
    g.arc(x - 70 * s, y + 10 * s, 40 * s, Math.PI * 0.9, Math.PI * 1.9);
    g.closePath();
    g.stroke();
  }
  // House.
  const hx = w * 0.18, hy = h * 0.5, hw = 300, hh = 220;
  g.lineWidth = 6;
  g.strokeRect(hx, hy, hw, hh);
  g.beginPath();
  g.moveTo(hx - 30, hy);
  g.lineTo(hx + hw / 2, hy - 160);
  g.lineTo(hx + hw + 30, hy);
  g.closePath();
  g.stroke();
  g.lineWidth = 5;
  g.strokeRect(hx + 120, hy + 100, 70, 120);
  g.strokeRect(hx + 30, hy + 50, 60, 60);
  g.strokeRect(hx + 210, hy + 50, 60, 60);
  // Flowers and a tree.
  g.lineWidth = 6;
  const tx = w * 0.62, ty = h * 0.7;
  g.beginPath();
  g.moveTo(tx - 25, ty + 40);
  g.lineTo(tx - 18, ty - 160);
  g.moveTo(tx + 25, ty + 40);
  g.lineTo(tx + 18, ty - 160);
  g.stroke();
  for (let i = 0; i < 7; i++) {
    const a = (i / 7) * Math.PI * 2;
    g.beginPath();
    g.arc(tx + Math.cos(a) * 110, ty - 260 + Math.sin(a) * 90, 85, 0, Math.PI * 2);
    g.stroke();
  }
  for (let i = 0; i < 9; i++) {
    const x = w * 0.05 + R() * w * 0.9;
    const y = h * 0.82 + R() * h * 0.12;
    g.lineWidth = 4;
    g.beginPath();
    g.moveTo(x, y);
    g.lineTo(x, y + 70);
    g.stroke();
    petalFlower(g, x, y, 28 + R() * 14, 5 + Math.floor(R() * 3), R() * Math.PI);
  }
}
