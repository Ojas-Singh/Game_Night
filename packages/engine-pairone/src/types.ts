/**
 * Pair One — state, phases and action types.
 *
 * A public-information memory game: one deck is shuffled into one big
 * face-down grid. On your turn you flip any two cards (EVERYONE sees them).
 * Matching numbers → you collect the pair and flip again. A miss flips both
 * back and passes the turn. The round ends when the grid is empty.
 *
 * The rules are played by the core (`@game-night/core`); this file must not
 * load it, because the web client imports these types.
 *
 * State is plain JSON at all times so it can be persisted (Redis),
 * versioned and restored after a server restart.
 */

import type { Card, GameEvent, GamePlayer } from '@game-night/shared';

/**
 * TURN           — the current player may flip their first or second card.
 * ROUND_COMPLETE — the grid is empty; results are final.
 */
export type PairOnePhase = 'TURN' | 'ROUND_COMPLETE';

/** The core's settings for Pair One (`gameInfo('pairone').settings`). */
export interface PairOneRules {
  /** Ranks in the grid, counted up from the ace (2-13). */
  ranks: number;
  /** Cards of each rank: 2 or 4. */
  copies: number;
  /** A player who finds a pair plays again. */
  extraTurn: boolean;
}

/** The core's "Standard" preset: one whole deck. */
export const DEFAULT_PAIRONE_RULES: PairOneRules = {
  ranks: 13,
  copies: 4,
  extraTurn: true,
};

/** Grid layout hint: the dealt cards form `gridCols` columns row-major. */
export const GRID_COLS = 13;

export interface PairOneState {
  stateVersion: 2;
  gameId: 'pairone';
  /** The round as the rules core saves it; a restore plays on from this. */
  core: unknown;
  /** The table's card for each of the core's card numbers. */
  cards: Record<string, Card>;
  phase: PairOnePhase;
  players: GamePlayer[];
  /**
   * Fixed-position grid of face-down cards, row-major. Collected cards leave
   * a permanent `null` gap so every remaining card keeps its exact position —
   * it's a memory game; positions are information.
   */
  grid: (Card | null)[];
  /** Seat index of the player whose turn it is. */
  currentTurn: number;
  /** Card ids flipped face-up during the CURRENT turn (0 or 1 between actions). */
  flippedThisTurn: string[];
  /** Cards collected per player, in pickup order (public — all flips are). */
  collections: Record<string, Card[]>;
  /** Card ids each player has seen flipped (all players learn every flip). */
  knowledge: Record<string, string[]>;
  /** Who missed last (and with which two cards) — flavour for the UI. */
  lastMiss: { playerId: string; cardIds: string[] } | null;
  scores: Record<string, number> | null;
  roundWinnerId: string | null;
  /** Set when the round ends in a tie. */
  tiedWinnerIds: string[];
  events: GameEvent[];
  revision: number;
  /** Monotonic event sequence. */
  eventSeq: number;
}

/** Options accepted by createGame (debug/testing support included). */
export interface PairOneGameOptions {
  rules?: Partial<PairOneRules>;
  /** Deterministic RNG seed (tests / debug mode). */
  seed?: number;
  /** Force an exact grid order (debug mode / tests). Index 0 = first slot. */
  forcedGrid?: Card[];
  /** Force who takes the first turn (seat index; debug/tests). */
  firstTurnSeat?: number;
}

// ---------------------------------------------------------------------------
// Actions
// ---------------------------------------------------------------------------

/**
 * Flip a face-down grid card. The FIRST flip stays revealed on the table;
 * the SECOND resolves the turn:
 *  - matching numbers → pair collected, same player continues;
 *  - mismatch         → both flip back, turn passes left.
 */
export type PairOneAction = {
  type: 'FLIP_CARD';
  playerId: string;
  cardId: string;
};
