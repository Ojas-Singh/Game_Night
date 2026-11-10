/**
 * The rule settings of Cabo and what they mean for a single card.
 *
 * The rules themselves are played by the rules core; this file only names
 * the settings (it is also compiled into the web client, so it must not load
 * the core).
 */

import type { Card, Rank } from '@game-night/shared';

/** Powers our house rules attach to rank bands. */
export type CaboPower =
  | 'PEEK_OWN' // 7–8: view one of your own cards
  | 'PEEK_OTHER' // 9–10: view another player's card
  | 'BLIND_SWAP'; // J–Q: swap one of your cards with another player's card

/** A rank's entry in `rankPowers`. */
export type RankPower = CaboPower | 'NONE';

/**
 * The rules of a round, exactly as the rules core takes them (`core/`,
 * `CaboRules` in `games/cabo`). The core's settings list describes each one
 * for the lab; the core's "Standard" preset equals `DEFAULT_CABO_RULES`.
 */
export interface CaboRules {
  /** Cards dealt face-down to each player. */
  startingCards: number;
  /** How many of their own cards a player peeks at during setup. */
  initialPeekCards: number;
  /** Points per rank, ace first. The king's entry is replaced by the two below. */
  rankValues: number[];
  redKingValue: number;
  blackKingValue: number;
  /** Power per rank, ace first. */
  rankPowers: RankPower[];
  /** Players may flush their own matching cards. */
  flushOwn: boolean;
  /** Players may flush another player's matching card. */
  flushOther: boolean;
  /** Cards drawn as the penalty for a wrong flush (0 to 2). */
  wrongFlushPenalty: number;
  /** An empty deck is refilled from the discard pile; otherwise the round ends. */
  reshuffleDiscard: boolean;
  /** A player reaching zero cards ends the round at once. Default false:
   *  that player scores 0 and Cabo is called for them. */
  endRoundWhenPlayerOut: boolean;
  caboEnabled: boolean;
  /** The caller still gets a final normal turn after calling. (House rule: no.) */
  callerGetsFinalTurn: boolean;
  /** Normal turns every other player receives after the call. */
  othersFinalTurns: number;
  /** The round ends after this many turns; 0 for no limit. */
  turnLimit: number;
}

export const DEFAULT_CABO_RULES: CaboRules = {
  startingCards: 4,
  initialPeekCards: 2,
  rankValues: [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13],
  redKingValue: 13,
  blackKingValue: -1,
  rankPowers: [
    'NONE', 'NONE', 'NONE', 'NONE', 'NONE', 'NONE',
    'PEEK_OWN', 'PEEK_OWN', 'PEEK_OTHER', 'PEEK_OTHER', 'BLIND_SWAP', 'BLIND_SWAP', 'NONE',
  ],
  flushOwn: true,
  flushOther: true,
  wrongFlushPenalty: 1,
  reshuffleDiscard: true,
  endRoundWhenPlayerOut: false,
  caboEnabled: true,
  callerGetsFinalTurn: false,
  othersFinalTurns: 1,
  turnLimit: 0,
};

/** Score of a single card under the configured rules. */
export function cardValue(card: Card, rules: CaboRules): number {
  if (card.rank === 13) {
    return card.suit === 'hearts' || card.suit === 'diamonds' ? rules.redKingValue : rules.blackKingValue;
  }
  return rules.rankValues[card.rank - 1]!;
}

/** Which power (if any) a rank carries. */
export function powerForRank(rank: Rank, rules: CaboRules): CaboPower | null {
  const power = rules.rankPowers[rank - 1];
  return !power || power === 'NONE' ? null : power;
}

/** Human-readable descriptions, used by UI prompts. */
export const POWER_DESCRIPTIONS: Record<CaboPower, string> = {
  PEEK_OWN: 'Choose one of your own cards to view',
  PEEK_OTHER: "Choose another player's card to view",
  BLIND_SWAP: 'Swap: tap one of your cards and one of another player\u2019s cards, in either order',
};
