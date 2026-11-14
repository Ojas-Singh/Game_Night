/**
 * Stroke rendering: stamps the brush tip along a smoothed path into a
 * scratch buffer, then composites the buffer onto a layer at the stroke's
 * opacity (so overlapping stamps never darken past it).
 *
 * Points arrive in chunks while the pen moves and all at once on replay;
 * both paths stamp exactly the same sequence, so a live stroke and its
 * replay on another screen look the same.
 */

import type { StrokeOp, StrokeSymmetry } from '@game-night/shared';
import { brushById, type Brush } from './brushes.js';
import { ctx2d, grainMask, makeCanvas, rng, shiftColor, hslToHex, tintedTip, TIP_SIZE, type Canvas2D } from './tips.js';

export type StrokeSpec = Omit<StrokeOp, 'kind' | 'points'>;

export interface Rect { x0: number; y0: number; x1: number; y1: number }

export function emptyRect(): Rect {
  return { x0: Infinity, y0: Infinity, x1: -Infinity, y1: -Infinity };
}

export function isEmpty(r: Rect): boolean {
  return r.x1 <= r.x0 || r.y1 <= r.y0;
}

function grow(r: Rect, x: number, y: number, rad: number): void {
  if (x - rad < r.x0) r.x0 = x - rad;
  if (y - rad < r.y0) r.y0 = y - rad;
  if (x + rad > r.x1) r.x1 = x + rad;
  if (y + rad > r.y1) r.y1 = y + rad;
}

/** Scratch buffers a stroke draws into (one pair per stroke in flight). */
export class StrokeBuffers {
  raw: Canvas2D;
  view: Canvas2D;
  rawCtx: CanvasRenderingContext2D;
  viewCtx: CanvasRenderingContext2D;

  constructor(w: number, h: number) {
    this.raw = makeCanvas(w, h);
    this.view = makeCanvas(w, h);
    this.rawCtx = ctx2d(this.raw);
    this.viewCtx = ctx2d(this.view);
  }

  clear(px: Rect): void {
    if (isEmpty(px)) return;
    const x = Math.floor(px.x0), y = Math.floor(px.y0);
    const w = Math.ceil(px.x1) - x, h = Math.ceil(px.y1) - y;
    this.rawCtx.setTransform(1, 0, 0, 1, 0, 0);
    this.viewCtx.setTransform(1, 0, 0, 1, 0, 0);
    this.rawCtx.clearRect(x, y, w, h);
    this.viewCtx.clearRect(x, y, w, h);
  }
}

interface Pt { x: number; y: number; p: number; tx: number; ty: number }

const supportsFilter = typeof document !== 'undefined' &&
  'filter' in (document.createElement('canvas').getContext('2d') ?? {});

export class StrokeRenderer {
  readonly spec: StrokeSpec;
  readonly brush: Brush;
  /** Dirty area in buffer pixels, for the whole stroke so far. */
  readonly dirty: Rect = emptyRect();
  private chunk: Rect = emptyRect();
  private R: () => number;
  private pts: Pt[] = [];
  private carry = 0;
  private travelled = 0;
  private started = false;
  private lastDir = 0;
  private finished = false;

  constructor(spec: StrokeSpec, private buf: StrokeBuffers, private scale: number) {
    this.spec = spec;
    this.brush = brushById(spec.brush);
    this.R = rng(spec.seed);
  }

  /** Add points (flat x, y, pressure, tiltX, tiltY). Returns the buffer area touched. */
  push(values: number[]): Rect {
    this.chunk = emptyRect();
    const ctx = this.buf.rawCtx;
    ctx.setTransform(this.scale, 0, 0, this.scale, 0, 0);
    for (let i = 0; i + 4 < values.length; i += 5) {
      const pt: Pt = { x: values[i]!, y: values[i + 1]!, p: values[i + 2]!, tx: values[i + 3]!, ty: values[i + 4]! };
      this.pts.push(pt);
      const n = this.pts.length;
      if (n === 1) {
        this.stampAt(pt.x, pt.y, pt.p, pt.tx, pt.ty, 0);
        this.started = true;
        continue;
      }
      const a = n === 2 ? this.pts[0]! : mid(this.pts[n - 3]!, this.pts[n - 2]!);
      const c = this.pts[n - 2]!;
      const b = mid(c, pt);
      this.walk(a, c, b);
      if (this.pts.length > 4) this.pts.splice(0, this.pts.length - 4);
    }
    this.syncView();
    return this.chunk;
  }

