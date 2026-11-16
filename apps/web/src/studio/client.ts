/**
 * The studio's client side: keeps the server's state and op log, builds a
 * CanvasDoc per canvas, shows other people's strokes as they draw, and sends
 * this person's strokes, fills, undos and layer edits.
 *
 * Plain class with a change counter; React reads it through useStudio.
 */

import type { Socket } from 'socket.io-client';
import {
  SHARED_CANVAS, type DrawOp, type DrawOpBody, type LayerEdit, type LiveStroke, type StudioBake,
  type StudioCursor, type StudioSetup, type StudioSnapshot, type StudioState, type StrokeOp,
} from '@game-night/shared';
import { CanvasDoc } from './engine/doc.js';
import type { StrokeBuffers, StrokeRenderer } from './engine/stroke.js';
import { type Overlay } from './engine/render.js';
import { loadSession } from '../session.js';

type Res = { ok: boolean; error?: string; [k: string]: unknown };

interface Live {
  id: string;
  by: string;
  canvas: string;
  layer: string;
  renderer: StrokeRenderer;
  buffers: StrokeBuffers;
  at: number;
}

export interface RemoteCursor extends StudioCursor { at: number }

/** Thumbnails of other people's canvases are drawn at this scale. */
const THUMB_SCALE = 0.25;

