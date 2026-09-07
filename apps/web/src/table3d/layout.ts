/**
 * 3D table layout — pure geometry shared by the scene renderer and its tests.
 *
 * World units: 1 ≈ one card width. The table centre is the origin; my seat is
 * at +Z (nearest the camera), opponents fan across the far arc exactly like
 * the DOM SeatPlanner (20°..160° from the top).
 */

import type { CaboPlayerView } from '@cabo/views.js';

export interface Vec3 {
  x: number;
  y: number;
  z: number;
}

export interface CardInstance {
  cardId: string;
  /** Seat index: 0..N-2 are opponents in viewer order, -1 is me. */
  seatIndex: number;
  /** Position of the card centre on the table plane. */
  pos: Vec3;
  /** Y rotation (radians): 0 = facing me, opponents' fans rotate with them. */
  rotationY: number;
  /** X tilt (radians) — my cards lean up toward the camera. */
  tiltX?: number;
  /** Card is face-up from MY point of view. */
  faceUp: boolean;
  /** Lifted above the table plane (draw decision, peek target, selection). */
  lifted: boolean;
  emptySlot: boolean;
}

export interface SeatLayout {
  playerId: string;
  angleDeg: number;
  pos: Vec3;
  /** Where that seat's hand centre sits (flight anchor). */
  handCenter: Vec3;
  rotationY: number;
}

export interface SceneLayout {
  seats: SeatLayout[];
  me: SeatLayout;
  myCards: CardInstance[];
  opponentCards: CardInstance[];
  deckPos: Vec3;
  discardPos: Vec3;
  drawnPos: Vec3;
  deckCount: number;
}

/** Card mesh size (world units). */
export const CARD_W = 0.66;
export const CARD_H = 0.92;
const FELT_A = 3.9; // ellipse semi-axis across (x)
const FELT_B = 2.6; // ellipse semi-axis deep (z)
const HAND_GAP = CARD_W * 1.08;
const OVERFLOW_GAP = CARD_W * 0.62;

/** Opponent seat angle in degrees, 0 = directly opposite me (same fan as DOM). */
export function opponentAngle(index: number, count: number): number {
  const n = Math.max(1, count);
  const t = n === 1 ? 0.5 : index / (n - 1);
  return 20 + t * 140;
}

/** World position on the felt ellipse for a seat angle in degrees
 *  (0° = directly opposite me, same convention as the DOM SeatPlanner). */
export function seatPosition(angleDeg: number): Vec3 {
  const rad = (angleDeg * Math.PI) / 180;
  return { x: -FELT_A * Math.cos(rad), y: 0, z: -FELT_B * Math.sin(rad) };
}

/** Yaw so a card's top edge points toward the table centre (real-table
 *  convention: the opposite player's cards read upside down from my view). */
export function seatRotationY(angleDeg: number): number {
  const rad = (angleDeg * Math.PI) / 180;
  return Math.atan2(-Math.cos(rad), -Math.sin(rad));
}

function handPositions(seat: Vec3, rotationY: number, count: number): Vec3[] {
  // Up to four cards in the front row, extras tucked behind (mirrors the DOM
  // 4+overflow layout). The row runs perpendicular to the seat's facing.
  const front = Math.min(4, count);
  const back = count - front;
  const cos = Math.cos(rotationY);
  const sin = Math.sin(rotationY);
  const place = (perp: number, depth: number): Vec3 => ({
    x: seat.x + perp * cos + depth * sin,
    y: 0,
    z: seat.z - perp * sin + depth * cos,
  });
  const out: Vec3[] = [];
  for (let i = 0; i < front; i++) {
    const perp = (i - (front - 1) / 2) * HAND_GAP;
    out.push(place(perp, 0));
  }
  for (let i = 0; i < back; i++) {
    const perp = (i - (back - 1) / 2) * OVERFLOW_GAP;
    out.push(place(perp, -CARD_H * 1.18));
  }
  return out;
}

interface BuildArgs {
  view: CaboPlayerView;
  /** Opponents in viewer order (same order as the DOM SeatPlanner arc). */
  opponentIds: string[];
  myId: string;
  /** Selection / interaction lifts (card ids). */
  liftedIds?: Set<string>;
  drawnCardId?: string | null;
}

