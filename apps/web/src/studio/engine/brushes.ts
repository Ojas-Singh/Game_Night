/**
 * The brush library. A brush is a tip stamped along the stroke; these
 * settings decide the tip's shape, how it spreads, and how pen pressure and
 * tilt change it. Every brush renders the same on every client given the
 * stroke's seed.
 */

export type TipShape =
  | 'round'      // hard round
  | 'soft'       // gaussian falloff
  | 'pencil'     // small hard core with a rough edge
  | 'chalk'      // irregular blob
  | 'bristle'    // a bunch of hairs
  | 'flat'       // chisel / calligraphy nib
  | 'wash'       // watercolour: pale centre, darker rim
  | 'spatter'    // a scatter of droplets
  | 'star'
  | 'heart'
  | 'leaf'
  | 'dot';

export type BrushCategory = 'Sketch' | 'Ink' | 'Paint' | 'Texture' | 'Airbrush' | 'Fun';
export const BRUSH_CATEGORIES: BrushCategory[] = ['Sketch', 'Ink', 'Paint', 'Texture', 'Airbrush', 'Fun'];

export interface Brush {
  id: string;
  name: string;
  category: BrushCategory;
  tip: TipShape;
  /** Tip hardness for soft tips (0 soft .. 1 hard). */
  hardness: number;
  /** Stamp spacing as a fraction of the stamp diameter. */
  spacing: number;
  /** Alpha of each stamp (the stroke's opacity caps the total). */
  flow: number;
  /** How much pressure shrinks the size (0 none .. 1 to nothing). */
  sizePressure: number;
  /** How much pressure lowers the flow. */
  flowPressure: number;
  /** Smallest size, as a fraction of the brush size. */
  minSize: number;
  /** Tip roundness (1 circle, 0.2 thin ellipse). */
  roundness: number;
  /** Tip angle: follows the stroke, the pen's tilt, is fixed, or random. */
  angle: 'direction' | 'tilt' | 'fixed' | 'random';
  /** Fixed angle in degrees (also the offset for the others). */
  angleDeg: number;
  /** Random variation per stamp. */
  jitterSize: number;
  jitterAngle: number;
  /** Sideways scatter as a fraction of the size. */
  scatter: number;
  jitterOpacity: number;
  /** Hue/lightness variation (0..1) for colourful brushes. */
  jitterHue: number;
  jitterLight: number;
  /** Paper grain: strength 0..1 and scale. */
  grain: number;
  grainScale: number;
  /** Tilting the pen widens the tip (pencil shading). */
  tiltShade: number;
  /** Start taper length in multiples of the size. */
  taper: number;
  /** Watercolour edge darkening at the end of the stroke (0..1). */
  wetEdge: number;
  /** Extra smoothing of the pen path (0..1). */
  streamline: number;
  /** Starting size and opacity when first picked. */
  defaultSize: number;
  defaultOpacity: number;
  /** Copies of the tip per stamp (spray). */
  count: number;
  /** Keep the tip's own colours (stamps with multicolour). */
  rainbow?: boolean;
}

const base: Omit<Brush, 'id' | 'name' | 'category' | 'tip'> = {
  hardness: 1,
  spacing: 0.08,
  flow: 1,
  sizePressure: 0.6,
  flowPressure: 0,
  minSize: 0.05,
  roundness: 1,
  angle: 'fixed',
  angleDeg: 0,
  jitterSize: 0,
  jitterAngle: 0,
  scatter: 0,
  jitterOpacity: 0,
  jitterHue: 0,
  jitterLight: 0,
  grain: 0,
  grainScale: 1,
  tiltShade: 0,
  taper: 0,
  wetEdge: 0,
  streamline: 0.25,
  defaultSize: 12,
  defaultOpacity: 1,
  count: 1,
};

function b(id: string, name: string, category: BrushCategory, tip: TipShape, o: Partial<Brush>): Brush {
  return { ...base, id, name, category, tip, ...o };
}

