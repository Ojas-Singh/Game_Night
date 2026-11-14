/**
 * Bucket fill. The person filling works out the region on their own screen
 * and sends it as run lengths, so every client paints exactly the same
 * pixels whatever their browser's antialiasing.
 */

import type { FillOp } from '@game-night/shared';
import { ctx2d, hexToRgb, makeCanvas } from './tips.js';

export interface FillOptions {
  /** 'lines': stop at dark lines (colouring pages). 'color': spread over similar colour. */
  mode: 'lines' | 'color';
  /** 0..1 */
  tolerance: number;
  /** Pixels to grow the region by, to tuck the fill under the lines. */
  grow: number;
}

/** Region around (sx, sy) as a FillOp body, or null when nothing would change. */
export function computeFill(
  src: ImageData, sx: number, sy: number, opts: FillOptions,
): Pick<FillOp, 'x' | 'y' | 'w' | 'h' | 'runs'> | null {
  const W = src.width, H = src.height, d = src.data;
  sx = Math.floor(sx);
  sy = Math.floor(sy);
  if (sx < 0 || sy < 0 || sx >= W || sy >= H) return null;
  const seed = (sy * W + sx) * 4;
  const tol = Math.round(opts.tolerance * 255);
  let pass: (i: number) => boolean;
  if (opts.mode === 'lines') {
    // Darkness of the line art: opaque dark pixels are walls.
    const dark = (i: number) => {
      const a = d[i + 3]!;
      const lum = (d[i]! * 0.299 + d[i + 1]! * 0.587 + d[i + 2]! * 0.114);
      return (a * (255 - lum)) / 255;
    };
    const limit = Math.max(8, tol);
    if (dark(seed) > limit) return null;
    pass = (i) => dark(i) <= limit;
  } else {
    const r = d[seed]!, g = d[seed + 1]!, b = d[seed + 2]!, a = d[seed + 3]!;
    pass = (i) => {
      const da = Math.abs(d[i + 3]! - a);
      if (a === 0 && d[i + 3]! === 0) return true;
      return Math.max(Math.abs(d[i]! - r), Math.abs(d[i + 1]! - g), Math.abs(d[i + 2]! - b), da) <= tol;
    };
  }

  const mask = new Uint8Array(W * H);
  // Scanline flood fill.
  const stack: number[] = [sx, sy];
  let minX = sx, maxX = sx, minY = sy, maxY = sy;
  while (stack.length) {
    const y = stack.pop()!;
    const x0 = stack.pop()!;
    let x = x0;
    const row = y * W;
    if (mask[row + x] || !pass((row + x) * 4)) continue;
    while (x > 0 && !mask[row + x - 1] && pass((row + x - 1) * 4)) x--;
    let upOpen = false, downOpen = false;
    for (; x < W && !mask[row + x] && pass((row + x) * 4); x++) {
      mask[row + x] = 1;
      if (x < minX) minX = x;
      if (x > maxX) maxX = x;
      if (y > 0) {
        const up = !mask[row - W + x] && pass((row - W + x) * 4);
        if (up && !upOpen) stack.push(x, y - 1);
        upOpen = up;
      }
      if (y < H - 1) {
        const down = !mask[row + W + x] && pass((row + W + x) * 4);
        if (down && !downOpen) stack.push(x, y + 1);
        downOpen = down;
      }
    }
    if (y < minY) minY = y;
    if (y > maxY) maxY = y;
  }

  // Grow the region (8-neighbour dilation, one pixel per pass).
  for (let k = 0; k < opts.grow; k++) {
    const x0 = Math.max(0, minX - 1), x1 = Math.min(W - 1, maxX + 1);
    const y0 = Math.max(0, minY - 1), y1 = Math.min(H - 1, maxY + 1);
    const add: number[] = [];
    for (let y = y0; y <= y1; y++) {
      for (let x = x0; x <= x1; x++) {
        const i = y * W + x;
        if (mask[i]) continue;
        if (
          (x > 0 && mask[i - 1]) || (x < W - 1 && mask[i + 1]) ||
          (y > 0 && mask[i - W]) || (y < H - 1 && mask[i + W]) ||
          (x > 0 && y > 0 && mask[i - W - 1]) || (x < W - 1 && y > 0 && mask[i - W + 1]) ||
          (x > 0 && y < H - 1 && mask[i + W - 1]) || (x < W - 1 && y < H - 1 && mask[i + W + 1])
        ) add.push(i);
      }
    }
    for (const i of add) mask[i] = 1;
    minX = x0; maxX = x1; minY = y0; maxY = y1;
  }

  const w = maxX - minX + 1, h = maxY - minY + 1;
  const runs: number[] = [];
  let on = 0, len = 0;
  for (let y = minY; y <= maxY; y++) {
    const row = y * W;
    for (let x = minX; x <= maxX; x++) {
      const v = mask[row + x]!;
      if (v === on) len++;
      else {
        runs.push(len);
        on = v;
        len = 1;
      }
    }
  }
  runs.push(len);
  return { x: minX, y: minY, w, h, runs };
}

/** Paint a fill op onto a layer. */
export function paintFill(op: FillOp, target: CanvasRenderingContext2D, scale: number): void {
  const tmp = makeCanvas(op.w, op.h);
  const g = ctx2d(tmp);
  const img = g.createImageData(op.w, op.h);
  const [r, gg, b] = hexToRgb(op.color);
  const data = img.data;
  let pos = 0, on = false;
  for (const len of op.runs) {
    if (on) {
      for (let k = pos; k < pos + len; k++) {
        const i = k * 4;
        data[i] = r; data[i + 1] = gg; data[i + 2] = b; data[i + 3] = 255;
      }
    }
    pos += len;
    on = !on;
  }
  g.putImageData(img, 0, 0);
  target.save();
  target.setTransform(1, 0, 0, 1, 0, 0);
  target.globalAlpha = op.opacity;
  target.globalCompositeOperation = 'source-over';
  target.imageSmoothingEnabled = scale < 1;
  target.drawImage(tmp, op.x * scale, op.y * scale, op.w * scale, op.h * scale);
  target.restore();
}
