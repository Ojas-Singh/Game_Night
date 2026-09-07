/**
 * Card face/back textures, generated on a 2D canvas at boot — zero binary
 * assets, crisp at any resolution, and cosmetic card backs (Phase 4) become a
 * texture swap. The rank/suit→label/colour mapping is pure and unit-tested.
 */

import type { Card, Rank, Suit } from '@shared/cards.js';

export const RANK_LABELS: Record<number, string> = {
  1: 'A',
  11: 'J',
  12: 'Q',
  13: 'K',
};

export function rankLabel(rank: number): string {
  return RANK_LABELS[rank] ?? String(rank);
}

export function isRedSuit(suit: string): boolean {
  return suit === 'hearts' || suit === 'diamonds';
}

export const SUIT_GLYPHS: Record<string, string> = {
  spades: '♠',
  hearts: '♥',
  diamonds: '♦',
  clubs: '♣',
};

export function suitGlyph(suit: string): string {
  return SUIT_GLYPHS[suit] ?? '';
}

export interface FaceSpec {
  label: string;
  glyph: string;
  red: boolean;
}

/** Pure descriptor of a card face — the canvas renderer just draws this. */
export function cardFaceSpec(card: Pick<Card, 'rank' | 'suit'>): FaceSpec {
  return { label: rankLabel(card.rank), glyph: suitGlyph(card.suit), red: isRedSuit(card.suit) };
}

const FACE_CACHE = new Map<string, HTMLCanvasElement>();
const BACK_CACHE = new Map<string, HTMLCanvasElement>();

export function faceTextureKey(rank: number, suit: string): string {
  return `${rank}:${suit}`;
}

/** Render a card face onto a canvas (712×512 → landscape like the DOM cards). */
export function drawFaceCanvas(rank: Rank, suit: Suit): HTMLCanvasElement {
  const key = faceTextureKey(rank, suit);
  const cached = FACE_CACHE.get(key);
  if (cached) return cached;
  const canvas = document.createElement('canvas');
  canvas.width = 512;
  canvas.height = 712;
  const ctx = canvas.getContext('2d');
  if (ctx) {
    const { label, glyph, red } = cardFaceSpec({ rank, suit });
    // Card stock
    ctx.fillStyle = '#faf5ea';
    roundRect(ctx, 0, 0, canvas.width, canvas.height, 36);
    ctx.fill();
    // Inner frame
    ctx.strokeStyle = red ? 'rgba(178, 52, 44, 0.5)' : 'rgba(30, 34, 40, 0.4)';
    ctx.lineWidth = 6;
    roundRect(ctx, 18, 18, canvas.width - 36, canvas.height - 36, 24);
    ctx.stroke();
    // Centre value
    ctx.fillStyle = red ? '#b2342c' : '#1e2228';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.font = '700 190px Georgia, "Times New Roman", serif';
    ctx.fillText(label, canvas.width / 2, canvas.height / 2 - 40);
    ctx.font = '150px Georgia, "Times New Roman", serif';
    ctx.fillText(glyph, canvas.width / 2, canvas.height / 2 + 130);
    // Corner pips
    ctx.font = '700 84px Georgia, "Times New Roman", serif';
    ctx.textAlign = 'left';
    ctx.fillText(`${label}${glyph}`, 44, 92);
    ctx.textAlign = 'right';
    ctx.save();
    ctx.translate(canvas.width - 44, canvas.height - 92);
    ctx.rotate(Math.PI);
    ctx.fillText(`${label}${glyph}`, 0, 0);
    ctx.restore();
  }
  FACE_CACHE.set(key, canvas);
  return canvas;
}

/** Card back — deep felt-toned pattern with a brand mark. */
export function drawBackCanvas(): HTMLCanvasElement {
  const cached = BACK_CACHE.get('default');
  if (cached) return cached;
  const canvas = document.createElement('canvas');
  canvas.width = 512;
  canvas.height = 712;
  const ctx = canvas.getContext('2d');
  if (ctx) {
    ctx.fillStyle = '#25321f';
    roundRect(ctx, 0, 0, canvas.width, canvas.height, 36);
    ctx.fill();
    ctx.strokeStyle = 'rgba(255, 220, 160, 0.28)';
    ctx.lineWidth = 5;
    roundRect(ctx, 20, 20, canvas.width - 40, canvas.height - 40, 22);
    ctx.stroke();
    // Diagonal lattice
    ctx.save();
    roundRect(ctx, 36, 36, canvas.width - 72, canvas.height - 72, 14);
    ctx.clip();
    ctx.strokeStyle = 'rgba(255, 220, 160, 0.10)';
    ctx.lineWidth = 3;
    for (let d = -canvas.height; d < canvas.width + canvas.height; d += 34) {
      ctx.beginPath();
      ctx.moveTo(d, 0);
      ctx.lineTo(d + canvas.height, canvas.height);
      ctx.stroke();
      ctx.beginPath();
      ctx.moveTo(d + canvas.height, 0);
      ctx.lineTo(d, canvas.height);
      ctx.stroke();
    }
    ctx.restore();
    // Centre mark
    ctx.fillStyle = 'rgba(255, 220, 160, 0.5)';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.font = '700 210px Georgia, serif';
    ctx.fillText('✦', canvas.width / 2, canvas.height / 2);
  }
  BACK_CACHE.set('default', canvas);
  return canvas;
}

const FLIGHT_CACHE = new Map<number, HTMLCanvasElement>();

/** Small blank-face card used by flight ghosts (flights only know a rank). */
export function drawFlightCanvas(rank: number): HTMLCanvasElement {
  const cached = FLIGHT_CACHE.get(rank);
  if (cached) return cached;
  const canvas = document.createElement('canvas');
  canvas.width = 256;
  canvas.height = 356;
  const ctx = canvas.getContext('2d');
  if (ctx) {
    ctx.fillStyle = '#faf5ea';
    roundRect(ctx, 0, 0, canvas.width, canvas.height, 22);
    ctx.fill();
    ctx.strokeStyle = 'rgba(30, 34, 40, 0.35)';
    ctx.lineWidth = 5;
    roundRect(ctx, 10, 10, canvas.width - 20, canvas.height - 20, 14);
    ctx.stroke();
    ctx.fillStyle = '#1e2228';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.font = '700 150px Georgia, serif';
    ctx.fillText(rankLabel(rank), canvas.width / 2, canvas.height / 2);
  }
  FLIGHT_CACHE.set(rank, canvas);
  return canvas;
}

function roundRect(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number): void {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}
