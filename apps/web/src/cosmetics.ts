/**
 * Cosmetic sku → visual style descriptors. Pure and shared by the DOM table,
 * the 3D scene, and the shop page so every renderer agrees on what a sku
 * looks like. Unknown skus degrade to the defaults.
 */

export interface BackStyle {
  /** Base colour of the card back. */
  bg: string;
  /** Pattern/border accent colour. */
  accent: string;
  /** Fainter colour for the lattice pattern. */
  pattern: string;
  /** Center glyph on the back. */
  glyph: string;
  /** true = light glyph, false = dark glyph. */
  light: boolean;
}

export interface FeltStyle {
  /** Center colour of the radial gradient. */
  center: string;
  /** Edge colour of the radial gradient. */
  edge: string;
  /** Rail (table rim) colour. */
  rail: string;
  /** CSS class suffix for DOM rendering. */
  domClass: string;
}

const DEFAULT_BACK: BackStyle = {
  bg: '#25321f',
  accent: 'rgba(255, 220, 160, 0.4)',
  pattern: 'rgba(255, 220, 160, 0.10)',
  glyph: '✦',
  light: true,
};

const DEFAULT_FELT: FeltStyle = {
  center: '#2c5a35',
  edge: '#1a3a22',
  rail: '#3a2b20',
  domClass: 'emerald',
};

const BACKS: Record<string, BackStyle> = {
  'back-classic': DEFAULT_BACK,
  'back-verdant': { bg: '#1e3d2a', accent: 'rgba(140, 220, 160, 0.45)', pattern: 'rgba(140, 220, 160, 0.12)', glyph: '❦', light: true },
  'back-midnight': { bg: '#1b2140', accent: 'rgba(170, 190, 255, 0.45)', pattern: 'rgba(170, 190, 255, 0.12)', glyph: '✧', light: true },
  'back-sunburst': { bg: '#4a2c12', accent: 'rgba(255, 200, 100, 0.55)', pattern: 'rgba(255, 200, 100, 0.14)', glyph: '☀', light: true },
  'back-royale': { bg: '#3d1420', accent: 'rgba(255, 215, 130, 0.6)', pattern: 'rgba(255, 215, 130, 0.15)', glyph: '♛', light: true },
};

const FELTS: Record<string, FeltStyle> = {
  'felt-emerald': DEFAULT_FELT,
  'felt-slate': { center: '#3c4550', edge: '#242b33', rail: '#1c2128', domClass: 'slate' },
  'felt-azure': { center: '#1f4a66', edge: '#12293a', rail: '#0e1f2c', domClass: 'azure' },
  'felt-crimson': { center: '#5e1f26', edge: '#3a1218', rail: '#2a0d11', domClass: 'crimson' },
};

export function backStyle(sku: string | undefined | null): BackStyle {
  return (sku && BACKS[sku]) || DEFAULT_BACK;
}

export function feltStyle(sku: string | undefined | null): FeltStyle {
  return (sku && FELTS[sku]) || DEFAULT_FELT;
}

export function priceLabel(priceCents: number): string {
  if (priceCents === 0) return 'Free';
  return `$${(priceCents / 100).toFixed(2)}`;
}