  /** Draw the last half segment and apply wet edges. */
  finish(): Rect {
    if (this.finished) return emptyRect();
    this.finished = true;
    this.chunk = emptyRect();
    const n = this.pts.length;
    if (n >= 2) {
      const ctx = this.buf.rawCtx;
      ctx.setTransform(this.scale, 0, 0, this.scale, 0, 0);
      const last = this.pts[n - 1]!;
      const a = mid(this.pts[n - 2]!, last);
      this.walk(a, mid(a, last), last);
    }
    this.syncView();
    if (this.brush.wetEdge > 0 && supportsFilter && !isEmpty(this.dirty)) this.wetEdges();
    return this.chunk;
  }

  /** Composite the finished stroke onto a layer. */
  composite(target: CanvasRenderingContext2D): void {
    const d = this.dirty;
    if (isEmpty(d)) return;
    const x = Math.max(0, Math.floor(d.x0)), y = Math.max(0, Math.floor(d.y0));
    const w = Math.min(this.buf.view.width, Math.ceil(d.x1)) - x;
    const h = Math.min(this.buf.view.height, Math.ceil(d.y1)) - y;
    if (w <= 0 || h <= 0) return;
    target.save();
    target.setTransform(1, 0, 0, 1, 0, 0);
    target.globalAlpha = this.spec.opacity;
    target.globalCompositeOperation = this.spec.erase ? 'destination-out' : 'source-over';
    target.drawImage(this.buf.view, x, y, w, h, x, y, w, h);
    target.restore();
  }

  // -------------------------------------------------------------------

  /** Copy the new raw stamps into the view buffer and apply the paper grain. */
  private syncView(): void {
    const c = this.chunk;
    if (isEmpty(c)) return;
    const W = this.buf.raw.width, H = this.buf.raw.height;
    const x = Math.max(0, Math.floor(c.x0)), y = Math.max(0, Math.floor(c.y0));
    const w = Math.min(W, Math.ceil(c.x1)) - x, h = Math.min(H, Math.ceil(c.y1)) - y;
    if (w <= 0 || h <= 0) return;
    const v = this.buf.viewCtx;
    v.setTransform(1, 0, 0, 1, 0, 0);
    v.globalCompositeOperation = 'source-over';
    v.globalAlpha = 1;
    v.clearRect(x, y, w, h);
    v.drawImage(this.buf.raw, x, y, w, h, x, y, w, h);
    if (this.brush.grain > 0) {
      const pat = v.createPattern(grainMask(this.brush.grain), 'repeat');
      if (pat) {
        const s = this.brush.grainScale * this.scale;
        pat.setTransform(new DOMMatrix([s, 0, 0, s, 0, 0]));
        // destination-in clears everything outside the shape it draws, so
        // clip to the new area or earlier parts of the stroke would vanish.
        v.save();
        v.beginPath();
        v.rect(x, y, w, h);
        v.clip();
        v.globalCompositeOperation = 'destination-in';
        v.fillStyle = pat;
        v.fillRect(x, y, w, h);
        v.restore();
      }
    }
  }

