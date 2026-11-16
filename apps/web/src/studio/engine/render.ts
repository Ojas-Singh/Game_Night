/**
 * Paper backgrounds and the compositor that stacks paper, picture, layers
 * and strokes in progress into one image (on screen or for export).
 */

import type { LayerBlend, PaperId, StudioImage } from '@game-night/shared';
import type { CanvasDoc } from './doc.js';
import type { StrokeRenderer, StrokeBuffers } from './stroke.js';
import { ctx2d, grainTexture, makeCanvas, rng, type Canvas2D } from './tips.js';

export const PAPER_INFO: Record<PaperId, { name: string; color: string; dark?: boolean }> = {
  white: { name: 'White', color: '#ffffff' },
  cream: { name: 'Cream', color: '#f6efdf' },
  watercolor: { name: 'Cold press', color: '#fbf8f1' },
  kraft: { name: 'Kraft', color: '#c9a47a' },
  canvas: { name: 'Canvas', color: '#efe8da' },
  dots: { name: 'Dot grid', color: '#fdfcf9' },
  grid: { name: 'Grid', color: '#fdfcf9' },
  night: { name: 'Night', color: '#1c2030', dark: true },
};

const paperCache = new Map<string, Canvas2D>();

/** The paper at canvas size and bitmap scale. */
export function paperCanvas(paper: PaperId, w: number, h: number, scale: number): Canvas2D {
  const key = `${paper}:${w}x${h}@${scale}`;
  const hit = paperCache.get(key);
  if (hit) return hit;
  if (paperCache.size > 8) paperCache.clear();
  const c = makeCanvas(w * scale, h * scale);
  const g = ctx2d(c);
  g.scale(scale, scale);
  g.fillStyle = PAPER_INFO[paper].color;
  g.fillRect(0, 0, w, h);
  const tex = grainTexture();
  const pattern = (alpha: number, s: number, op: GlobalCompositeOperation) => {
    const p = g.createPattern(tex, 'repeat');
    if (!p) return;
    p.setTransform(new DOMMatrix([s, 0, 0, s, 0, 0]));
    g.globalAlpha = alpha;
    g.globalCompositeOperation = op;
    g.fillStyle = p;
    g.fillRect(0, 0, w, h);
    g.globalAlpha = 1;
    g.globalCompositeOperation = 'source-over';
  };
  const shade = (alpha: number, s: number) => {
    // Grain as soft shadow: draw the texture tinted dark at low alpha.
    const t = makeCanvas(tex.width, tex.height);
    const tg = ctx2d(t);
    tg.drawImage(tex, 0, 0);
    tg.globalCompositeOperation = 'source-in';
    tg.fillStyle = '#5a4630';
    tg.fillRect(0, 0, t.width, t.height);
    const p = g.createPattern(t, 'repeat');
    if (!p) return;
    p.setTransform(new DOMMatrix([s, 0, 0, s, 0, 0]));
    g.globalAlpha = alpha;
    g.fillStyle = p;
    g.fillRect(0, 0, w, h);
    g.globalAlpha = 1;
  };
  switch (paper) {
    case 'cream':
      shade(0.05, 1.5);
      break;
    case 'watercolor':
      shade(0.1, 2.2);
      break;
    case 'kraft': {
      shade(0.16, 1.2);
      const R = rng(77);
      g.strokeStyle = 'rgba(90,60,30,0.18)';
      for (let i = 0; i < (w * h) / 900; i++) {
        const x = R() * w, y = R() * h, a = R() * Math.PI, l = 3 + R() * 10;
        g.lineWidth = 0.4 + R() * 0.6;
        g.beginPath();
        g.moveTo(x, y);
        g.lineTo(x + Math.cos(a) * l, y + Math.sin(a) * l);
        g.stroke();
      }
      break;
    }
    case 'canvas': {
      g.globalAlpha = 0.07;
      g.fillStyle = '#6b5a40';
      for (let y = 0; y < h; y += 4) g.fillRect(0, y, w, 1.6);
      for (let x = 0; x < w; x += 4) g.fillRect(x, 0, 1.6, h);
      g.globalAlpha = 1;
      shade(0.08, 1);
      break;
    }
    case 'dots': {
      g.fillStyle = 'rgba(60,70,90,0.35)';
      const step = 32;
      for (let y = step; y < h; y += step) for (let x = step; x < w; x += step) {
        g.beginPath();
        g.arc(x, y, 1.6, 0, Math.PI * 2);
        g.fill();
      }
      break;
    }
    case 'grid': {
      const step = 32;
      g.strokeStyle = 'rgba(70,110,170,0.18)';
      g.lineWidth = 1;
      g.beginPath();
      for (let x = step; x < w; x += step) { g.moveTo(x + 0.5, 0); g.lineTo(x + 0.5, h); }
      for (let y = step; y < h; y += step) { g.moveTo(0, y + 0.5); g.lineTo(w, y + 0.5); }
      g.stroke();
      break;
    }
    case 'night':
      pattern(0.04, 1.4, 'screen');
      break;
    default:
      break;
  }
  paperCache.set(key, c);
  return c;
}

