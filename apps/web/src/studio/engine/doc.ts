/**
 * One canvas on screen: a bitmap per layer, built by replaying the server's
 * ops in order. Undo and redo flip an op and rebuild its layer from the
 * nearest checkpoint before it.
 */

import type { DrawOp, StudioLayer, StrokeOp } from '@game-night/shared';
import { StrokeBuffers, StrokeRenderer, renderStroke, type Rect } from './stroke.js';
import { paintFill } from './fill.js';
import { ctx2d, makeCanvas, type Canvas2D } from './tips.js';

interface Checkpoint { seq: number; canvas: Canvas2D }

export interface LayerBitmap {
  meta: StudioLayer;
  canvas: Canvas2D;
  ctx: CanvasRenderingContext2D;
  /** Image this layer starts from (after a bake), once loaded. */
  base: CanvasImageSource | null;
  ops: DrawOp[];
  checkpoints: Checkpoint[];
  /** Ops applied since the last checkpoint. */
  sinceCheckpoint: number;
}

const CHECKPOINT_EVERY = 24;

export class CanvasDoc {
  readonly id: string;
  readonly width: number;
  readonly height: number;
  /** Bitmap pixels per canvas pixel (1 for the canvas you work on, less for thumbnails). */
  readonly scale: number;
  layers: LayerBitmap[] = [];
  private buffers: StrokeBuffers;
  private maxCheckpoints: number;
  /** Bumps on every visible change (for redraw scheduling). */
  version = 0;

  constructor(id: string, width: number, height: number, scale = 1) {
    this.id = id;
    this.width = width;
    this.height = height;
    this.scale = scale;
    this.buffers = new StrokeBuffers(width * scale, height * scale);
    this.maxCheckpoints = scale < 1 ? 0 : 6;
  }

  get pxWidth(): number { return Math.ceil(this.width * this.scale); }
  get pxHeight(): number { return Math.ceil(this.height * this.scale); }

  private pool: StrokeBuffers[] = [];

  /** Scratch buffers for a stroke drawn live on top of this canvas. */
  makeBuffers(): StrokeBuffers {
    return this.pool.pop() ?? new StrokeBuffers(this.pxWidth, this.pxHeight);
  }

  /** Hand buffers back once their stroke has landed (or was dropped). */
  releaseBuffers(buf: StrokeBuffers, used: Rect): void {
    buf.clear(used);
    if (this.pool.length < 4) this.pool.push(buf);
  }

  layer(id: string): LayerBitmap | undefined {
    return this.layers.find((l) => l.meta.id === id);
  }

  /** Match the layer list (order, settings, added and removed layers). */
  setLayers(metas: StudioLayer[], bases: Map<string, CanvasImageSource | null>): void {
    const next: LayerBitmap[] = [];
    for (const meta of metas) {
      let l = this.layer(meta.id);
      if (!l) {
        const canvas = makeCanvas(this.pxWidth, this.pxHeight);
        l = { meta, canvas, ctx: ctx2d(canvas, true), base: null, ops: [], checkpoints: [], sinceCheckpoint: 0 };
      }
      const prevBase = l.meta.base;
      l.meta = meta;
      const base = bases.get(meta.id) ?? null;
      if (meta.base !== prevBase || base !== l.base) {
        l.base = base;
        this.rebuild(l, 0);
      }
      next.push(l);
    }
    this.layers = next;
    this.version++;
  }

  /** Apply one op from the server (in sequence order). */
  apply(op: DrawOp): void {
    const l = this.layer(op.layer);
    if (!l) return;
    l.ops.push(op);
    if (!op.undone) this.draw(l, op);
    l.sinceCheckpoint++;
    if (this.maxCheckpoints > 0 && l.sinceCheckpoint >= CHECKPOINT_EVERY) this.checkpoint(l, op.seq);
    this.version++;
  }

  /** Undo or redo an op (by id). */
  toggle(opId: string, undone: boolean): boolean {
    for (const l of this.layers) {
      const op = l.ops.find((o) => o.id === opId);
      if (!op) continue;
      // The client's log and this layer share op objects, so the flag may
      // already be set: always redraw rather than compare.
      op.undone = undone || undefined;
      this.rebuild(l, op.seq);
      this.version++;
      return true;
    }
    return false;
  }

