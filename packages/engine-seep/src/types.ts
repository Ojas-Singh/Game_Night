/**
 * Seep (Sweep) game state, phases and action types — canonical Punjabi
 * 100-point rules (docs/rules/seep-punjabi-100.md).
 *
 * The state is plain JSON at all times so it can be persisted (Redis),
 * versioned and restored after a server restart.
 */

import type { Card, GameEvent, GamePlayer } from '@game-night/shared';
import type { SeepRules, SeepTeam } from './rules.js';

/**
 * ANNOUNCE — the bidder looks at their 4 cards and announces a number 9–13
 *   they hold (the deal is redealt automatically if they cannot).
 * TURN_PLAY — floor face up; players each play one card per turn.
 * DEAL_COMPLETE — one deal finished; scores counted, match continues.
 * MATCH_COMPLETE — a baazi has been won (lead ≥ target or 9-point minimum).
 */
export type SeepPhase = 'ANNOUNCE' | 'TURN_PLAY' | 'DEAL_COMPLETE' | 'MATCH_COMPLETE';

/**
 * A ghar (house/build): cards locked together under one value 9–13.
 *
 *  - kachcha (copies === 1): can be broken upward by anyone except its owner;
 *  - pakka (copies >= 2, derived): two or more complete sets of the value —
 *    it can no longer be broken, only captured with the matching card.
 *
 * There is NEVER more than one house of a given total on the floor, and a
 * loose card matching a house total cannot coexist with it.
 *
 * Ownership: every house has at least one owner. `ownerByTeam` maps each
 * owning team to the responsible PLAYER (establisher, last breaker, or an
 * opponent who cemented). Both teams may own one house simultaneously. Each
 * owner must keep a card of the house's value in hand while it stands.
 */
export interface SeepHouse {
  /** Stable id, e.g. "h-2". */
  id: string;
  /** The house total (9–13); a matching card captures the whole house. */
  total: number;
  /** Owning player per team (at least one entry; at most one per team). */
  ownerByTeam: Partial<Record<SeepTeam, string>>;
  /**
   * Cards joined into the house (building cards + absorbed table cards).
   * Houses are the authoritative holder of these cards — they belong to no
   * other zone while the house stands.
   */
  cards: Card[];
}

/** Derived: complete sets of `total` joined in the house (1 = kachcha). */
export function houseCopies(house: SeepHouse): number {
  const sum = house.cards.reduce((acc, c) => acc + c.rank, 0);
  return Math.round(sum / house.total);
}

/** Derived: a cemented (pakka) house has two or more copies of its total. */
export function houseIsPakka(house: SeepHouse): boolean {
  return houseCopies(house) >= 2;
}

export interface SeepDealResult {
  /** Deal number within the match (1-based). */
  dealNo: number;
  /** Card points + sweep bonuses per team for THIS deal. */
  teamScores: { 0: number; 1: number };
  /** Signed change applied to the running lead (winner-positive). */
  diff: number;
  /** Team that swept up the leftover loose cards. */
  leftoverTeam: SeepTeam | null;
  /** Baazi ended this deal: winner + reason. */
  baazi: { winnerTeam: SeepTeam; reason: 'lead' | 'minimum-points' } | null;
  /** Running signed lead AFTER this deal (before a baazi reset). */
  leadAfter: number;
  /** Baazi tally per team AFTER this deal. */
  baazisWonAfter: { 0: number; 1: number };
}

