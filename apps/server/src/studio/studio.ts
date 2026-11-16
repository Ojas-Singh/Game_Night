/**
 * A room's drawing studio: settings, canvases and the numbered operation log.
 *
 * The server checks and orders operations; it never renders them. Clients
 * replay the log in sequence order, so they all end with the same picture.
 */

import {
  LAYER_BLENDS, PAPERS, SHARED_CANVAS, STUDIO_LIMITS, STUDIO_MODES, defaultLayers,
  type DrawOp, type DrawOpBody, type LayerEdit, type StudioBake, type StudioCanvas, type StudioImage,
  type StudioLayer, type StudioSetup, type StudioSnapshot, type StudioState, type StrokeSymmetry,
} from '@game-night/shared';

export class StudioError extends Error {}

const HEX = /^#[0-9a-f]{6}$/i;
const ID = /^[A-Za-z0-9_-]{1,40}$/;

export class Studio {
  state: StudioState;
  ops: DrawOp[] = [];
  private seq = 0;
  /** Set while a client has been asked to flatten, so it is asked once. */
  bakePending: { canvas: string; upTo: number; askedAt: number } | null = null;

  constructor(init?: Partial<StudioState>) {
    this.state = {
      open: false,
      mode: 'together',
      width: 1600,
      height: 1200,
      paper: 'white',
      image: null,
      hidden: false,
      canvases: [{ id: SHARED_CANVAS, ownerId: null, layers: defaultLayers() }],
      epoch: 0,
      ...init,
    };
  }

  static fromSnapshot(snap: StudioSnapshot & { seq?: number }): Studio {
    const studio = new Studio(snap.state);
    studio.ops = snap.ops ?? [];
    studio.seq = snap.seq ?? studio.ops.reduce((m, op) => Math.max(m, op.seq), 0);
    return studio;
  }

  snapshot(): StudioSnapshot & { seq: number } {
    return { state: this.state, ops: this.ops, seq: this.seq };
  }

  get lastSeq(): number { return this.seq; }

  // ---------------------------------------------------------------------
  // Settings
  // ---------------------------------------------------------------------

  /** Host changes the mode, paper, size or picture. Size or mode changes start a fresh canvas. */
  setup(patch: StudioSetup): { wiped: boolean } {
    const s = this.state;
    let wiped = false;
    if (patch.mode !== undefined) {
      if (!STUDIO_MODES.includes(patch.mode)) throw new StudioError('unknown mode');
      if (patch.mode !== s.mode) {
        const sharedBefore = s.mode !== 'side-by-side';
        const sharedAfter = patch.mode !== 'side-by-side';
        s.mode = patch.mode;
        if (sharedBefore !== sharedAfter) wiped = true;
      }
    }
    if (patch.paper !== undefined) {
      if (!PAPERS.includes(patch.paper)) throw new StudioError('unknown paper');
      s.paper = patch.paper;
    }
    if (patch.width !== undefined || patch.height !== undefined) {
      const w = clampSide(patch.width ?? s.width);
      const h = clampSide(patch.height ?? s.height);
      if (w !== s.width || h !== s.height) {
        s.width = w;
        s.height = h;
        wiped = true;
      }
    }
    if (patch.image !== undefined) s.image = patch.image === null ? null : cleanImage(patch.image);
    if (patch.hidden !== undefined) s.hidden = !!patch.hidden;
    if (s.mode === 'colouring' && s.image) s.image.placement = 'lines';
    if (wiped) this.wipe();
    return { wiped };
  }

  /** Start every canvas again from blank layers. */
  wipe(): void {
    const s = this.state;
    s.epoch += 1;
    s.canvases = s.mode === 'side-by-side' ? [] : [{ id: SHARED_CANVAS, ownerId: null, layers: defaultLayers() }];
    this.ops = [];
    this.bakePending = null;
  }

  /** The canvas a player draws on, created on first use in side-by-side mode. */
  canvasFor(playerId: string): StudioCanvas {
    const s = this.state;
    if (s.mode !== 'side-by-side') return s.canvases.find((c) => c.id === SHARED_CANVAS)!;
    let canvas = s.canvases.find((c) => c.ownerId === playerId);
    if (!canvas) {
      canvas = { id: `c-${playerId.slice(0, 8)}`, ownerId: playerId, layers: defaultLayers() };
      s.canvases.push(canvas);
    }
    return canvas;
  }

  private canvas(id: string): StudioCanvas {
    const c = this.state.canvases.find((x) => x.id === id);
    if (!c) throw new StudioError('no such canvas');
    return c;
  }

  /** Shared canvases are open to all; your own canvas is yours alone. */
  private assertCanDraw(playerId: string, canvas: StudioCanvas): void {
    if (canvas.ownerId && canvas.ownerId !== playerId) throw new StudioError('that canvas belongs to someone else');
  }

  // ---------------------------------------------------------------------
  // Layers
  // ---------------------------------------------------------------------

