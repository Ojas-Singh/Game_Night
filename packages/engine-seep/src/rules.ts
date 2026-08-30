/**
 * Seep (Sweep) — house-rules tuning knobs.
 *
 * Seep is played with many regional variations. Everything households argue
 * about lives here as data: deal shape, sweep bonus and the scoring table.
 * The shipped defaults are the platform's house rules.
 */

import { standardDeck, type Card, type Rank, type Suit } from '@game-night/shared';

/** Capture value of a card: face value, aces low (A=1 … K=13). */
export function captureValue(card: Card): number {
  return card.rank;
}

/** Scoring table: which captured cards carry points, and how many. */
export interface SeepPointRules {
  /**
   * When true (default) every spade scores its pip value with faces
   * (J/Q/K) worth 10 each — the suit everyone fights over.
   */
  spadesPip: boolean;
  /** Points for each ace that is not covered above (default 5). */
  otherAcesPoints: number;
  /** Explicit per-card overrides; first match wins. */
  overrides: Array<{ suit?: Suit; rank?: Rank; points: number }>;
}

export interface SeepRules {
  /** Cards dealt to each player per deal batch (default 4). */
  cardsPerBatch: number;
  /** Total deal batches per player per game (default 3 → 12 cards each). */
  maxBatches: number;
  /** Cards dealt face-up to the table at the start (default 4). */
  tableStartCards: number;
  /** Bonus for a seep — one play that clears the whole table (default 50). */
  sweepBonus: number;
  pointRules: SeepPointRules;
}

export const DEFAULT_SEEP_POINT_RULES: SeepPointRules = {
  spadesPip: true,
  otherAcesPoints: 5,
  overrides: [],
};

export const DEFAULT_SEEP_RULES: SeepRules = {
  cardsPerBatch: 4,
  maxBatches: 3,
  tableStartCards: 4,
  sweepBonus: 50,
  pointRules: { ...DEFAULT_SEEP_POINT_RULES, overrides: [] },
};

/** Deep-merge user rules over the defaults (pointRules is nested). */
export function mergeSeepRules(partial?: Partial<SeepRules>): SeepRules {
  if (!partial) return { ...DEFAULT_SEEP_RULES, pointRules: clonePoints(DEFAULT_SEEP_RULES.pointRules) };
  return {
    ...DEFAULT_SEEP_RULES,
    ...partial,
    pointRules: {
      ...DEFAULT_SEEP_POINT_RULES,
      ...(partial.pointRules ?? {}),
      overrides: (partial.pointRules?.overrides ?? DEFAULT_SEEP_POINT_RULES.overrides).map((o) => ({ ...o })),
    },
  };
}

function clonePoints(p: SeepPointRules): SeepPointRules {
  return { ...p, overrides: p.overrides.map((o) => ({ ...o })) };
}

/** Points a captured card is worth under the configured table. */
export function cardPoints(card: Card, rules: SeepRules): number {
  for (const o of rules.pointRules.overrides) {
    if (o.suit !== undefined && o.suit !== card.suit) continue;
    if (o.rank !== undefined && o.rank !== card.rank) continue;
    if (o.suit === undefined && o.rank === undefined) continue;
    return o.points;
  }
  if (card.suit === 'spades' && rules.pointRules.spadesPip) {
    return card.rank >= 11 ? 10 : card.rank; // faces flatten to 10
  }
  if (card.rank === 1) return rules.pointRules.otherAcesPoints;
  return 0;
}

/** Team 0 = even seats, team 1 = odd seats. */
export type SeepTeam = 0 | 1;

export function teamOfSeat(seat: number): SeepTeam {
  return (seat % 2) as SeepTeam;
}

/**
 * True when some non-empty subset of `values` sums exactly to `target`.
 * Bitset DP clamped to sums ≤ 13 (a capturing card value) — larger sums can
 * never matter, and clamping keeps the mask inside 32-bit safety.
 */
export function reachableSubsetSum(cards: Card[], target: number): boolean {
  if (target < 1 || target > 13) return false;
  const LIMIT = (1 << 14) - 1; // bits 0..13
  let reach = 0;
  for (const c of cards) {
    const v = c.rank;
    reach |= (reach << v) & LIMIT;
    reach |= 1 << v;
  }
  return (reach & (1 << target)) !== 0;
}

/** Total points sitting in the deck (default table: 100). */
export function totalDeckPoints(rules: SeepRules): number {
  return standardDeck().reduce((sum, c) => sum + cardPoints(c, rules), 0);
}