  /** Watercolour: pigment gathers at the edge as the wash dries. */
  private wetEdges(): void {
    const d = this.dirty;
    const pad = 8;
    const x = Math.max(0, Math.floor(d.x0) - pad), y = Math.max(0, Math.floor(d.y0) - pad);
    const w = Math.min(this.buf.view.width, Math.ceil(d.x1) + pad) - x;
    const h = Math.min(this.buf.view.height, Math.ceil(d.y1) + pad) - y;
    if (w <= 0 || h <= 0) return;
    const tmp = makeCanvas(w, h);
    const t = ctx2d(tmp);
    const blur = Math.max(1, Math.min(14, (this.spec.size * this.scale) / 10));
    t.filter = `blur(${blur.toFixed(1)}px)`;
    t.drawImage(this.buf.view, x, y, w, h, 0, 0, w, h);
    t.filter = 'none';
    const v = this.buf.viewCtx;
    v.setTransform(1, 0, 0, 1, 0, 0);
    v.globalCompositeOperation = 'destination-out';
    v.globalAlpha = Math.min(0.9, this.brush.wetEdge);
    v.drawImage(tmp, x, y);
    v.globalAlpha = 1;
    v.globalCompositeOperation = 'source-over';
  }

  /** Walk a quadratic curve a→b (control c), stamping at the brush spacing. */
  private walk(a: Pt, c: Pt, b: Pt): void {
    const len = dist(a, c) + dist(c, b);
    if (len < 1e-6) return;
    const steps = Math.max(2, Math.ceil(len / 0.75));
    let px = a.x, py = a.y;
    for (let i = 1; i <= steps; i++) {
      const t = i / steps;
      const u = 1 - t;
      const x = u * u * a.x + 2 * u * t * c.x + t * t * b.x;
      const y = u * u * a.y + 2 * u * t * c.y + t * t * b.y;
      const step = Math.hypot(x - px, y - py);
      if (step > 1e-9) this.lastDir = Math.atan2(y - py, x - px);
      this.carry += step;
      this.travelled += step;
      const p = a.p + (b.p - a.p) * t;
      const spacing = Math.max(0.4, this.brush.spacing * this.sizeAt(p, a.tx, a.ty));
      while (this.carry >= spacing) {
        this.carry -= spacing;
        const back = this.carry / Math.max(step, 1e-9);
        const sx = x - (x - px) * back, sy = y - (y - py) * back;
        const tx = a.tx + (b.tx - a.tx) * t, ty = a.ty + (b.ty - a.ty) * t;
        this.stampAt(sx, sy, p, tx, ty, this.lastDir);
      }
      px = x;
      py = y;
    }
  }

  private sizeAt(p: number, tx: number, ty: number): number {
    const br = this.brush;
    let s = this.spec.size * (1 - br.sizePressure * (1 - p));
    if (br.tiltShade > 0) {
      const tilt = Math.min(1, Math.hypot(tx, ty) / 70);
      s *= 1 + br.tiltShade * tilt * tilt;
    }
    if (br.taper > 0) {
      const ramp = Math.min(1, this.travelled / (br.taper * this.spec.size + 1e-6));
      s *= 0.15 + 0.85 * Math.sqrt(ramp);
    }
    return Math.max(this.spec.size * br.minSize, s, 0.35);
  }