  editLayers(playerId: string, edit: LayerEdit): void {
    const canvas = this.canvas(String(edit.canvas));
    this.assertCanDraw(playerId, canvas);
    const layers = canvas.layers;
    switch (edit.kind) {
      case 'add': {
        if (layers.length >= STUDIO_LIMITS.maxLayers) throw new StudioError('that is the most layers a canvas can have');
        const l = edit.layer;
        if (!l || !ID.test(String(l.id)) || layers.some((x) => x.id === l.id)) throw new StudioError('bad layer');
        const layer: StudioLayer = {
          id: l.id, name: cleanName(l.name) ?? `Layer ${layers.length + 1}`, visible: true,
          opacity: 1, blend: 'normal', base: null,
        };
        layers.splice(clampIndex(edit.index, layers.length), 0, layer);
        return;
      }
      case 'update': {
        const layer = layers.find((x) => x.id === edit.layer);
        if (!layer) throw new StudioError('no such layer');
        const p = edit.patch ?? {};
        if (p.name !== undefined) layer.name = cleanName(p.name) ?? layer.name;
        if (p.visible !== undefined) layer.visible = !!p.visible;
        if (p.opacity !== undefined) layer.opacity = clamp01(p.opacity);
        if (p.blend !== undefined && LAYER_BLENDS.includes(p.blend)) layer.blend = p.blend;
        return;
      }
      case 'remove': {
        if (layers.length <= 1) throw new StudioError('a canvas keeps at least one layer');
        const i = layers.findIndex((x) => x.id === edit.layer);
        if (i < 0) throw new StudioError('no such layer');
        layers.splice(i, 1);
        this.ops = this.ops.filter((op) => !(op.canvas === canvas.id && op.layer === edit.layer));
        return;
      }
      case 'move': {
        const i = layers.findIndex((x) => x.id === edit.layer);
        if (i < 0) throw new StudioError('no such layer');
        const [layer] = layers.splice(i, 1);
        layers.splice(clampIndex(edit.index, layers.length), 0, layer!);
        return;
      }
      default:
        throw new StudioError('unknown layer edit');
    }
  }

  // ---------------------------------------------------------------------
  // Operations
  // ---------------------------------------------------------------------

  /** Check, number and store one drawing operation. */
  addOp(playerId: string, raw: { id: unknown; canvas: unknown; layer: unknown; body: unknown }): DrawOp {
    if (!this.state.open) throw new StudioError('the studio is closed');
    const id = String(raw.id ?? '');
    if (!ID.test(id)) throw new StudioError('bad op id');
    if (this.ops.some((op) => op.id === id)) throw new StudioError('duplicate op');
    const canvas = this.canvas(String(raw.canvas));
    this.assertCanDraw(playerId, canvas);
    const layer = canvas.layers.find((l) => l.id === raw.layer);
    if (!layer) throw new StudioError('no such layer');
    const body = cleanBody(raw.body, this.state.width, this.state.height);
    const op = { ...body, seq: ++this.seq, id, by: playerId, canvas: canvas.id, layer: layer.id } as DrawOp;
    this.ops.push(op);
    return op;
  }

  /** Undo or redo one of your own operations. */
  toggle(playerId: string, opId: string, undone: boolean): DrawOp {
    const op = this.ops.find((o) => o.id === opId);
    if (!op) throw new StudioError('that stroke is gone');
    if (op.by !== playerId) throw new StudioError('you can only undo your own strokes');
    op.undone = undone || undefined;
    return op;
  }

  /** A canvas whose log is long enough to flatten, and up to which op. */
  bakeCandidate(now = Date.now()): { canvas: string; upTo: number } | null {
    if (this.bakePending && now - this.bakePending.askedAt < 60_000) return null;
    const counts = new Map<string, DrawOp[]>();
    for (const op of this.ops) {
      const list = counts.get(op.canvas) ?? [];
      list.push(op);
      counts.set(op.canvas, list);
    }
    for (const [canvas, list] of counts) {
      if (list.length < STUDIO_LIMITS.bakeAt) continue;
      const upTo = list[list.length - STUDIO_LIMITS.keepAfterBake - 1]!.seq;
      this.bakePending = { canvas, upTo, askedAt: now };
      return { canvas, upTo };
    }
    return null;
  }

  /** Replace every op up to `upTo` on a canvas by the flattened layers a client sent. */
  bake(bake: StudioBake, assetExists: (id: string) => boolean): void {
    const canvas = this.canvas(String(bake.canvas));
    const upTo = Number(bake.upTo);
    if (!Number.isInteger(upTo) || upTo < 0 || upTo > this.seq) throw new StudioError('bad bake');
    for (const layer of canvas.layers) {
      const asset = bake.layers?.[layer.id];
      if (typeof asset !== 'string' || !assetExists(asset)) throw new StudioError(`bake is missing layer ${layer.name}`);
    }
    for (const layer of canvas.layers) layer.base = bake.layers[layer.id]!;
    this.ops = this.ops.filter((op) => op.canvas !== canvas.id || op.seq > upTo);
    this.bakePending = null;
  }