export interface SeepState {
  stateVersion: 2;
  gameId: 'seep';
  phase: SeepPhase;
  rules: SeepRules;
  players: GamePlayer[];
  hands: Record<string, Card[]>;
  /**
   * Loose cards on the floor. Face-DOWN (values hidden in views) until the
   * opening announce turns them up.
   */
  tableLoose: Card[];
  /** Face-up houses. Cards inside are owned by the house, not any player. */
  houses: SeepHouse[];
  deck: Card[];
  /** The bidder (player to the dealer's right) — announces and leads. */
  bidderSeat: number;
  /** The dealer this deal. */
  dealerSeat: number;
  /** Deal number within the match (1-based). */
  dealNo: number;
  /** The announced number (9–13); null until the announce. */
  bid: number | null;
  /** True until the rest of the deck is dealt (after the bidder's first play). */
  dealRestPending: boolean;
  /** Packets handed out when the deal resumed (event/view bookkeeping). */
  batchesDealt: number;
  /** Total plays made so far in the deal (sweep timing keys off this). */
  playsMade: number;
  /** Cards captured per player, in pickup order (face-down piles in views). */
  captures: Record<string, Card[]>;
  /** Completed sweeps per team this deal. */
  sweeps: { 0: number; 1: number };
  /** Sweep bonus points banked per team this deal (25 / 50 / 0). */
  sweepPoints: { 0: number; 1: number };
  /** Team of the last pick-up — leftover floor cards go to it at deal end. */
  lastCaptureTeam: SeepTeam | null;
  /** The most recent pick-up, for the until-next-play inspection window. */
  lastPickup: { playerId: string; cardIds: string[]; playsMade: number } | null;
  currentTurn: number;
  /** House id counter for stable ids. */
  houseSeq: number;
  /** Running signed lead across deals (positive = team 0 ahead). */
  baaziLead: number;
  /** Completed baazis per team. */
  baazisWon: { 0: number; 1: number };
  /** Results of completed deals in this match. */
  dealHistory: SeepDealResult[];
  /** Final team scores for THIS deal, set at DEAL_COMPLETE/MATCH_COMPLETE. */
  teamScores: { 0: number; 1: number } | null;
  /** Who won this deal on points (null = tie). */
  roundWinnerTeam: SeepTeam | null;
  /** How this deal ended for the match, when it did. */
  baaziWinnerTeam: SeepTeam | null;
  baaziReason: 'lead' | 'minimum-points' | null;
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
  /** Force the dealer (seat index; debug/tests). Defaults to seat 0. */
  dealerSeat?: number;
}

// ---------------------------------------------------------------------------
// Actions
// ---------------------------------------------------------------------------

/** The bidder announces a number 9–13 that they hold; the floor turns up. */
export type SeepAnnounceAction = { type: 'ANNOUNCE'; playerId: string; value: number };

/** What the player intends to do with the card they play this turn. */
export type SeepPlayIntent =
  /** Put the card on the floor (only legal when THIS card captures nothing). */
  | { kind: 'LAY_DOWN' }
  /**
   * Take ALL compulsory items matching the played value: every house of that
   * value plus one maximal collection of non-overlapping loose groups. Where
   * groups overlap, each distinct maximal collection is a separate legal
   * action (the player chooses).
   */
  | { kind: 'CAPTURE'; tableCardIds: string[]; houseIds: string[] }
  /**
    * Establish (or cement-merge into) a house of `total`: played card +
    * selected loose cards form ONE set totalling 9–13, and the player holds
    * another card of that total (retention). If a house of the total already
    * exists, the pile merges into it (cementing semantics).
   */
  | { kind: 'BUILD'; tableCardIds: string[]; total: number }
  /**
   * Cement/add to a house: played card (+ optional loose cards summing to
   * the remainder) forms another complete set of the house total. Opponents
   * cementing must retain and become co-owners; partners of the owner do not.
   */
  | { kind: 'ADD_TO_HOUSE'; houseId: string; tableCardIds: string[] }
  /**
   * Break a kachcha ghar you do not own: the played card raises its total
   * (total + value ≤ 13); you must hold the new total and become the owner.
   */
  | { kind: 'BREAK_HOUSE'; houseId: string };

export type SeepAction = SeepAnnounceAction | { type: 'PLAY_CARD'; playerId: string; cardId: string; intent: SeepPlayIntent };
