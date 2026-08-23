/**
 * Pair One — state, phases and action types.
 *
 * A public-information memory game: one deck is shuffled into one big
 * face-down grid. On your turn you flip any two cards (EVERYONE sees them).
 * Matching numbers → you collect the pair and flip again. A miss flips both
 * back and passes the turn. The round ends when the grid is empty.
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

export interface PairOneRules {
  /** Always 1 — Pair One uses exactly one standard 52-card deck (locked). */
  decks: number;
  minPlayers: number;
  maxPlayers: number;
}

export const DEFAULT_PAIRONE_RULES: PairOneRules = {
  decks: 1,
  minPlayers: 2,
  maxPlayers: 6,
};

/** Grid layout hint: the dealt cards form `gridCols` columns row-major. */
export const GRID_COLS = 13;

export interface PairOneState {
  stateVersion: 1;
  gameId: 'pairone';
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