export const BRUSHES: Brush[] = [
  // --- Sketch
  b('hb-pencil', 'HB Pencil', 'Sketch', 'pencil', {
    spacing: 0.12, flow: 0.55, sizePressure: 0.35, flowPressure: 0.8, grain: 0.75, grainScale: 0.8,
    tiltShade: 2.2, defaultSize: 4, streamline: 0.1,
  }),
  b('6b-pencil', '6B Pencil', 'Sketch', 'pencil', {
    spacing: 0.1, flow: 0.8, sizePressure: 0.45, flowPressure: 0.6, grain: 0.85, grainScale: 1.1,
    tiltShade: 3, defaultSize: 9, streamline: 0.1, jitterAngle: 1,
  }),
  b('mechanical', 'Mechanical', 'Sketch', 'round', {
    spacing: 0.1, flow: 0.9, sizePressure: 0.2, flowPressure: 0.5, grain: 0.35, defaultSize: 2.5, streamline: 0.15,
  }),
  b('charcoal', 'Charcoal', 'Sketch', 'chalk', {
    spacing: 0.1, flow: 0.7, sizePressure: 0.4, flowPressure: 0.5, grain: 0.9, grainScale: 1.6, jitterAngle: 1,
    tiltShade: 1.5, defaultSize: 22, streamline: 0.05,
  }),
  // --- Ink
  b('ink-pen', 'Ink Pen', 'Ink', 'round', {
    spacing: 0.05, sizePressure: 0.85, minSize: 0.08, taper: 1.2, streamline: 0.45, defaultSize: 8,
  }),
  b('fineliner', 'Fineliner', 'Ink', 'round', {
    spacing: 0.05, sizePressure: 0.1, streamline: 0.4, defaultSize: 4,
  }),
  b('brush-pen', 'Brush Pen', 'Ink', 'round', {
    spacing: 0.04, sizePressure: 0.95, minSize: 0.03, roundness: 0.85, angle: 'direction', taper: 2.5,
    streamline: 0.5, defaultSize: 18,
  }),
  b('calligraphy', 'Calligraphy', 'Ink', 'flat', {
    spacing: 0.03, sizePressure: 0.35, roundness: 0.18, angle: 'fixed', angleDeg: 45, streamline: 0.45, defaultSize: 20,
  }),
  b('marker', 'Marker', 'Ink', 'flat', {
    spacing: 0.04, sizePressure: 0, roundness: 0.55, angle: 'fixed', angleDeg: 30, streamline: 0.3,
    defaultSize: 22, defaultOpacity: 0.7, hardness: 0.85,
  }),
  b('dry-ink', 'Dry Ink', 'Ink', 'round', {
    spacing: 0.06, sizePressure: 0.7, flowPressure: 0.3, grain: 0.55, grainScale: 0.7, taper: 1, streamline: 0.35,
    defaultSize: 10,
  }),
  // --- Paint
  b('round-brush', 'Round Brush', 'Paint', 'soft', {
    hardness: 0.7, spacing: 0.05, flow: 0.55, sizePressure: 0.6, flowPressure: 0.4, defaultSize: 30, streamline: 0.3,
  }),
  b('gouache', 'Gouache', 'Paint', 'bristle', {
    spacing: 0.04, flow: 0.8, sizePressure: 0.4, flowPressure: 0.2, angle: 'direction', angleDeg: 90, roundness: 0.9,
    grain: 0.25, defaultSize: 36, streamline: 0.25,
  }),
  b('oil', 'Oil Paint', 'Paint', 'bristle', {
    spacing: 0.035, flow: 0.95, sizePressure: 0.35, angle: 'direction', angleDeg: 90, roundness: 0.75,
    jitterLight: 0.04, defaultSize: 44, streamline: 0.2,
  }),
  b('watercolor', 'Watercolour', 'Paint', 'wash', {
    hardness: 0.3, spacing: 0.06, flow: 0.16, sizePressure: 0.5, flowPressure: 0.4, jitterSize: 0.2, scatter: 0.06,
    jitterHue: 0.02, grain: 0.35, grainScale: 2, wetEdge: 0.75, defaultSize: 60, defaultOpacity: 0.85, streamline: 0.2,
  }),
  b('wet-wash', 'Wet Wash', 'Paint', 'soft', {
    hardness: 0.1, spacing: 0.08, flow: 0.08, sizePressure: 0.3, flowPressure: 0.5, jitterSize: 0.3, scatter: 0.12,
    grain: 0.25, grainScale: 2.4, wetEdge: 0.5, defaultSize: 120, defaultOpacity: 0.6, streamline: 0.15,
  }),
  b('flat-brush', 'Flat Brush', 'Paint', 'bristle', {
    spacing: 0.03, flow: 0.85, sizePressure: 0.2, roundness: 0.35, angle: 'direction', angleDeg: 90,
    defaultSize: 40, streamline: 0.3,
  }),
  // --- Texture
  b('crayon', 'Crayon', 'Texture', 'chalk', {
    spacing: 0.08, flow: 0.9, sizePressure: 0.3, flowPressure: 0.4, grain: 0.95, grainScale: 0.9, jitterAngle: 1,
    defaultSize: 16, streamline: 0.15,
  }),
  b('pastel', 'Soft Pastel', 'Texture', 'chalk', {
    spacing: 0.09, flow: 0.6, sizePressure: 0.4, flowPressure: 0.6, grain: 0.8, grainScale: 2, jitterAngle: 1,
    jitterSize: 0.15, defaultSize: 40, streamline: 0.1,
  }),
  b('sponge', 'Sponge', 'Texture', 'spatter', {
    spacing: 0.35, flow: 0.5, sizePressure: 0.3, jitterAngle: 1, jitterSize: 0.3, grain: 0.6, grainScale: 2.5,
    defaultSize: 70, count: 1, streamline: 0,
  }),
  b('stipple', 'Stipple', 'Texture', 'dot', {
    spacing: 0.6, flow: 1, sizePressure: 0.2, scatter: 1.4, jitterSize: 0.6, count: 4, defaultSize: 6, streamline: 0,
  }),
  b('hatch', 'Hatching', 'Texture', 'flat', {
    spacing: 0.9, flow: 0.8, sizePressure: 0.3, roundness: 0.06, angle: 'fixed', angleDeg: 50, scatter: 0.3,
    jitterSize: 0.2, defaultSize: 26, streamline: 0,
  }),
  // --- Airbrush
  b('soft-air', 'Soft Airbrush', 'Airbrush', 'soft', {
    hardness: 0, spacing: 0.06, flow: 0.06, sizePressure: 0.2, flowPressure: 0.9, defaultSize: 120,
    defaultOpacity: 0.8, streamline: 0.1,
  }),
  b('hard-air', 'Hard Airbrush', 'Airbrush', 'soft', {
    hardness: 0.75, spacing: 0.05, flow: 0.25, sizePressure: 0.2, flowPressure: 0.8, defaultSize: 50, streamline: 0.15,
  }),
  b('spray', 'Spray Paint', 'Airbrush', 'dot', {
    spacing: 0.05, flow: 0.9, sizePressure: 0.1, flowPressure: 0.5, scatter: 1, jitterSize: 0.7, count: 6,
    defaultSize: 3, streamline: 0,
  }),
  b('glow', 'Glow', 'Airbrush', 'soft', {
    hardness: 0.2, spacing: 0.05, flow: 0.12, sizePressure: 0.5, flowPressure: 0.5, jitterLight: 0.08,
    defaultSize: 40, streamline: 0.3,
  }),
  // --- Fun
  b('stars', 'Stars', 'Fun', 'star', {
    spacing: 1.4, sizePressure: 0.5, jitterSize: 0.5, jitterAngle: 1, scatter: 0.8, jitterHue: 0.12,
    defaultSize: 28, streamline: 0,
  }),
  b('hearts', 'Hearts', 'Fun', 'heart', {
    spacing: 1.5, sizePressure: 0.5, jitterSize: 0.4, jitterAngle: 0.3, scatter: 0.6, jitterHue: 0.05,
    defaultSize: 26, streamline: 0,
  }),
  b('confetti', 'Confetti', 'Fun', 'dot', {
    spacing: 0.4, sizePressure: 0.3, jitterSize: 0.6, scatter: 2.2, jitterHue: 0.5, jitterLight: 0.15,
    count: 3, defaultSize: 9, streamline: 0,
  }),
  b('leaves', 'Leaves', 'Fun', 'leaf', {
    spacing: 1.1, sizePressure: 0.4, jitterSize: 0.4, jitterAngle: 0.6, angle: 'direction', angleDeg: 90,
    scatter: 0.5, jitterHue: 0.06, jitterLight: 0.12, defaultSize: 30, streamline: 0,
  }),
  b('rainbow', 'Rainbow', 'Fun', 'round', {
    spacing: 0.04, sizePressure: 0.4, rainbow: true, defaultSize: 24, streamline: 0.35,
  }),
];

export const ERASERS: string[] = ['soft-air', 'round-brush', 'ink-pen', 'hb-pencil', 'charcoal', 'hard-air', 'fineliner'];

const BY_ID = new Map(BRUSHES.map((x) => [x.id, x]));

export function brushById(id: string): Brush {
  return BY_ID.get(id) ?? BRUSHES[0]!;
}
