/**
 * Seep (Sweep) game state, phases and action types.
 *
 * The state is plain JSON at all times so it can be persisted (Redis),
 * versioned and restored after a server restart.
 */

import type { Card, GameEvent, GamePlayer } from '@game-night/shared';
import type { SeepRules, SeepTeam } from './rules.js';

/**
 * ANNOUNCE — the opener looks at their 4 cards and announces a number
 *   9–13 they hold (the deal is redealt automatically if they cannot).
 * TURN_PLAY — table face up; players each play one card per turn.
 */
export type SeepPhase = 'ANNOUNCE' | 'TURN_PLAY' | 'ROUND_COMPLETE';

/**
 * A ghar (house/build): cards locked together under one value 9–13.
 *  - kachcha (sets === 1): can be broken to a higher total by anyone
 *    except its owner;
 *  - pakka (sets >= 2): two or more complete sets of the same value —
 *    it can no longer be broken, only captured with the matching card.
 */
export interface SeepHouse {
  /** Stable id, e.g. "h-2". */
  id: string;
  /** The house total (9–13); a matching card captures the whole house. */
  total: number;
  /** Owning PLAYER (its creator, or the player who last broke it). */
  ownerId: string;
  /** How many complete sets of `total` are joined here (1 = kachcha). */
  sets: number;
  /**
   * Cards joined into the house (building cards + table cards). Houses
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
  /**
   * Loose cards on the table. Face-DOWN (values hidden in views) until the
   * opening announce turns them up.
   */
  tableLoose: Card[];
  /** Face-up houses. Cards inside are owned by the house, not any player. */
  houses: SeepHouse[];
  deck: Card[];
  /** The player who announced first and leads the first play. */
  openerId: string;
  /** The announced number (9–13); null until the announce. */
  bid: number | null;
  /** True until the rest of the deck is dealt (which happens right after the opener's first play). */
  dealRestPending: boolean;
  /** Batches handed out when the deal resumed (event/view bookkeeping). */
  batchesDealt: number;
  /** Total plays made so far in the deal (both sides sweep rules key off this). */
  playsMade: number;
  /** Cards captured per player, in pickup order (public information). */
  captures: Record<string, Card[]>;
  /** Completed sweeps per team. */
  sweeps: { 0: number; 1: number };
  /** Sweep bonus points banked per team (25 / 50 / 0 depending on timing). */
  sweepPoints: { 0: number; 1: number };
  /** Team of the last capture — all leftover table cards go to it at deal end. */
  lastCaptureTeam: SeepTeam | null;
  currentTurn: number;
  /** House id counter for stable ids. */
  houseSeq: number;
  /** Final team scores, set at ROUND_COMPLETE (card points + sweeps + majority). */
  teamScores: { 0: number; 1: number } | null;
  /** Team that took more cards (only when it earned the majority bonus). */
  majorityTeam: SeepTeam | null;
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
  /** Force who opens (seat index; debug/tests). */
  firstTurnSeat?: number;
}

// ---------------------------------------------------------------------------
// Actions
// ---------------------------------------------------------------------------

/** The opener announces a number 9–13 that they hold; the table turns up. */
export type SeepAnnounceAction = { type: 'ANNOUNCE'; playerId: string; value: number };

/** What the player intends to do with the card they play this turn. */
export type SeepPlayIntent =
  /** Put the card on the table (only legal when it captures nothing). */
  | { kind: 'LAY_DOWN' }
  /**
   * Take loose table cards and/or whole houses, all matching the played
   * value: every selected house's total equals the played value, and the
   * selected loose cards split into groups that each sum to it.
   */
  | { kind: 'CAPTURE'; tableCardIds: string[]; houseIds: string[] }
  /**
   * Build a kachcha ghar: played card + selected loose cards form ONE set
   * totalling 9–13, and the player holds another card of that total.
   */
  | { kind: 'BUILD'; tableCardIds: string[]; total: number }
  /**
   * Add another complete set of the house total (played card + optional
   * loose cards) to a ghar your team owns. Two sets make it pakka.
   */
  | { kind: 'ADD_TO_HOUSE'; houseId: string; tableCardIds: string[] }
  /**
   * Break a kachcha ghar you do not own: played card raises its total
   * (total + value ≤ 13); you must hold the new total. The house becomes
   * yours, kachcha again.
   */
  | { kind: 'BREAK_HOUSE'; houseId: string };

export type SeepAction = SeepAnnounceAction | { type: 'PLAY_CARD'; playerId: string; cardId: string; intent: SeepPlayIntent };