  private stampAt(x: number, y: number, p: number, tx: number, ty: number, dir: number): void {
    const br = this.brush;
    const R = this.R;
    const ctx = this.buf.rawCtx;
    const size = this.sizeAt(p, tx, ty);
    let flow = br.flow * (1 - br.flowPressure * (1 - p));
    if (br.tiltShade > 0) flow *= 1 - 0.45 * Math.min(1, Math.hypot(tx, ty) / 70);
    for (let k = 0; k < br.count; k++) {
      let s = size * (1 + br.jitterSize * (R() * 2 - 1));
      if (s < 0.3) s = 0.3;
      let angle: number;
      switch (br.angle) {
        case 'direction': angle = dir; break;
        case 'tilt': angle = Math.atan2(ty, tx); break;
        case 'random': angle = R() * Math.PI * 2; break;
        default: angle = 0;
      }
      angle += (br.angleDeg * Math.PI) / 180 + br.jitterAngle * (R() * 2 - 1) * Math.PI;
      let sx = x, sy = y;
      if (br.scatter > 0) {
        const a = R() * Math.PI * 2;
        const r = Math.sqrt(R()) * br.scatter * size * 0.5;
        sx += Math.cos(a) * r;
        sy += Math.sin(a) * r;
      }
      const alpha = flow * (1 - br.jitterOpacity * R());
      let color = this.spec.erase ? '#000000' : this.spec.color;
      if (!this.spec.erase && br.rainbow) {
        const hue = Math.floor(((this.travelled / (this.spec.size * 14 + 40)) % 1) * 48) / 48;
        color = hslToHex(hue, 0.85, 0.55);
      } else if (!this.spec.erase && (br.jitterHue > 0 || br.jitterLight > 0)) {
        const dh = Math.round(br.jitterHue * (R() * 2 - 1) * 16) / 16;
        const dl = Math.round(br.jitterLight * (R() * 2 - 1) * 16) / 16;
        color = shiftColor(color, dh, dl);
      }
      if (alpha <= 0.002) continue;
      const tip = tintedTip(br, color);
      for (const [mx, my, flip, rot] of this.copies(sx, sy)) {
        const ang = angle + rot;
        const cos = Math.cos(ang), sin = Math.sin(ang);
        const sc = this.scale;
        const kx = (s / TIP_SIZE) * sc, ky = ((s * br.roundness) / TIP_SIZE) * sc;
        // Rotate and squash the tip, then mirror: x flips the first row, y the second.
        let a = cos * kx, c = -sin * ky, b = sin * kx, d = cos * ky;
        if (flip === 1) { a = -a; c = -c; }
        if (flip === 2) { b = -b; d = -d; }
        ctx.setTransform(a, b, c, d, mx * sc, my * sc);
        ctx.globalAlpha = Math.min(1, alpha);
        ctx.drawImage(tip, -TIP_SIZE / 2, -TIP_SIZE / 2);
        const rad = (s / 2 + 1) * sc;
        grow(this.chunk, mx * sc, my * sc, rad);
        grow(this.dirty, mx * sc, my * sc, rad);
      }
    }
    ctx.globalAlpha = 1;
  }

  /** Positions (and mirroring) of every symmetric copy of a stamp. */
  private copies(x: number, y: number): Array<[number, number, number, number]> {
    const sym: StrokeSymmetry | undefined = this.spec.sym;
    if (!sym) return [[x, y, 0, 0]];
    const { cx, cy } = sym;
    switch (sym.kind) {
      case 'vertical': return [[x, y, 0, 0], [2 * cx - x, y, 1, 0]];
      case 'horizontal': return [[x, y, 0, 0], [x, 2 * cy - y, 2, 0]];
      case 'quadrant': return [[x, y, 0, 0], [2 * cx - x, y, 1, 0], [x, 2 * cy - y, 2, 0], [2 * cx - x, 2 * cy - y, 0, Math.PI]];
      case 'radial': {
        const out: Array<[number, number, number, number]> = [];
        const n = sym.count;
        for (let i = 0; i < n; i++) {
          const a = (i * 2 * Math.PI) / n;
          const c = Math.cos(a), s = Math.sin(a);
          const dx = x - cx, dy = y - cy;
          out.push([cx + dx * c - dy * s, cy + dx * s + dy * c, 0, a]);
        }
        return out;
      }
    }
  }
}

function mid(a: Pt, b: Pt): Pt {
  return { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2, p: (a.p + b.p) / 2, tx: (a.tx + b.tx) / 2, ty: (a.ty + b.ty) / 2 };
}

function dist(a: Pt, b: Pt): number {
  return Math.hypot(b.x - a.x, b.y - a.y);
}

/** Render a whole stroke op onto a layer. */
export function renderStroke(op: StrokeOp, target: CanvasRenderingContext2D, buf: StrokeBuffers, scale: number): void {
  const r = new StrokeRenderer(op, buf, scale);
  r.push(op.points);
  r.finish();
  r.composite(target);
  buf.clear(r.dirty);
}
