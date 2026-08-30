/**
 * Seep (Sweep) — Punjabi 4-player partnership fishing game.
 *
 * Rules tuning knobs live here as data. The shipped defaults are the common
 * 100-point version: every spade scores its face value (A♠ 1 … K♠ 13), the
 * other aces score 1, the 10♦ scores 2, and the team with more captured
 * cards gets a +4 majority bonus — 100 points in the deck. The well-known
 * family variant (10♦ = 6, no majority bonus) is a one-line override.
 */

import { standardDeck, type Card } from '@game-night/shared';

/** Capture value of a card: face value, aces low (A=1 … K=13). */
export function captureValue(card: Card): number {
  return card.rank;
}

export interface SeepRules {
  /** Cards the opening player receives before announcing (default 4). */
  openingHandCards: number;
  /** Cards dealt face-DOWN to the table before the announce (default 4). */
  tableStartCards: number;
  /** Cards per dealing round when the rest of the deck is dealt (default 4). */
  cardsPerBatch: number;
  /** Lowest possible ghar (house) total (default 9). */
  minHouseTotal: number;
  /** Highest possible ghar total (default 13 — a ghar 13 can never be broken). */
  maxHouseTotal: number;
  /** Bonus for clearing the whole table in one play (default 50). */
  sweepBonus: number;
  /** Bonus for a sweep on the deal's very first play (default 25). */
  firstPlaySweepBonus: number;
  /** Points for the 10♦ (default 2; the family variant plays 6). */
  tenDiamondsPoints: number;
  /** Bonus for the team with more captured cards (default 4; 0 in the variant). */
  majorityCardsBonus: number;
}

export const DEFAULT_SEEP_RULES: SeepRules = {
  openingHandCards: 4,
  tableStartCards: 4,
  cardsPerBatch: 4,
  minHouseTotal: 9,
  maxHouseTotal: 13,
  sweepBonus: 50,
  firstPlaySweepBonus: 25,
  tenDiamondsPoints: 2,
  majorityCardsBonus: 4,
};

/** The recognised variant: 10♦ = 6 and no most-cards bonus (still 100 total). */
export const VARIANT_TEN_DIAMOND_SIX: Partial<SeepRules> = {
  tenDiamondsPoints: 6,
  majorityCardsBonus: 0,
};

/** Deep-merge user rules over the defaults. */
export function mergeSeepRules(partial?: Partial<SeepRules>): SeepRules {
  return { ...DEFAULT_SEEP_RULES, ...(partial ?? {}) };
}

/**
 * Points a captured card is worth:
 *  - every spade: its face value (A♠ 1 … 10♠ 10, J♠ 11, Q♠ 12, K♠ 13);
 *  - the other three aces: 1 each;
 *  - the 10♦: rules.tenDiamondsPoints (2, or 6 in the variant);
 *  - everything else: 0.
 */
export function cardPoints(card: Card, rules: SeepRules): number {
  if (card.suit === 'spades') return card.rank;
  if (card.rank === 1) return 1;
  if (card.suit === 'diamonds' && card.rank === 10) return rules.tenDiamondsPoints;
  return 0;
}

/** Team 0 = even seats, team 1 = odd seats (partners sit opposite). */
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

/**
 * True when `cards` can be split into groups that EACH sum to exactly
 * `target`. This is the multi-group capture rule: playing an 8 may take
 * A+7, 3+5 and a loose 8 together — every group matches the played card.
 * Backtracking over the (small) selection; trivially fast at table sizes.
 */
export function partitionableInto(cards: Card[], target: number): boolean {
  if (cards.length === 0 || target < 1) return false;
  const vals = cards.map((c) => c.rank);
  const total = vals.reduce((a, b) => a + b, 0);
  if (total % target !== 0) return false;
  const used = new Array<boolean>(vals.length).fill(false);
  const search = (): boolean => {
    let first = -1;
    for (let i = 0; i < vals.length; i++) {
      if (!used[i]) {
        first = i;
        break;
      }
    }
    if (first === -1) return true; // everything placed
    const fill = (from: number, need: number): boolean => {
      if (need === 0) return search();
      for (let j = from; j < vals.length; j++) {
        if (used[j] || vals[j]! > need) continue;
        used[j] = true;
        if (fill(j + 1, need - vals[j]!)) return true;
        used[j] = false;
      }
      return false;
    };
    return fill(0, target);
  };
  return search();
}

/** Total card points in the deck under these rules (excludes the majority bonus). */
export function totalDeckPoints(rules: SeepRules): number {
  return standardDeck().reduce((sum, c) => sum + cardPoints(c, rules), 0);
}