  /** Asset ids the studio still refers to (pictures and layer bases). */
  assetsInUse(): Set<string> {
    const ids = new Set<string>();
    if (this.state.image) ids.add(this.state.image.asset);
    for (const c of this.state.canvases) for (const l of c.layers) if (l.base) ids.add(l.base);
    return ids;
  }
}

// -----------------------------------------------------------------------
// Validation
// -----------------------------------------------------------------------

function clamp01(v: unknown): number {
  const n = Number(v);
  return Number.isFinite(n) ? Math.min(1, Math.max(0, n)) : 1;
}

function clampSide(v: unknown): number {
  const n = Math.round(Number(v));
  if (!Number.isFinite(n)) throw new StudioError('bad canvas size');
  return Math.min(STUDIO_LIMITS.maxSide, Math.max(STUDIO_LIMITS.minSide, n));
}

function clampIndex(v: unknown, len: number): number {
  const n = Math.round(Number(v));
  return Number.isFinite(n) ? Math.min(len, Math.max(0, n)) : len;
}

function cleanName(v: unknown): string | null {
  if (typeof v !== 'string') return null;
  const s = v.trim().replace(/\s+/g, ' ').slice(0, 32);
  return s || null;
}

function cleanImage(img: StudioImage): StudioImage {
  if (!img || typeof img.asset !== 'string' || !ID.test(img.asset)) throw new StudioError('bad picture');
  return {
    asset: img.asset,
    width: clampSide(img.width),
    height: clampSide(img.height),
    placement: img.placement === 'trace' ? 'trace' : 'lines',
    opacity: clamp01(img.opacity ?? 1),
  };
}

function cleanColor(v: unknown): string {
  if (typeof v !== 'string' || !HEX.test(v)) throw new StudioError('bad colour');
  return v.toLowerCase();
}

function cleanSym(v: unknown, w: number, h: number): StrokeSymmetry | undefined {
  if (!v || typeof v !== 'object') return undefined;
  const s = v as Record<string, unknown>;
  const kinds = ['vertical', 'horizontal', 'quadrant', 'radial'] as const;
  const kind = kinds.find((k) => k === s.kind);
  if (!kind) return undefined;
  const count = Math.round(Number(s.count));
  return {
    kind,
    count: Number.isFinite(count) ? Math.min(16, Math.max(2, count)) : 6,
    cx: Math.min(w, Math.max(0, Number(s.cx) || w / 2)),
    cy: Math.min(h, Math.max(0, Number(s.cy) || h / 2)),
  };
}

function finiteArray(v: unknown, max: number): number[] {
  if (!Array.isArray(v) || v.length > max) throw new StudioError('too much data in one op');
  for (const n of v) if (typeof n !== 'number' || !Number.isFinite(n)) throw new StudioError('bad numbers');
  return v as number[];
}

function cleanBody(raw: unknown, w: number, h: number): DrawOpBody {
  if (!raw || typeof raw !== 'object') throw new StudioError('bad op');
  const b = raw as Record<string, unknown>;
  if (b.kind === 'clear') return { kind: 'clear' };
  if (b.kind === 'stroke') {
    const points = finiteArray(b.points, STUDIO_LIMITS.maxStrokeValues);
    if (points.length < 5 || points.length % 5 !== 0) throw new StudioError('bad stroke');
    const size = Number(b.size);
    if (!(size > 0 && size <= STUDIO_LIMITS.maxBrushSize)) throw new StudioError('bad brush size');
    if (typeof b.brush !== 'string' || !ID.test(b.brush)) throw new StudioError('bad brush');
    return {
      kind: 'stroke',
      brush: b.brush,
      color: cleanColor(b.color),
      size,
      opacity: clamp01(b.opacity),
      erase: !!b.erase,
      seed: (Number(b.seed) >>> 0) || 1,
      points,
      sym: cleanSym(b.sym, w, h),
    };
  }
  if (b.kind === 'fill') {
    const x = Math.round(Number(b.x)), y = Math.round(Number(b.y));
    const bw = Math.round(Number(b.w)), bh = Math.round(Number(b.h));
    if (![x, y, bw, bh].every(Number.isFinite) || x < 0 || y < 0 || bw < 1 || bh < 1 || x + bw > w || y + bh > h) {
      throw new StudioError('bad fill');
    }
    const runs = finiteArray(b.runs, STUDIO_LIMITS.maxFillRuns);
    let total = 0;
    for (const r of runs) {
      if (!Number.isInteger(r) || r < 0) throw new StudioError('bad fill');
      total += r;
    }
    if (total > bw * bh) throw new StudioError('bad fill');
    return { kind: 'fill', color: cleanColor(b.color), opacity: clamp01(b.opacity), x, y, w: bw, h: bh, runs };
  }
  throw new StudioError('unknown op');
}