const BLEND: Record<LayerBlend, GlobalCompositeOperation> = {
  normal: 'source-over',
  multiply: 'multiply',
  screen: 'screen',
  overlay: 'overlay',
  lighten: 'lighten',
  darken: 'darken',
  color: 'color',
};

/** A stroke being drawn, shown above its layer until it lands in the log. */
export interface Overlay {
  layer: string;
  renderer: StrokeRenderer;
  buffers: StrokeBuffers;
}

export interface ComposeOptions {
  paper: Canvas2D | null;
  image: { el: CanvasImageSource; meta: StudioImage } | null;
  overlays: Overlay[];
  /** Hide one layer (e.g. while it is being exported on its own). */
  skipHidden?: boolean;
}

let eraseScratch: Canvas2D | null = null;

/**
 * Draw the canvas into `g`, whose current transform maps canvas bitmap
 * pixels to the destination.
 */
export function compose(g: CanvasRenderingContext2D, doc: CanvasDoc, opts: ComposeOptions): void {
  const W = doc.pxWidth, H = doc.pxHeight;
  g.save();
  if (opts.paper) g.drawImage(opts.paper, 0, 0, W, H);
  const img = opts.image;
  if (img && img.meta.placement === 'trace') {
    g.globalAlpha = img.meta.opacity;
    g.drawImage(img.el, 0, 0, W, H);
    g.globalAlpha = 1;
  }
  for (const l of doc.layers) {
    if (!l.meta.visible) continue;
    const mine = opts.overlays.filter((o) => o.layer === l.meta.id);
    const erasing = mine.filter((o) => o.renderer.spec.erase);
    let src: Canvas2D = l.canvas;
    if (erasing.length) {
      if (!eraseScratch || eraseScratch.width !== W || eraseScratch.height !== H) eraseScratch = makeCanvas(W, H);
      const e = ctx2d(eraseScratch);
      e.globalCompositeOperation = 'copy';
      e.drawImage(l.canvas, 0, 0);
      for (const o of erasing) {
        e.globalCompositeOperation = 'destination-out';
        e.globalAlpha = o.renderer.spec.opacity;
        e.drawImage(o.buffers.view, 0, 0);
      }
      e.globalAlpha = 1;
      e.globalCompositeOperation = 'source-over';
      src = eraseScratch;
    }
    g.globalCompositeOperation = BLEND[l.meta.blend] ?? 'source-over';
    g.globalAlpha = l.meta.opacity;
    g.drawImage(src, 0, 0);
    for (const o of mine) {
      if (o.renderer.spec.erase) continue;
      g.globalAlpha = l.meta.opacity * o.renderer.spec.opacity;
      g.drawImage(o.buffers.view, 0, 0);
    }
  }
  g.globalCompositeOperation = 'source-over';
  g.globalAlpha = 1;
  if (img && img.meta.placement === 'lines') {
    g.globalCompositeOperation = 'multiply';
    g.globalAlpha = img.meta.opacity;
    g.drawImage(img.el, 0, 0, W, H);
  }
  g.restore();
}

/** The finished picture as a PNG. */
export async function exportPng(doc: CanvasDoc, opts: ComposeOptions, transparent: boolean): Promise<Blob> {
  const c = makeCanvas(doc.pxWidth, doc.pxHeight);
  const g = ctx2d(c);
  compose(g, doc, { ...opts, paper: transparent ? null : opts.paper, overlays: [] });
  return await new Promise<Blob>((resolve, reject) =>
    c.toBlob((b) => (b ? resolve(b) : reject(new Error('could not export'))), 'image/png'));
}
