/**
 * The drawing studio's wire format, shared by the server and the web client.
 *
 * A canvas is a stack of layers. Everything drawn on a layer is an operation
 * (a stroke, a fill, a clear) that the server numbers in arrival order, so
 * every client applies the same operations in the same order. Clients render
 * the operations themselves; the server never touches pixels. When the log
 * grows long, a client flattens the older operations into one image per layer
 * (a "bake") and the server drops them.
 */

/** How the room uses the studio. */
export type StudioMode =
  /** One canvas everybody draws on. */
  | 'together'
  /** One canvas with the host's picture as line art on top; fills follow its lines. */
  | 'colouring'
  /** The same picture for everybody, one canvas each. */
  | 'side-by-side';

export const STUDIO_MODES: StudioMode[] = ['together', 'colouring', 'side-by-side'];

/** Where the host's picture sits on a canvas. */
export type ImagePlacement =
  /** Above the paint, multiplied: white vanishes, the lines stay crisp. */
  | 'lines'
  /** Under the paint, faded, for tracing. */
  | 'trace';

export type PaperId = 'white' | 'cream' | 'watercolor' | 'kraft' | 'canvas' | 'dots' | 'grid' | 'night';
export const PAPERS: PaperId[] = ['white', 'cream', 'watercolor', 'kraft', 'canvas', 'dots', 'grid', 'night'];

export type LayerBlend = 'normal' | 'multiply' | 'screen' | 'overlay' | 'lighten' | 'darken' | 'color';
export const LAYER_BLENDS: LayerBlend[] = ['normal', 'multiply', 'screen', 'overlay', 'lighten', 'darken', 'color'];

export interface StudioLayer {
  id: string;
  name: string;
  visible: boolean;
  /** 0..1 */
  opacity: number;
  blend: LayerBlend;
  /** Asset id of the flattened image this layer starts from (after a bake). */
  base: string | null;
}

export interface StudioCanvas {
  id: string;
  /** Player whose canvas this is in side-by-side mode; null for a shared canvas. */
  ownerId: string | null;
  /** Bottom first. */
  layers: StudioLayer[];
}

export interface StudioImage {
  /** Asset id; fetch it from /api/studio/<room>/asset/<id>. */
  asset: string;
  width: number;
  height: number;
  placement: ImagePlacement;
  /** 0..1 */
  opacity: number;
}

/** Room-wide studio settings (everything but the operation log). */
export interface StudioState {
  open: boolean;
  mode: StudioMode;
  width: number;
  height: number;
  paper: PaperId;
  image: StudioImage | null;
  /** Side-by-side: hide other people's canvases until the host reveals them. */
  hidden: boolean;
  canvases: StudioCanvas[];
  /** Bumps whenever the canvas is wiped and started again. */
  epoch: number;
}

/** Symmetry guide applied to a stroke when it is drawn. */
export interface StrokeSymmetry {
  kind: 'vertical' | 'horizontal' | 'quadrant' | 'radial';
  /** Copies for radial symmetry (2..16). */
  count: number;
  cx: number;
  cy: number;
}

export interface StrokeOp {
  kind: 'stroke';
  brush: string;
  /** #rrggbb */
  color: string;
  /** Diameter in canvas pixels at full pressure. */
  size: number;
  /** 0..1 */
  opacity: number;
  /** Erase instead of paint. */
  erase: boolean;
  /** Seed for the brush's jitter, so every client draws the same stroke. */
  seed: number;
  /** Flattened points: x, y, pressure (0..1), tiltX, tiltY (degrees) per point. */
  points: number[];
  sym?: StrokeSymmetry;
}

export interface FillOp {
  kind: 'fill';
  color: string;
  opacity: number;
  /** Bounding box of the filled region. */
  x: number;
  y: number;
  w: number;
  h: number;
  /** Row-major run lengths over the box, starting with an empty run. */
  runs: number[];
}

export interface ClearOp {
  kind: 'clear';
}

export type DrawOpBody = StrokeOp | FillOp | ClearOp;

/** A numbered operation as the server keeps and sends it. */
export type DrawOp = DrawOpBody & {
  /** Server order. */
  seq: number;
  /** Client-made id, unique per op. */
  id: string;
  /** Player id. */
  by: string;
  canvas: string;
  layer: string;
  /** Undone ops stay in the log (so they can be redone) but are not drawn. */
  undone?: boolean;
};

/** Everything a client needs to show the studio from scratch. */
export interface StudioSnapshot {
  state: StudioState;
  ops: DrawOp[];
}

/** An in-progress stroke, relayed to others while it is drawn (not stored). */
export interface LiveStroke {
  id: string;
  by: string;
  canvas: string;
  layer: string;
  /** Present on the first chunk only. */
  head?: Omit<StrokeOp, 'kind' | 'points'>;
  /** New points since the previous chunk. */
  points: number[];
  /** The stroke ended without being committed (cancelled). */
  cancel?: boolean;
}

export interface StudioCursor {
  by: string;
  canvas: string;
  x: number;
  y: number;
  color: string;
  /** Pointer left the canvas. */
  gone?: boolean;
}

export type LayerEdit =
  | { kind: 'add'; canvas: string; layer: StudioLayer; index: number }
  | { kind: 'update'; canvas: string; layer: string; patch: Partial<Pick<StudioLayer, 'name' | 'visible' | 'opacity' | 'blend'>> }
  | { kind: 'remove'; canvas: string; layer: string }
  | { kind: 'move'; canvas: string; layer: string; index: number };

export interface StudioSetup {
  mode?: StudioMode;
  paper?: PaperId;
  width?: number;
  height?: number;
  image?: StudioImage | null;
  hidden?: boolean;
}

/** Flattened layers a client sends to replace every op up to `upTo`. */
export interface StudioBake {
  upTo: number;
  canvas: string;
  /** layer id -> asset id (uploaded first over HTTP). */
  layers: Record<string, string>;
}

export const STUDIO_LIMITS = {
  minSide: 256,
  maxSide: 4096,
  maxLayers: 12,
  /** Values (5 per point) in one stroke. */
  maxStrokeValues: 5 * 12_000,
  maxFillRuns: 600_000,
  maxBrushSize: 600,
  /** Ops kept before a client is asked to flatten the older ones. */
  bakeAt: 1200,
  /** Ops left unbaked (so recent work stays undoable). */
  keepAfterBake: 300,
  /** Upload size for pictures and flattened layers. */
  maxAssetBytes: 12 * 1024 * 1024,
} as const;

export const SHARED_CANVAS = 'main';

/** Default layers for a new canvas. */
export function defaultLayers(): StudioLayer[] {
  return [
    { id: 'paint', name: 'Paint', visible: true, opacity: 1, blend: 'normal', base: null },
    { id: 'ink', name: 'Ink', visible: true, opacity: 1, blend: 'normal', base: null },
  ];
}