  /** Forget ops up to `upTo` after a bake (their pixels are already in the layer). */
  dropUpTo(upTo: number): void {
    for (const l of this.layers) {
      l.ops = l.ops.filter((o) => o.seq > upTo);
      l.checkpoints = l.checkpoints.filter((c) => c.seq > upTo);
    }
  }

  /**
   * The layer as it was after op `upTo`, as a PNG (for baking). Replays from
   * the newest checkpoint at or before `upTo`.
   */
  async layerPngAt(layerId: string, upTo: number): Promise<Blob> {
    const l = this.layer(layerId)!;
    const out = makeCanvas(this.pxWidth, this.pxHeight);
    const g = ctx2d(out);
    const cp = [...l.checkpoints].reverse().find((c) => c.seq <= upTo);
    if (cp) g.drawImage(cp.canvas, 0, 0);
    else if (l.base) g.drawImage(l.base, 0, 0, this.pxWidth, this.pxHeight);
    for (const op of l.ops) {
      if (op.seq <= (cp?.seq ?? -1) || op.seq > upTo || op.undone) continue;
      this.drawOn(g, op);
    }
    return await new Promise<Blob>((resolve, reject) =>
      out.toBlob((b) => (b ? resolve(b) : reject(new Error('could not encode the layer'))), 'image/png'));
  }

  /** Draw a stroke in progress (not yet in the log) into its own buffers. */
  liveRenderer(spec: Omit<StrokeOp, 'kind' | 'points'>, buffers: StrokeBuffers): StrokeRenderer {
    return new StrokeRenderer(spec, buffers, this.scale);
  }

  // -------------------------------------------------------------------

  private draw(l: LayerBitmap, op: DrawOp): void {
    this.drawOn(l.ctx, op);
  }

  private drawOn(g: CanvasRenderingContext2D, op: DrawOp): void {
    switch (op.kind) {
      case 'stroke':
        renderStroke(op, g, this.buffers, this.scale);
        return;
      case 'fill':
        paintFill(op, g, this.scale);
        return;
      case 'clear':
        g.save();
        g.setTransform(1, 0, 0, 1, 0, 0);
        g.clearRect(0, 0, this.pxWidth, this.pxHeight);
        g.restore();
        return;
    }
  }

  private checkpoint(l: LayerBitmap, seq: number): void {
    const c = makeCanvas(this.pxWidth, this.pxHeight);
    ctx2d(c).drawImage(l.canvas, 0, 0);
    l.checkpoints.push({ seq, canvas: c });
    l.sinceCheckpoint = 0;
    if (l.checkpoints.length > this.maxCheckpoints) {
      // Keep the newest ones, but thin out rather than drop the oldest outright,
      // so a long undo still finds a nearby starting point.
      l.checkpoints.splice(l.checkpoints.length > 2 ? 1 : 0, 1);
    }
  }

  /** Redraw a layer from the last checkpoint before `fromSeq`. */
  private rebuild(l: LayerBitmap, fromSeq: number): void {
    const keep = l.checkpoints.filter((c) => c.seq < fromSeq);
    l.checkpoints = keep;
    const cp = keep[keep.length - 1];
    const g = l.ctx;
    g.save();
    g.setTransform(1, 0, 0, 1, 0, 0);
    g.globalCompositeOperation = 'copy';
    if (cp) g.drawImage(cp.canvas, 0, 0);
    else g.clearRect(0, 0, this.pxWidth, this.pxHeight);
    g.globalCompositeOperation = 'source-over';
    if (!cp && l.base) g.drawImage(l.base, 0, 0, this.pxWidth, this.pxHeight);
    g.restore();
    l.sinceCheckpoint = 0;
    for (const op of l.ops) {
      if (cp && op.seq <= cp.seq) continue;
      if (!op.undone) this.drawOn(g, op);
      l.sinceCheckpoint++;
      if (this.maxCheckpoints > 0 && l.sinceCheckpoint >= CHECKPOINT_EVERY) this.checkpoint(l, op.seq);
    }
  }
}
