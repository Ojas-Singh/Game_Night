/**
 * Centralised house-rules definition for our version of Cabo.
 *
 * Every tunable number and rule switch lives here — never scattered through
 * engine logic. Changing a house rule should only require editing this file.
 */

import type { Card, Rank } from '@game-night/shared';

/** Powers our house rules attach to rank bands. */
export type CaboPower =
  | 'SWAP_OTHERS' // 5–6: swap two cards belonging to other players
  | 'PEEK_OWN' // 7–8: view one of your own cards
  | 'PEEK_OTHER' // 9–10: view another player's card
  | 'BLIND_SWAP'; // J–Q: swap one of your cards with another player's card

export type WrongFlushPenalty = 'none' | 'draw_one' | 'draw_two';

export interface CaboRules {
  /** Cards dealt face-down to each player. */
  startingCards: number;
  /** How many of their own cards a player peeks at during setup. */
  initialPeekCards: number;

  /** Point value per rank. Red/black king override via kingValues. */
  rankValues: Record<Rank, number>;
  /** Kings score differently by colour: black = -1, red = 13. */
  kingValues: { red: number; black: number };

  /** Rank bands that carry powers. */
  powerBands: Array<{ from: Rank; to: Rank; power: CaboPower }>;

  /** House-rule toggle (host-selectable): when false, discarding a 5–6
   *  triggers no power. */
  swapOthersEnabled: boolean;

  /** Penalty for an incorrect flush attempt. */
  wrongFlushPenalty: WrongFlushPenalty;

  /** What happens when someone must draw from an empty deck. */
  emptyDeckBehavior: 'reshuffle_discard' | 'end_round';

  /** A player reaching zero cards (via flushing) ends the round. */
  endRoundWhenPlayerHasNoCards: boolean;

  /** Cabo (calling the round end). */
  cabo: {
    enabled: boolean;
    /** Caller still gets a final normal turn after calling. (House rule: no.) */
    callerGetsFinalTurn: boolean;
    /** Normal turns every other player receives after the call. */
    othersFinalTurns: number;
  };

  minPlayers: number;
  maxPlayers: number;
}

export const DEFAULT_CABO_RULES: CaboRules = {
  startingCards: 4,
  initialPeekCards: 2,
  rankValues: {
    1: 1,
    2: 2,
    3: 3,
    4: 4,
    5: 5,
    6: 6,
    7: 7,
    8: 8,
    9: 9,
    10: 10,
    11: 11,
    12: 12,
    13: 13,
  },
  kingValues: { red: 13, black: -1 },
  powerBands: [
    { from: 5, to: 6, power: 'SWAP_OTHERS' },
    { from: 7, to: 8, power: 'PEEK_OWN' },
    { from: 9, to: 10, power: 'PEEK_OTHER' },
    { from: 11, to: 12, power: 'BLIND_SWAP' },
  ],
  // 5–6 optional by host (house rule); 7–10 and J–Q always on.
  swapOthersEnabled: true,
  wrongFlushPenalty: 'draw_one',
  emptyDeckBehavior: 'reshuffle_discard',
  endRoundWhenPlayerHasNoCards: true,
  cabo: {
    enabled: true,
    callerGetsFinalTurn: false,
    othersFinalTurns: 1,
  },
  minPlayers: 2,
  maxPlayers: 6,
};

/** Score of a single card under the configured rules. */
export function cardValue(card: Card, rules: CaboRules): number {
  if (card.rank === 13) {
    return card.suit === 'hearts' || card.suit === 'diamonds'
      ? rules.kingValues.red
      : rules.kingValues.black;
  }
  return rules.rankValues[card.rank];
}

/** Which power (if any) a rank carries. */
export function powerForRank(rank: Rank, rules: CaboRules): CaboPower | null {
  for (const band of rules.powerBands) {
    if (rank >= band.from && rank <= band.to) return band.power;
  }
  return null;
}

/** Human-readable descriptions, used by UI prompts. */
export const POWER_DESCRIPTIONS: Record<CaboPower, string> = {
  SWAP_OTHERS: 'Choose two cards belonging to other players and swap them',
  PEEK_OWN: 'Choose one of your own cards to view',
  PEEK_OTHER: "Choose another player's card to view",
  BLIND_SWAP: 'Blind-swap one of your cards with another player\u2019s card',
};
