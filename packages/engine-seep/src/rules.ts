/**
 * Seep — Punjabi 4-player partnership fishing game.
 *
 * The shipped default is the canonical Punjabi 100-point (baazi) game per
 * docs/rules/seep-punjabi-100.md (contract): all spades at face value, other
 * aces 1, 10♦ 6 — no majority bonus; sweeps 25/50/0; match play accumulates
 * the signed deal difference until one side leads by 100. The old house mix
 * (10♦ = 2, +4 majority) survives as the explicit CASUAL_TEND_TWO preset.
 *
 * Rules tuning knobs live here as data so variants never touch the engine.
 */

import { standardDeck, type Card } from '@game-night/shared';

/** Capture value of a card: face value, aces low (A=1 … K=13). */
export function captureValue(card: Card): number {
  return card.rank;
}

export interface SeepRules {
  /** Cards the bidder receives before announcing (default 4). */
  openingHandCards: number;
  /** Cards placed face-DOWN on the floor before the announce (default 4). */
  tableStartCards: number;
  /** Cards per packet when the dealer completes the deal (default 4). */
  cardsPerBatch: number;
  /** Lowest possible ghar (house) total (default 9). */
  minHouseTotal: number;
  /** Highest possible ghar total (default 13 — a 13-ghar can never be broken). */
  maxHouseTotal: number;
  /** Bonus for clearing the whole floor in one play (default 50). */
  sweepBonus: number;
  /** Bonus for a sweep on the deal's very first play (default 25). */
  firstPlaySweepBonus: number;
  /** Sweep on the deal's final play scores 0 (canonical; true). */
  lastPlaySweepZero: boolean;
  /** Points for the 10♦ (canonical 6). */
  tenDiamondsPoints: number;
  /** Bonus for the team with more captured cards (canonical 0 — no such bonus). */
  majorityCardsBonus: number;
  /** A team scoring fewer than this many points in a deal instantly loses the baazi (canonical 9). */
  minimumDealPoints: number;
  /** Running lead (signed difference) that wins a baazi (canonical 100). */
  baaziLeadTarget: number;
  /**
   * Who deals the next hand: the current dealer again while their team is
   * behind or level, otherwise the next player to the right (canonical).
   */
  dealerPolicy: 'losing-team-stays' | 'rotate-right';
}

/** Canonical Punjabi 100-point rules (docs/rules/seep-punjabi-100.md). */
export const PUNJABI_100_CLASSIC: SeepRules = {
  openingHandCards: 4,
  tableStartCards: 4,
  cardsPerBatch: 4,
  minHouseTotal: 9,
  maxHouseTotal: 13,
  sweepBonus: 50,
  firstPlaySweepBonus: 25,
  lastPlaySweepZero: true,
  tenDiamondsPoints: 6,
  majorityCardsBonus: 0,
  minimumDealPoints: 9,
  baaziLeadTarget: 100,
  dealerPolicy: 'losing-team-stays',
};

export const DEFAULT_SEEP_RULES: SeepRules = PUNJABI_100_CLASSIC;

/** The old house mix: 10♦ = 2, +4 most-cards, sweeps all 50. Kept selectable. */
export const CASUAL_TEND_TWO: SeepRules = {
  ...PUNJABI_100_CLASSIC,
  tenDiamondsPoints: 2,
  majorityCardsBonus: 4,
  lastPlaySweepZero: false,
};

/** Back-compat alias (the "variant" is now the canonical default). */
export const VARIANT_TEN_DIAMOND_SIX: Partial<SeepRules> = {
  tenDiamondsPoints: 6,
  majorityCardsBonus: 0,
};

/** Deep-merge user rules over the canonical defaults. */
export function mergeSeepRules(partial?: Partial<SeepRules>): SeepRules {
  return { ...DEFAULT_SEEP_RULES, ...(partial ?? {}) };
}

/**
 * Points a captured card is worth:
 *  - every spade: its face value (A♠ 1 … 10♠ 10, J♠ 11, Q♠ 12, K♠ 13);
 *  - the other three aces: 1 each;
 *  - the 10♦: rules.tenDiamondsPoints (6 canonical, 2 casual);
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

/** Counter-clockwise play: the next seat after `seat` (to its right). */
export function nextSeatCCW(seat: number): number {
  return (seat + 3) % 4;
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

/**
 * Every distinct MAXIMAL collection of pairwise-disjoint groups of `cards`
 * each summing to `target`, returned as index-group lists. "Maximal" = the
 * leftover cards admit no further group summing to `target`. This enumerates
 * the legal capture alternatives when groups overlap — Pagat: a J over floor
 * 2,3,5,6 yields exactly two collections, {2+3+6} (leaving 5) and {5+6}
 * (leaving 2,3); and an 8 over A,3,5,7,8 yields exactly one, {A+7, 3+5, 8}.
 */
export function maximalCaptureAlternatives(cards: Card[], target: number): number[][][] {
  const vals = cards.map((c) => c.rank);
  const n = vals.length;
  if (n === 0 || target < 1) return [];

  // All distinct subsets summing to target, as bitmasks.
  const groupMasks: number[] = [];
  const rec = (start: number, mask: number, sum: number): void => {
    if (sum === target && mask !== 0) {
      groupMasks.push(mask);
      return;
    }
    for (let j = start; j < n; j++) {
      if (sum + vals[j]! > target) continue;
      rec(j + 1, mask | (1 << j), sum + vals[j]!);
    }
  };
  rec(0, 0, 0);
  if (groupMasks.length === 0) return [];

  const out: number[][][] = [];
  const seen = new Set<string>();
  const search = (used: number, skipped: number, groups: number[][]): void => {
    // lowest card neither taken nor skipped
    let i = 0;
    while (i < n && ((used | skipped) & (1 << i)) !== 0) i++;
    if (i >= n) {
      // every card decided — maximal iff no group lies wholly in the leftover
      const leftover = skipped;
      const stuck = groupMasks.every((g) => (g & used) !== 0 || (g & ~leftover) !== 0);
      if (stuck) {
        const key = groups
          .map((g) => [...g].sort((a, b) => a - b).join(','))
          .sort()
          .join('|');
        if (!seen.has(key)) {
          seen.add(key);
          out.push(groups);
        }
      }
      return;
    }
    for (const g of groupMasks) {
      if (g & (used | skipped)) continue;
      if ((g & (1 << i)) === 0) continue;
      const idx: number[] = [];
      for (let j = 0; j < n; j++) if (g & (1 << j)) idx.push(j);
      search(used | g, skipped, [...groups, idx]);
    }
    search(used, skipped | (1 << i), groups); // leave card i over
  };
  search(0, 0, []);
  return out;
}

/** Total card points in the deck under these rules (excludes the majority bonus). */
export function totalDeckPoints(rules: SeepRules): number {
  return standardDeck().reduce((sum, c) => sum + cardPoints(c, rules), 0);
}
