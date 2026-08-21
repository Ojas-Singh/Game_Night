/**
 * Cabo game state, phases and action types.
 *
 * The state is plain JSON at all times so it can be persisted (Redis),
 * versioned and restored after a server restart.
 */

import type { Card, GameEvent, GamePlayer } from '@game-night/shared';
import type { CaboPower, CaboRules } from './rules.js';

/**
 * Explicit phase machine:
 *
 * INITIAL_PEEK → TURN_DRAW → DRAW_DECISION → (POWER_PENDING) → TURN_DRAW → ...
 * Any gameplay phase can be interrupted by FLUSH actions (validated server-side).
 * After CALL_CABO the remaining players take final turns, then ROUND_REVEAL.
 */
export type CaboPhase =
  | 'INITIAL_PEEK'
  | 'TURN_DRAW'
  | 'DRAW_DECISION'
  | 'POWER_PENDING'
  | 'TRANSFER_PENDING'
  | 'ROUND_REVEAL'
  | 'ROUND_COMPLETE';

export interface PendingPower {
  /** Player who discarded the power card and must perform it. */
  playerId: string;
  power: CaboPower;
  /** The discarded card whose power triggered. */
  sourceCardId: string;
}

export interface PendingTransfer {
  /** Flusher who must give one of their cards away. */
  fromPlayerId: string;
  /** Target whose card was correctly flushed. */
  toPlayerId: string;
  /** Phase to restore once the transfer completes. */
  phaseBefore: CaboPhase;
}

export interface CaboCall {
  callerId: string;
  /** Players who have taken their final turn(s). */
  takenFinalTurn: string[];
}

export interface CaboState {
  stateVersion: 1;
  gameId: 'cabo';
  phase: CaboPhase;
  players: GamePlayer[];
  /**
   * Hands are SPARSE: a flushed card leaves a `null` gap so every remaining
   * card keeps its position on the table (it's a memory game — positions are
   * information). New cards (penalties, transfers) fill the first gap, or
   * append when there is none.
   */
  hands: Record<string, (Card | null)[]>;
  /** Card ids each player is entitled to know the value of. */
  knowledge: Record<string, string[]>;
  deck: Card[];
  discard: Card[];
  currentTurn: number;
  /** Card currently held by the active player after DRAW. */
  drawnCard: Card | null;
  pendingPower: PendingPower | null;
  pendingTransfer: PendingTransfer | null;
  cabo: CaboCall | null;
  /** Players that still owe their initial peek. */
  initialPeeksRemaining: string[];
  scores: Record<string, number> | null;
  roundWinnerId: string | null;
  /** Set when the round ends in a score tie. */
  tiedWinnerIds: string[];
  events: GameEvent[];
  revision: number;
  /** Monotonic event sequence. */
  eventSeq: number;
}

/** Options accepted by createGame (debug/testing support included). */
export interface CaboGameOptions {
  rules?: Partial<CaboRules>;
  /** Deterministic RNG seed (tests / debug mode). */
  seed?: number;
  /** Force an exact deck order (debug mode / tests). Top of array = top of deck. */
  forcedDeck?: Card[];
  /** Force who takes the first turn (seat index; debug/tests). */
  firstTurnSeat?: number;
}

// ---------------------------------------------------------------------------
// Actions
// ---------------------------------------------------------------------------

export type CaboAction =
  | { type: 'PEEK_STARTING'; playerId: string; cardIndexes: number[] }
  | { type: 'DRAW'; playerId: string }
  | { type: 'KEEP_DRAWN'; playerId: string; handIndex: number }
  | { type: 'DISCARD_DRAWN'; playerId: string }
  | {
      type: 'POWER_APPLY';
      playerId: string;
      payload:
        | { power: 'SWAP_OTHERS'; cardIdA: string; cardIdB: string }
        | { power: 'PEEK_OWN'; cardId: string }
        | { power: 'PEEK_OTHER'; targetPlayerId: string; cardId: string }
        | { power: 'BLIND_SWAP'; ownCardId: string; targetPlayerId: string; targetCardId: string };
    }
  | { type: 'FLUSH_OWN'; playerId: string; cardIds: string[] }
  | { type: 'FLUSH_OTHER'; playerId: string; targetPlayerId: string; cardId: string }
  | { type: 'TRANSFER_CARD'; playerId: string; cardId: string }
  | { type: 'CALL_CABO'; playerId: string };
