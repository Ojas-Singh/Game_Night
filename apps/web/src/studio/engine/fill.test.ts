import { describe, expect, it } from 'vitest';
import { computeFill } from './fill.js';

/** A w×h transparent image with a dark square outline from (2,2) to (7,7). */
function outlined(w = 10, h = 10): ImageData {
  const data = new Uint8ClampedArray(w * h * 4);
  for (let y = 2; y <= 7; y++) {
    for (let x = 2; x <= 7; x++) {
      if (x === 2 || x === 7 || y === 2 || y === 7) data.set([0, 0, 0, 255], (y * w + x) * 4);
    }
  }
  return { width: w, height: h, data, colorSpace: 'srgb' } as ImageData;
}

function decode(r: { x: number; y: number; w: number; h: number; runs: number[] }): Set<string> {
  const out = new Set<string>();
  let pos = 0, on = false;
  for (const len of r.runs) {
    if (on) for (let k = pos; k < pos + len; k++) out.add(`${r.x + (k % r.w)},${r.y + Math.floor(k / r.w)}`);
    pos += len;
    on = !on;
  }
  return out;
}

describe('computeFill', () => {
  it('fills inside the lines and stops at them', () => {
    const r = computeFill(outlined(), 4, 4, { mode: 'lines', tolerance: 0.5, grow: 0 })!;
    const px = decode(r);
    expect(px.size).toBe(16); // the 4×4 inside
    expect(px.has('3,3') && px.has('6,6')).toBe(true);
    expect(px.has('2,2') || px.has('8,8')).toBe(false);
  });

  it('grows under the lines when asked', () => {
    const px = decode(computeFill(outlined(), 4, 4, { mode: 'lines', tolerance: 0.5, grow: 1 })!);
    expect(px.size).toBe(36); // inside plus the outline ring
  });

  it('fills the outside by colour and refuses to start on a line', () => {
    const outside = decode(computeFill(outlined(), 0, 0, { mode: 'color', tolerance: 0.1, grow: 0 })!);
    expect(outside.size).toBe(100 - 36);
    expect(computeFill(outlined(), 2, 2, { mode: 'lines', tolerance: 0.5, grow: 0 })).toBeNull();
  });
});