export function newId(): string {
  const a = new Uint8Array(9);
  crypto.getRandomValues(a);
  return btoa(String.fromCharCode(...a)).replace(/\+/g, '-').replace(/\//g, '_');
}

export class StudioClient {
  state: StudioState | null = null;
  /** Ops per canvas, in sequence order. */
  private log = new Map<string, DrawOp[]>();
  docs = new Map<string, CanvasDoc>();
  images = new Map<string, HTMLImageElement>();
  private imageLoads = new Map<string, Promise<HTMLImageElement | null>>();
  ready = false;
  /** Canvas shown big (mine, the shared one, or someone else's I am looking at). */
  focus: string = SHARED_CANVAS;
  myCanvas: string = SHARED_CANVAS;
  /** My ops still drawable (undo stack) and the ones I undid (redo stack). */
  undoStack: string[] = [];
  redoStack: string[] = [];
  live = new Map<string, Live>();
  /** My strokes waiting for the server to number them. */
  pending = new Map<string, Overlay & { canvas: string }>();
  /** My stroke in progress. */
  drawing: (Overlay & { canvas: string; id: string }) | null = null;
  cursors = new Map<string, RemoteCursor>();
  error: string | null = null;
  /** Bumps on every change; drives both React and canvas redraws. */
  version = 0;
  private listeners = new Set<() => void>();
  private loadToken = 0;
  private disposed = false;

  constructor(private socket: Socket, private roomId: string, public myId: string) {
    socket.on('draw:snapshot', this.onSnapshot);
    socket.on('draw:state', this.onState);
    socket.on('draw:op', this.onOp);
    socket.on('draw:toggle', this.onToggle);
    socket.on('draw:live', this.onLive);
    socket.on('draw:cursor', this.onCursor);
    socket.on('draw:baked', this.onBaked);
    socket.on('draw:bake_request', this.onBakeRequest);
    socket.on('connect', this.sync);
    this.sync();
  }

  dispose(): void {
    this.disposed = true;
    this.socket.off('draw:snapshot', this.onSnapshot);
    this.socket.off('draw:state', this.onState);
    this.socket.off('draw:op', this.onOp);
    this.socket.off('draw:toggle', this.onToggle);
    this.socket.off('draw:live', this.onLive);
    this.socket.off('draw:cursor', this.onCursor);
    this.socket.off('draw:baked', this.onBaked);
    this.socket.off('draw:bake_request', this.onBakeRequest);
    this.socket.off('connect', this.sync);
    this.listeners.clear();
  }

  subscribe = (fn: () => void): (() => void) => {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  };

  getVersion = (): number => this.version;

  changed(): void {
    this.version++;
    for (const fn of this.listeners) fn();
  }

  // -------------------------------------------------------------------
  // Incoming
  // -------------------------------------------------------------------

  sync = (): void => {
    this.socket.emit('draw:sync', {}, (res: Res) => {
      const snap = res?.snapshot as StudioSnapshot | null | undefined;
      if (res?.ok && snap) this.onSnapshot(snap);
    });
  };

  private onSnapshot = (snap: StudioSnapshot): void => {
    const token = ++this.loadToken;
    this.ready = false;
    this.state = snap.state;
    this.log.clear();
    for (const op of snap.ops) this.logOf(op.canvas).push(op);
    const mine = new Set(snap.ops.filter((o) => o.by === this.myId).map((o) => o.id));
    this.undoStack = snap.ops.filter((o) => o.by === this.myId && !o.undone).map((o) => o.id);
    this.redoStack = this.redoStack.filter((id) => mine.has(id));
    this.live.clear();
    this.pending.clear();
    this.docs.clear();
    this.pickCanvases();
    this.changed();
    void this.loadAssets().then(() => {
      if (token !== this.loadToken || this.disposed) return;
      this.rebuildDocs();
      this.ready = true;
      this.changed();
    });
  };

  private onState = (state: StudioState): void => {
    const prev = this.state;
    this.state = state;
    if (prev && prev.epoch !== state.epoch) {
      this.sync();
      return;
    }
    // Ops of removed layers are gone on the server too.
    for (const c of state.canvases) {
      const ids = new Set(c.layers.map((l) => l.id));
      const list = this.log.get(c.id);
      if (list) this.log.set(c.id, list.filter((o) => ids.has(o.layer)));
    }
    this.pickCanvases();
    this.changed();
    void this.loadAssets().then(() => {
      if (this.disposed || !this.ready) return;
      this.syncDocs();
      this.changed();
    });
  };

  private onOp = (op: DrawOp): void => {
    this.logOf(op.canvas).push(op);
    if (this.ready) this.docs.get(op.canvas)?.apply(op);
    if (op.by === this.myId) {
      this.release(this.pending.get(op.id));
      this.pending.delete(op.id);
    }
    this.release(this.live.get(op.id));
    this.live.delete(op.id);
    this.changed();
  };

  private onToggle = ({ opId, undone }: { opId: string; undone: boolean }): void => {
    for (const list of this.log.values()) {
      const op = list.find((o) => o.id === opId);
      if (op) {
        op.undone = undone || undefined;
        if (this.ready) this.docs.get(op.canvas)?.toggle(opId, undone);
        break;
      }
    }
    this.changed();
  };

  private onLive = (l: LiveStroke): void => {
    if (!this.ready) return;
    const doc = this.docs.get(l.canvas);
    if (!doc) return;
    let entry = this.live.get(l.id);
    if (l.cancel) {
      this.release(entry);
      this.live.delete(l.id);
      this.changed();
      return;
    }
    if (!entry) {
      if (!l.head) return;
      const buffers = doc.makeBuffers();
      entry = { id: l.id, by: l.by, canvas: l.canvas, layer: l.layer, buffers, renderer: doc.liveRenderer(l.head, buffers), at: 0 };
      this.live.set(l.id, entry);
    }
    entry.at = performance.now();
    entry.renderer.push(l.points);
    this.changed();
  };

  private onCursor = (c: StudioCursor): void => {
    if (c.gone) this.cursors.delete(c.by);
    else this.cursors.set(c.by, { ...c, at: performance.now() });
    this.changed();
  };

  private onBaked = ({ canvas, upTo, state }: { canvas: string; upTo: number; state: StudioState }): void => {
    const list = this.log.get(canvas);
    if (list) this.log.set(canvas, list.filter((o) => o.seq > upTo));
    const gone = new Set((list ?? []).filter((o) => o.seq <= upTo).map((o) => o.id));
    this.undoStack = this.undoStack.filter((id) => !gone.has(id));
    this.redoStack = this.redoStack.filter((id) => !gone.has(id));
    this.state = state;
    void this.loadAssets().then(() => {
      if (this.disposed || !this.ready) return;
      const doc = this.docs.get(canvas);
      doc?.dropUpTo(upTo);
      this.syncDocs();
      this.changed();
    });
  };

  private baking = false;

  private onBakeRequest = async ({ canvas, upTo }: { canvas: string; upTo: number }): Promise<void> => {
    const doc = this.docs.get(canvas);
    if (this.baking || !this.ready || !doc || doc.scale !== 1 || !this.state) return;
    this.baking = true;
    try {
      const layers: Record<string, string> = {};
      for (const l of doc.layers) {
        const blob = await doc.layerPngAt(l.meta.id, upTo);
        layers[l.meta.id] = await this.upload(blob);
      }
      const bake: StudioBake = { canvas, upTo, layers };
      this.socket.emit('draw:bake', bake, () => {});
    } catch (err) {
      console.warn('studio bake failed', err);
    } finally {
      this.baking = false;
    }
  };

  // -------------------------------------------------------------------
  // Docs and assets
  // -------------------------------------------------------------------

  /** Return a finished overlay's buffers to its canvas's pool. */
  private release(o: { canvas: string; renderer: StrokeRenderer; buffers: StrokeBuffers } | undefined): void {
    if (!o) return;
    this.docs.get(o.canvas)?.releaseBuffers(o.buffers, o.renderer.dirty);
  }

  private logOf(canvas: string): DrawOp[] {
    let list = this.log.get(canvas);
    if (!list) this.log.set(canvas, (list = []));
    return list;
  }

  /** Choose my canvas and the focused one for the current mode. */
  private pickCanvases(): void {
    const s = this.state;
    if (!s) return;
    if (s.mode !== 'side-by-side') {
      this.myCanvas = SHARED_CANVAS;
      this.focus = SHARED_CANVAS;
      return;
    }
    const mine = s.canvases.find((c) => c.ownerId === this.myId);
    if (mine) {
      if (this.myCanvas !== mine.id && (this.focus === this.myCanvas || !s.canvases.some((c) => c.id === this.focus))) {
        this.focus = mine.id;
      }
      this.myCanvas = mine.id;
    } else if (s.open) {
      this.socket.emit('draw:mine', {}, () => {});
    }
    if (!s.canvases.some((c) => c.id === this.focus)) this.focus = mine?.id ?? s.canvases[0]?.id ?? SHARED_CANVAS;
  }

  imageUrl(asset: string): string {
    return `/api/studio/${encodeURIComponent(this.roomId)}/asset/${encodeURIComponent(asset)}`;
  }

  loadImage(asset: string): Promise<HTMLImageElement | null> {
    let p = this.imageLoads.get(asset);
    if (p) return p;
    p = new Promise((resolve) => {
      const img = new Image();
      img.decoding = 'async';
      img.onload = () => {
        this.images.set(asset, img);
        resolve(img);
      };
      img.onerror = () => {
        this.imageLoads.delete(asset);
        resolve(null);
      };
      img.src = this.imageUrl(asset);
    });
    this.imageLoads.set(asset, p);
    return p;
  }

  private async loadAssets(): Promise<void> {
    const s = this.state;
    if (!s) return;
    const wanted: string[] = [];
    if (s.image) wanted.push(s.image.asset);
    for (const c of s.canvases) for (const l of c.layers) if (l.base) wanted.push(l.base);
    await Promise.all(wanted.map((a) => this.loadImage(a)));
  }

  private scaleFor(canvasId: string): number {
    return canvasId === this.focus || canvasId === this.myCanvas ? 1 : THUMB_SCALE;
  }

  private bases(layers: { id: string; base: string | null }[]): Map<string, CanvasImageSource | null> {
    return new Map(layers.map((l) => [l.id, l.base ? this.images.get(l.base) ?? null : null]));
  }

  private buildDoc(canvasId: string): CanvasDoc | null {
    const s = this.state!;
    const meta = s.canvases.find((c) => c.id === canvasId);
    if (!meta) return null;
    const doc = new CanvasDoc(canvasId, s.width, s.height, this.scaleFor(canvasId));
    doc.setLayers(meta.layers, this.bases(meta.layers));
    for (const op of this.log.get(canvasId) ?? []) doc.apply(op);
    return doc;
  }

  private rebuildDocs(): void {
    this.docs.clear();
    this.syncDocs();
  }

  /** Create, rescale, update or drop docs to match the state. */
  private syncDocs(): void {
    const s = this.state;
    if (!s) return;
    const ids = new Set(s.canvases.map((c) => c.id));
    for (const id of [...this.docs.keys()]) if (!ids.has(id)) this.docs.delete(id);
    for (const meta of s.canvases) {
      const doc = this.docs.get(meta.id);
      if (!doc || doc.scale !== this.scaleFor(meta.id) || doc.width !== s.width || doc.height !== s.height) {
        const fresh = this.buildDoc(meta.id);
        if (fresh) this.docs.set(meta.id, fresh);
      } else {
        doc.setLayers(meta.layers, this.bases(meta.layers));
      }
    }
  }

  /** Look at another canvas (side by side). */
  setFocus(canvasId: string): void {
    if (this.focus === canvasId) return;
    this.focus = canvasId;
    if (this.ready) this.syncDocs();
    this.changed();
  }

  get focusDoc(): CanvasDoc | undefined {
    return this.docs.get(this.focus);
  }

  /** Can I draw on the focused canvas? */
  get canDraw(): boolean {
    const meta = this.state?.canvases.find((c) => c.id === this.focus);
    return !!this.state?.open && !!meta && (!meta.ownerId || meta.ownerId === this.myId);
  }

  /** Overlays (strokes in flight) for one canvas. */
  overlaysFor(canvas: string): Overlay[] {
    const out: Overlay[] = [];
    for (const l of this.live.values()) if (l.canvas === canvas) out.push(l);
    for (const p of this.pending.values()) if (p.canvas === canvas) out.push(p);
    if (this.drawing && this.drawing.canvas === canvas) out.push(this.drawing);
    return out;
  }

  /** Drop strokes from people who stopped sending (closed the tab mid-stroke). */
  sweep(now = performance.now()): void {
    let dirty = false;
    for (const [id, l] of this.live) if (now - l.at > 8000) { this.release(l); this.live.delete(id); dirty = true; }
    for (const [id, c] of this.cursors) if (now - c.at > 6000) { this.cursors.delete(id); dirty = true; }
    if (dirty) this.changed();
  }

  // -------------------------------------------------------------------
  // Outgoing
  // -------------------------------------------------------------------

  private emit(event: string, payload: unknown): Promise<Res> {
    return new Promise((resolve) => {
      this.socket.timeout(15_000).emit(event, payload, (err: Error | null, res: Res) => {
        resolve(err ? { ok: false, error: 'the server did not answer' } : res ?? { ok: false });
      });
    });
  }

  private fail(error?: string): void {
    this.error = error ?? 'something went wrong';
    this.changed();
  }

  clearError(): void {
    this.error = null;
    this.changed();
  }

  /** Start my stroke: returns the renderer to push points into. */
  beginStroke(layer: string, head: Omit<StrokeOp, 'kind' | 'points'>): StrokeRenderer | null {
    const doc = this.focusDoc;
    if (!doc || !this.canDraw) return null;
    const buffers = doc.makeBuffers();
    const id = newId();
    const renderer = doc.liveRenderer(head, buffers);
    this.drawing = { id, canvas: doc.id, layer, renderer, buffers };
    this.liveSent = 0;
    this.liveHead = head;
    return renderer;
  }

  private liveSent = 0;
  private liveHead: Omit<StrokeOp, 'kind' | 'points'> | null = null;

  /** Relay new points of my stroke to the others. */
  sendLive(points: number[]): void {
    const d = this.drawing;
    if (!d) return;
    const chunk = points.slice(this.liveSent);
    if (!chunk.length) return;
    const live: LiveStroke = {
      id: d.id, by: this.myId, canvas: d.canvas, layer: d.layer, points: chunk,
      head: this.liveSent === 0 ? this.liveHead! : undefined,
    };
    this.liveSent = points.length;
    this.socket.emit('draw:live', live);
  }

  /** Finish my stroke and send it. */
  async endStroke(points: number[], sym: StrokeOp['sym']): Promise<void> {
    const d = this.drawing;
    this.drawing = null;
    if (!d || !this.liveHead) return;
    d.renderer.finish();
    this.pending.set(d.id, d);
    this.changed();
    const body: StrokeOp = { kind: 'stroke', ...this.liveHead, points, sym };
    await this.sendOp(d.id, d.canvas, d.layer, body);
  }

  /** Drop my stroke in progress (e.g. the second finger arrived: it was a pinch). */
  cancelStroke(): void {
    const d = this.drawing;
    this.drawing = null;
    if (!d) return;
    this.cancelLive(d);
    this.release(d);
    this.changed();
  }

  private cancelLive(d: { id: string; canvas: string; layer: string }): void {
    if (this.liveSent > 0) {
      this.socket.emit('draw:live', { id: d.id, by: this.myId, canvas: d.canvas, layer: d.layer, points: [], cancel: true });
    }
    this.liveSent = 0;
  }

  /** Start my stroke over in the same buffers (QuickShape redraws it as a shape). */
  restartStroke(): StrokeRenderer | null {
    const d = this.drawing;
    const doc = d && this.docs.get(d.canvas);
    if (!d || !doc || !this.liveHead) return null;
    this.cancelLive(d);
    d.buffers.clear(d.renderer.dirty);
    d.id = newId();
    d.renderer = doc.liveRenderer(this.liveHead, d.buffers);
    return d.renderer;
  }

  async sendOp(id: string, canvas: string, layer: string, body: DrawOpBody): Promise<boolean> {
    const res = await this.emit('draw:op', { id, canvas, layer, body });
    if (!res.ok) {
      this.release(this.pending.get(id));
      this.pending.delete(id);
      this.fail(res.error);
      return false;
    }
    this.undoStack.push(id);
    this.redoStack = [];
    this.changed();
    return true;
  }

  async undo(): Promise<void> {
    const id = this.undoStack.pop();
    if (!id) return;
    const res = await this.emit('draw:toggle', { opId: id, undone: true });
    if (res.ok) this.redoStack.push(id);
    else this.fail(res.error);
    this.changed();
  }

  async redo(): Promise<void> {
    const id = this.redoStack.pop();
    if (!id) return;
    const res = await this.emit('draw:toggle', { opId: id, undone: false });
    if (res.ok) this.undoStack.push(id);
    else this.fail(res.error);
    this.changed();
  }

  async editLayers(edit: LayerEdit): Promise<boolean> {
    const res = await this.emit('draw:layers', edit);
    if (!res.ok) this.fail(res.error);
    return res.ok;
  }

  async setup(patch: StudioSetup): Promise<boolean> {
    const res = await this.emit('draw:setup', patch);
    if (!res.ok) this.fail(res.error);
    return res.ok;
  }

  async wipe(): Promise<void> {
    const res = await this.emit('draw:wipe', {});
    if (!res.ok) this.fail(res.error);
  }

  async close(): Promise<void> {
    const res = await this.emit('draw:close', {});
    if (!res.ok) this.fail(res.error);
  }

  sendCursor(x: number, y: number, color: string, gone = false): void {
    this.socket.volatile.emit('draw:cursor', { by: this.myId, canvas: this.focus, x, y, color, gone } satisfies StudioCursor);
  }

  /** Upload an image (picture or flattened layer); returns its asset id. */
  upload(blob: Blob): Promise<string> {
    return uploadAsset(this.roomId, blob);
  }
}

/** Upload an image to the room's studio store; returns its asset id. */
export async function uploadAsset(roomId: string, blob: Blob): Promise<string> {
  const token = loadSession(roomId)?.playerToken ?? '';
  const res = await fetch(`/api/studio/${encodeURIComponent(roomId)}/asset`, {
    method: 'POST',
    headers: { 'content-type': blob.type || 'image/png', 'x-player-token': token },
    body: blob,
  });
  const json = (await res.json().catch(() => ({}))) as { id?: string; error?: string };
  if (!res.ok || !json.id) throw new Error(json.error ?? `upload failed (${res.status})`);
  return json.id;
}

/** Open the studio (host, from the lobby). */
export function openStudio(socket: Socket, setup?: StudioSetup): Promise<Res> {
  return new Promise((resolve) => {
    socket.timeout(15_000).emit('draw:open', { setup }, (err: Error | null, res: Res) =>
      resolve(err ? { ok: false, error: 'the server did not answer' } : res));
  });
}