/** Build every card instance + pile position for a view. Pure and testable. */
export function buildSceneLayout(args: BuildArgs): SceneLayout {
  const { view, opponentIds, myId } = args;
  const lifted = args.liftedIds ?? new Set<string>();
  const seats: SeatLayout[] = opponentIds.map((playerId, index) => {
    const angleDeg = opponentAngle(index, opponentIds.length);
    const pos = seatPosition(angleDeg);
    return {
      playerId,
      angleDeg,
      pos,
      handCenter: pos,
      rotationY: seatRotationY(angleDeg),
    };
  });
  const me: SeatLayout = {
    playerId: myId,
    angleDeg: 180,
    pos: { x: 0, y: 0, z: FELT_B * 0.9 },
    handCenter: { x: 0, y: 0, z: FELT_B * 1.05 },
    rotationY: 0,
  };

  const opponentCards: CardInstance[] = [];
  seats.forEach((seat, seatIndex) => {
    const ids = view.handCardIds[seat.playerId] ?? [];
    const slots = handPositions(seat.pos, seat.rotationY, ids.length);
    ids.forEach((cardId, i) => {
      const slot = slots[i] ?? seat.handCenter;
      const known = view.knownCards[cardId];
      const emptySlot = cardId.startsWith('__slot__');
      opponentCards.push({
        cardId,
        seatIndex,
        pos: { ...slot, y: lifted.has(cardId) ? CARD_H * 0.35 : 0.02 },
        rotationY: seat.rotationY,
        // Face-up only when I actually know the card (or Test Mode tint).
        faceUp: Boolean(known) && !emptySlot,
        lifted: lifted.has(cardId),
        emptySlot,
      });
    });
  });

  const myIds = view.handCardIds[myId] ?? [];
  const mySlots = handPositions(me.handCenter, 0, myIds.length);
  const myCards: CardInstance[] = myIds.map((cardId, i) => {
    const slot = mySlots[i] ?? me.handCenter;
    const known = view.knownCards[cardId];
    const emptySlot = cardId.startsWith('__slot__');
    return {
      cardId,
      seatIndex: -1,
      pos: { ...slot, y: lifted.has(cardId) ? 0.3 + CARD_H * 0.4 : 0.3 },
      rotationY: 0,
      // Tilt my cards up toward the camera so they read like held cards.
      tiltX: -0.62,
      // My cards render face-up whenever I know them (initial peek ships the
      // bottom two; knowledge grows from there). Unknown own cards show backs.
      faceUp: Boolean(known) && !emptySlot,
      lifted: lifted.has(cardId),
      emptySlot,
    };
  });

  return {
    seats,
    me,
    myCards,
    opponentCards,
    deckPos: { x: -0.85, y: 0, z: -0.15 },
    discardPos: { x: 0.85, y: 0, z: -0.15 },
    drawnPos: { x: 1.62, y: CARD_H * 0.22, z: 0.28 },
    deckCount: view.deckCount,
  };
}

/** Resolve a symbolic flight anchor to a world position. */
export function flightAnchor(
  layout: SceneLayout,
  anchor: { playerId?: string; cardId?: string; pile?: 'deck' | 'discard' | 'draw' },
): Vec3 {
  if (anchor.pile === 'deck') return layout.deckPos;
  if (anchor.pile === 'discard') return layout.discardPos;
  if (anchor.pile === 'draw') return layout.drawnPos;
  if (anchor.cardId) {
    const card = [...layout.myCards, ...layout.opponentCards].find((c) => c.cardId === anchor.cardId);
    if (card) return card.pos;
  }
  if (anchor.playerId) {
    if (anchor.playerId === layout.me.playerId) return layout.me.handCenter;
    const seat = layout.seats.find((s) => s.playerId === anchor.playerId);
    if (seat) return seat.handCenter;
  }
  return { x: 0, y: 0, z: 0 };
}

// ---------------------------------------------------------------------------
// 3D capability gate
// ---------------------------------------------------------------------------

export function canRun3d(): boolean {
  if (typeof window === 'undefined' || typeof navigator === 'undefined') return false;
  if (typeof window.matchMedia === 'function' && window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
    return false;
  }
  return (navigator.hardwareConcurrency ?? 4) >= 4;
}

const PREF_KEY = 'game-night:table3d';

export function load3dPref(): boolean {
  // The 3D table is strictly opt-in — the classic 2D table is the default.
  try {
    return localStorage.getItem(PREF_KEY) === 'on';
  } catch {
    return false;
  }
}

export function save3dPref(on: boolean): void {
  try {
    localStorage.setItem(PREF_KEY, on ? 'on' : 'off');
  } catch {
    /* ignore */
  }
}
