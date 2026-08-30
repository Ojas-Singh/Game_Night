/**
 * Seep (Sweep) game state, phases and action types.
 *
 * The state is plain JSON at all times so it can be persisted (Redis),
 * versioned and restored after a server restart.
 */

import type { Card, GameEvent, GamePlayer } from '@game-night/shared';
import type { SeepRules, SeepTeam } from './rules.js';

/** Linear phase machine: TURN_PLAY → … → ROUND_COMPLETE. */
export type SeepPhase = 'TURN_PLAY' | 'ROUND_COMPLETE';

/** A face-up build ("house"/ghar) sitting on the table. */
export interface SeepHouse {
  /** Stable id, e.g. "h-2". */
  id: string;
  /** The announced capture total (equals captureValue of a capturing card). */
  total: number;
  /** Owning team; only it may raise, anyone may capture. */
  ownerTeam: SeepTeam;
  /**
   * Cards joined into the house (the building card + table cards). Houses
   * are the authoritative holder of these cards — they belong to no other
   * zone while the house stands.
   */
  cards: Card[];
}

export interface SeepState {
  stateVersion: 1;
  gameId: 'seep';
  phase: SeepPhase;
  players: GamePlayer[];
  hands: Record<string, Card[]>;
  /** Face-up loose cards lying on the table. */
  tableLoose: Card[];
  /** Face-up houses. Cards inside are owned by the house, not any player. */
  houses: SeepHouse[];
  deck: Card[];
  /** How many deal batches have been handed out (starts at 1). */
  batchesDealt: number;
  /** Cards captured per player, in pickup order (public information). */
  captures: Record<string, Card[]>;
  /** Completed sweeps per team. */
  sweeps: { 0: number; 1: number };
  /** Team of the last capture — leftovers go to it at deal end. */
  lastCaptureTeam: SeepTeam | null;
  currentTurn: number;
  /** House id counter for stable ids. */
  houseSeq: number;
  /** Final team scores, set at ROUND_COMPLETE (card points + sweeps). */
  teamScores: { 0: number; 1: number } | null;
  roundWinnerTeam: SeepTeam | null;
  /** Set when the deal ends in a score tie. */
  tiedTeams: SeepTeam[];
  events: GameEvent[];
  revision: number;
  eventSeq: number;
}

export interface SeepGameOptions {
  rules?: Partial<SeepRules>;
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

/** What the player intends to do with the card they play this turn. */
export type SeepPlayIntent =
  /** Put the card on the table (only legal when it captures nothing). */
  | { kind: 'LAY_DOWN' }
  /** Take the selected loose table cards (sum must equal the played value). */
  | { kind: 'CAPTURE'; tableCardIds: string[] }
  /** Take a whole house by playing a card of its total. */
  | { kind: 'CAPTURE_HOUSE'; houseId: string }
  /** Build a house: played card + selected loose cards total `total`,
   *  and the player holds another card of that total as the backing. */
  | { kind: 'BUILD'; tableCardIds: string[]; total: number }
  /** Add the played card (value = house total) to a house your team owns. */
  | { kind: 'RAISE_HOUSE'; houseId: string };

export type SeepAction =
  | { type: 'PLAY_CARD'; playerId: string; cardId: string; intent: SeepPlayIntent };
