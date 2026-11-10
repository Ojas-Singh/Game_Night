/**
 * Server-authoritative Seep (Sweep), played by the rules core — canonical
 * Punjabi 100-point rules. Contract: docs/rules/seep-punjabi-100.md.
 *
 * The core (`core/gamelab`, loaded through `@game-night/core`) holds the
 * match and decides every action. This class names players, cards and
 * houses, keeps the state in the shape the views read, and writes the event
 * log.
 *
 * The rules in short:
 *  - 4 players, fixed teams by seat parity; deal & play COUNTER-CLOCKWISE;
 *  - dealer deals 4 to the bidder (to his right) + 4 face-down floor cards;
 *    the bidder announces 9–13 (auto-redeal while impossible, no penalty);
 *  - the floor turns up; the bidder's FIRST play must involve the bid
 *    (build it / capture with the bid card / throw the bid card);
 *  - the dealer then completes the deal in counter-clockwise packets of
 *    four — bidder ends the rest-deal holding 11 (he plays 12 in all); 48 plays per deal;
 *  - a card NOT used in a house must take everything it can: every house of
 *    its value plus a maximal collection of non-overlapping loose groups
 *    (overlapping alternatives are enumerated as distinct choices);
 *  - houses are 9–13, one per total; copies = Σvalues/total; copies ≥ 2 is
 *    pakka (unbreakable). Owners (both teams can own) must retain a card of
 *    the total. Building into an existing total merges; loose cards of the
 *    total (or a set summing to it) auto-cement; breaking transfers
 *    ownership to the breaker;
 *  - sweeps: +25 on the very first play, +50 otherwise, 0 on the final card;
 *  - deal end: leftover floor cards go to the team that picked up last;
 *  - baazi match: only the signed deal difference accumulates; a side wins
 *    at a lead of 100 — or instantly when the opponent scores fewer than 9
 *    points in a deal.
 */

import { apply, check, deal, load, type Round } from '@game-night/core';
import { SUITS, standardDeck, type Card, type GameAction, type GameEvent, type GamePlayer } from '@game-night/shared';
import {
  captureValue,
  cardPoints,
  mergeSeepRules,
  maximalCaptureAlternatives,
  nextSeatCCW,
  partitionableInto,
  reachableSubsetSum,
  teamOfSeat,
  type SeepRules,
  type SeepTeam,
} from './rules.js';
import type { SeepAction, SeepDealResult, SeepGameOptions, SeepHouse, SeepPhase, SeepState } from './types.js';
import { buildPlayerView } from './views.js';

export type { SeepState, SeepHouse, houseCopies, houseIsPakka } from './types.js';
export { teamOfSeat, reachableSubsetSum, partitionableInto, maximalCaptureAlternatives, nextSeatCCW };

export class SeepEngineError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SeepEngineError';
  }
}

function INVALID(msg: string): never {
  throw new SeepEngineError(msg);
}

/** Lightweight structured warn (no card values / secrets). */
function logWarn(msg: string, fields?: Record<string, unknown>): void {
  // eslint-disable-next-line no-console
  console.warn(JSON.stringify({ ts: new Date().toISOString(), level: 'warn', msg, ...fields }));
}

/**
 * Cards dealt into each hand by the end of the deal-rest: the bidder holds
 * 11 (one of his 12 went down before the rest was dealt), the others 12 —
 * every player plays 12 cards: 48 plays, all 52 cards in play.
 */
const CARDS_PER_PLAYER = 12;

type CoreReason = 'Lead' | 'MinimumPoints';

/** The match as `Round.save` writes it (the fields used here). */
interface CoreGame {
  phase: 'Announce' | 'TurnPlay' | 'DealComplete' | 'MatchComplete';
  hands: number[][];
  loose: number[];
  houses: Array<{ id: number; total: number; owners: [number | null, number | null]; cards: number[] }>;
  deck: number[];
  bidder: number;
  dealer: number;
  deal_no: number;
  bid: number | null;
  deal_rest_pending: boolean;
  batches_dealt: number;
  redeals: number;
  plays_made: number;
  captures: number[][];
  sweeps: [number, number];
  sweep_points: [number, number];
  last_capture_team: SeepTeam | null;
  last_pickup: { seat: number; cards: number[]; plays_made: number } | null;
  turn: number;
  house_seq: number;
  baazi_lead: number;
  baazis_won: [number, number];
  deal_history: Array<{
    deal_no: number;
    team_scores: [number, number];
    diff: number;
    leftover_team: SeepTeam | null;
    baazi: [SeepTeam, CoreReason] | null;
    lead_after: number;
    baazis_won_after: [number, number];
  }>;
  team_scores: [number, number] | null;
  round_winner: SeepTeam | null;
  baazi_winner: SeepTeam | null;
  baazi_reason: CoreReason | null;
  event_seq: number;
  revision: number;
  log: Array<Record<string, { dealer?: number }>>;
}

interface CoreSave {
  rules: SeepRules;
  game: CoreGame;
}

/** A play in the core's terms: the hand card by its place in the hand, loose
 *  cards as a mask over the floor, a house by its total. */
type CoreAction =
  | { type: 'ANNOUNCE'; value: number }
  | { type: 'LAY'; card: number }
  | { type: 'CAPTURE'; card: number; loose: number }
  | { type: 'BUILD'; card: number; loose: number; total: number }
  | { type: 'ADD'; card: number; total: number; loose: number }
  | { type: 'BREAK'; card: number; total: number }
  | { type: 'NEXT_DEAL' };

const PHASES: Record<CoreGame['phase'], SeepPhase> = {
  Announce: 'ANNOUNCE',
  TurnPlay: 'TURN_PLAY',
  DealComplete: 'DEAL_COMPLETE',
  MatchComplete: 'MATCH_COMPLETE',
};

const REASONS = { Lead: 'lead', MinimumPoints: 'minimum-points' } as const;

const pair = <T>(a: [T, T]): { 0: T; 1: T } => ({ 0: a[0], 1: a[1] });

const isPakka = (cards: Card[], total: number): boolean =>
  Math.round(cards.reduce((acc, c) => acc + c.rank, 0) / total) >= 2;

export class SeepEngine {
  readonly gameId = 'seep';
  readonly stateVersion = 3 as const;

  private state: SeepState | null = null;
  private round: Round | null = null;
  private rules: SeepRules = mergeSeepRules();
  /** A forced deck as core card numbers; every deal of the match uses it. */
  private forced: number[] | null = null;

  getRules(): SeepRules {
    return this.rules;
  }

  getState(): SeepState {
    if (!this.state) INVALID('game not created');
    return this.state;
  }

  /** Restore a previously serialized state (reconnect / redis restore). The
   *  match continues from `state.core`. */
  restoreState(state: SeepState): void {
    if (state.stateVersion !== 3) INVALID('unsupported state version');
    try {
      this.round = load('seep', state.core);
    } catch (err) {
      INVALID(String((err as Error).message ?? err));
    }
    this.rules = (state.core as CoreSave).rules;
    this.forced = null;
    this.state = state;
    this.refresh();
  }

  // -------------------------------------------------------------------
  // Lifecycle
  // -------------------------------------------------------------------

  createGame(players: GamePlayer[], options: SeepGameOptions = {}): void {
    const rules = mergeSeepRules(options.rules);
    if (players.length !== 4) {
      INVALID(`seep requires exactly 4 players (2 partnerships)`);
    }
    const seats = [...players].sort((a, b) => a.seat - b.seat);

    let round: Round;
    try {
      round = deal('seep', rules, seats.length, options.seed);
    } catch (err) {
      INVALID(String((err as Error).message ?? err));
    }
    let cards: Record<string, Card> = {};
    this.forced = options.forcedDeck ? this.numberForced(options.forcedDeck, cards) : null;

    if (this.forced || options.dealerSeat !== undefined) {
      const saved = JSON.parse(round.save()) as CoreSave;
      const g = saved.game;
      const dealer = options.dealerSeat;
      if (dealer !== undefined) {
        if (!Number.isInteger(dealer) || dealer < 0 || dealer > 3) INVALID('no such dealer seat');
        const opening = g.hands[g.bidder]!;
        g.hands[g.bidder] = [];
        g.dealer = dealer;
        g.bidder = nextSeatCCW(dealer);
        g.turn = g.bidder;
        g.hands[g.bidder] = opening;
        for (const entry of g.log) {
          if (entry.DealStarted) entry.DealStarted.dealer = dealer;
        }
      }
      round = this.reload(saved);
    }
    if (!this.forced) cards = this.nameCards(round);

    this.round = round;
    this.rules = rules;
    this.state = {
      stateVersion: 3,
      gameId: 'seep',
      core: null,
      cards,
      phase: 'ANNOUNCE',
      rules,
      players: seats,
      hands: {},
      tableLoose: [],
      houses: [],
      deck: [],
      bidderSeat: 0,
      dealerSeat: 0,
      dealNo: 0,
      bid: null,
      dealRestPending: true,
      batchesDealt: 0,
      playsMade: 0,
      captures: {},
      sweeps: { 0: 0, 1: 0 },
      sweepPoints: { 0: 0, 1: 0 },
      lastCaptureTeam: null,
      lastPickup: null,
      currentTurn: 0,
      houseSeq: 0,
      baaziLead: 0,
      baazisWon: { 0: 0, 1: 0 },
      dealHistory: [],
      teamScores: null,
      roundWinnerTeam: null,
      baaziWinnerTeam: null,
      baaziReason: null,
      tiedTeams: [],
      events: [],
      revision: 1,
      eventSeq: 0,
    };
    this.refresh();
    this.emit('MATCH_STARTED', {
      playerIds: seats.map((p) => p.id),
      teams: {
        0: seats.filter((p) => teamOfSeat(p.seat) === 0).map((p) => p.id),
        1: seats.filter((p) => teamOfSeat(p.seat) === 1).map((p) => p.id),
      },
    });
    this.emitDealStarted();
  }

  /** Core numbers for a forced deck: each card keeps its face (points go by
   *  suit), a second card of a face takes that face in the next deck. */
  private numberForced(deck: Card[], cards: Record<string, Card>): number[] {
    if (deck.length < 52) INVALID('a forced deck needs all 52 cards');
    return deck.map((card) => {
      for (let copy = 0; copy < 3; copy++) {
        const n = copy * 52 + SUITS.indexOf(card.suit) * 13 + card.rank - 1;
        if (n < 128 && !(n in cards)) {
          cards[n] = card;
          return n;
        }
      }
      INVALID('too many copies of one card in the forced deck');
    });
  }

  /**
   * The cards of a fresh deal, each named by its place in the shuffled deck.
   * Ids go to every client, so they must not tell the card.
   */
  private nameCards(round: Round): Record<string, Card> {
    const g = (JSON.parse(round.save()) as CoreSave).game;
    const faces = standardDeck();
    const dealt = [...g.deck, ...[...g.loose].reverse(), ...[...g.hands[g.bidder]!].reverse()];
    return Object.fromEntries(dealt.map((n, i) => [n, { ...faces[n % 52]!, id: `c-${i}` }]));
  }

  /** The saved match as a round again, dealt from the forced deck if there
   *  is one (used verbatim: fixtures must give the bidder a card to announce). */
  private reload(saved: CoreSave): Round {
    const g = saved.game;
    if (this.forced) {
      const deck = [...this.forced];
      g.hands = [[], [], [], []];
      g.loose = [];
      for (let i = 0; i < saved.rules.openingHandCards; i++) g.hands[g.bidder]!.push(deck.pop()!);
      for (let i = 0; i < saved.rules.tableStartCards; i++) g.loose.push(deck.pop()!);
      g.deck = deck;
      if (g.redeals > 0) {
        g.redeals = 0;
        g.event_seq -= 1;
        g.revision -= 1;
      }
    }
    try {
      return load('seep', saved);
    } catch (err) {
      INVALID(String((err as Error).message ?? err));
    }
  }

  /**
   * Deal the next hand of a live baazi (phase DEAL_COMPLETE). While the
   * dealing team is behind or level the same dealer deals again; when the
   * dealing team is winning, the deal passes to the next player to the right.
   */
  nextDeal(): void {
    const s = this.getState();
    if (s.phase !== 'DEAL_COMPLETE') {
      INVALID(s.phase === 'MATCH_COMPLETE' ? 'the baazi is over' : 'the current deal is still running');
    }
    const refused = apply(this.round!, 0, { type: 'NEXT_DEAL' } satisfies CoreAction);
    if (refused !== null) INVALID(refused);
    if (this.forced) this.round = this.reload(JSON.parse(this.round!.save()) as CoreSave);
    else s.cards = this.nameCards(this.round!);
    this.refresh();
    this.emitDealStarted();
  }

  // -------------------------------------------------------------------
  // Queries
  // -------------------------------------------------------------------

  isGameFinished(): boolean {
    return this.getState().phase === 'MATCH_COMPLETE';
  }

  /** Live team points this deal: card points + banked sweep bonuses. */
  teamPoints(s: SeepState): { 0: number; 1: number } {
    const out: { 0: number; 1: number } = { 0: 0, 1: 0 };
    for (const p of s.players) {
      const team = teamOfSeat(p.seat);
      for (const c of s.captures[p.id] ?? []) out[team] += cardPoints(c, this.rules);
    }
    out[0] += s.sweepPoints[0];
    out[1] += s.sweepPoints[1];
    return out;
  }

  /** Per-player score map — for Seep this is BAAZIS WON (partners share). */
  calculateScore(): Record<string, number> {
    const s = this.getState();
    const out: Record<string, number> = {};
    for (const p of s.players) out[p.id] = s.baazisWon[teamOfSeat(p.seat)];
    return out;
  }

  getPublicState(): unknown {
    const s = this.getState();
    return {
      phase: s.phase,
      currentTurnPlayerId: s.players[s.currentTurn]?.id ?? null,
      dealerId: s.players[s.dealerSeat]?.id ?? null,
      bidderId: s.players[s.bidderSeat]?.id ?? null,
      dealNo: s.dealNo,
      bid: s.bid,
      deckCount: s.deck.length,
      playsMade: s.playsMade,
      looseCount: s.bid === null ? 0 : s.tableLoose.length,
      houseTotals: s.houses.map((h) => ({ id: h.id, total: h.total, owners: h.ownerByTeam })),
      sweeps: { ...s.sweeps },
      teamPoints: this.teamPoints(s),
      baaziLead: s.baaziLead,
      baazisWon: { ...s.baazisWon },
      revision: s.revision,
    };
  }

  getSpectatorView(): ReturnType<typeof buildPlayerView> {
    return buildPlayerView(this.getState(), '__spectator__', this.rules);
  }

  getPlayerState(viewerId: string, opts?: { revealAll?: boolean }): import('./views.js').SeepPlayerView {
    return buildPlayerView(this.getState(), viewerId, this.rules, opts);
  }

  // -------------------------------------------------------------------
  // Actions
  // -------------------------------------------------------------------

  validateAction(action: GameAction): boolean {
    try {
      const { seat, action: move } = this.translate(action as SeepAction);
      return check(this.round!, seat, move) === null;
    } catch {
      return false;
    }
  }

  handleAction(action: GameAction): { ok: boolean; error?: string; events: GameEvent[] } {
    const before = this.getState().eventSeq;
    try {
      this.applyAction(action as SeepAction);
    } catch (err) {
      if (err instanceof SeepEngineError) {
        return { ok: false, error: err.message, events: [] };
      }
      // Malformed/unknown action shape: never leak a raw JS TypeError to the
      // client. Report it as a plain invalid action and log for debugging.
      logWarn('invalid_action_shape', { type: (action as { type?: string }).type, error: String(err) });
      return { ok: false, error: 'invalid action', events: [] };
    }
    const s = this.getState();
    return { ok: true, events: s.events.filter((e) => e.seq > before) };
  }

  /** Deal the next hand of the match (host action between deals). */
  handleNextDeal(playerId: string): { ok: boolean; error?: string; events: GameEvent[] } {
    const before = this.getState().eventSeq;
    try {
      const s = this.getState();
      const host = s.players.some((p) => p.id === playerId);
      if (!host) INVALID('player not in this game');
      this.nextDeal();
    } catch (err) {
      if (err instanceof SeepEngineError) {
        return { ok: false, error: err.message, events: [] };
      }
      logWarn('invalid_next_deal', { playerId, error: String(err) });
      return { ok: false, error: 'invalid action', events: [] };
    }
    const s = this.getState();
    return { ok: true, events: s.events.filter((e) => e.seq > before) };
  }

  // -------------------------------------------------------------------
  // Internals
  // -------------------------------------------------------------------

  private currentPlayerId(): string {
    const s = this.getState();
    return s.players[s.currentTurn]?.id ?? INVALID('no current player');
  }

  /** Selected loose cards (distinct, all on the floor) as the core's mask. */
  private looseMask(cardIds: string[]): number {
    const s = this.getState();
    if (!Array.isArray(cardIds)) INVALID('invalid table card selection');
    const seen = new Set<string>();
    let mask = 0;
    for (const id of cardIds) {
      if (seen.has(id)) INVALID('duplicate table card in selection');
      seen.add(id);
      const at = s.tableLoose.findIndex((c) => c.id === id);
      if (at < 0) INVALID('card not on the table');
      mask |= 1 << at;
    }
    return mask >>> 0;
  }

  /**
   * The action in the core's terms. What the core cannot be asked — a player,
   * card or house it has no name for, or a move out of turn — is refused
   * here; the rules of the play itself are the core's to judge.
   */
/** The round in the rules core, as it stands (for the model seat; do not change it). */
  get table(): Round {
    return this.round ?? INVALID('game not started');
  }

  /** An action of the rules core, by `seat`, as the action the table takes. */
  fromCore(seat: number, move: unknown): SeepAction {
    const s = this.getState();
    const m = move as CoreAction;
    const playerId = s.players[seat]?.id ?? INVALID('player not in this game');
    if (m.type === 'ANNOUNCE') return { type: 'ANNOUNCE', playerId, value: m.value };
    if (m.type === 'NEXT_DEAL') INVALID('the next deal is not a player action');
    const card = (s.hands[playerId] ?? [])[m.card] ?? INVALID('card not in your hand');
    const loose = (mask: number): string[] =>
      s.tableLoose.filter((_, i) => (mask >>> i) & 1).map((c) => c.id);
    const houseOf = (total: number): string => s.houses.find((h) => h.total === total)?.id ?? INVALID('no such house');
    const play = (intent: Extract<SeepAction, { type: 'PLAY_CARD' }>['intent']): SeepAction => ({
      type: 'PLAY_CARD',
      playerId,
      cardId: card.id,
      intent,
    });
    switch (m.type) {
      case 'LAY':
        return play({ kind: 'LAY_DOWN' });
      case 'CAPTURE': {
        const v = captureValue(card);
        return play({
          kind: 'CAPTURE',
          tableCardIds: loose(m.loose),
          houseIds: s.houses.filter((h) => h.total === v).map((h) => h.id),
        });
      }
      case 'BUILD':
        return play({ kind: 'BUILD', tableCardIds: loose(m.loose), total: m.total });
      case 'ADD':
        return play({ kind: 'ADD_TO_HOUSE', houseId: houseOf(m.total), tableCardIds: loose(m.loose) });
      case 'BREAK':
        return play({ kind: 'BREAK_HOUSE', houseId: houseOf(m.total) });
      default:
        return INVALID(`unknown action type: ${(m as { type: string }).type}`);
    }
  }

    private translate(a: SeepAction): { seat: number; action: CoreAction } {
    const s = this.getState();
    const seat = s.players.findIndex((p) => p.id === a.playerId);
    if (seat < 0) INVALID('player not in this game');
    switch (a.type) {
      case 'ANNOUNCE': {
        if (s.phase !== 'ANNOUNCE') INVALID('the number has already been announced');
        if (a.playerId !== this.currentPlayerId()) INVALID('only the bidder announces');
        const value = a.value;
        if (!Number.isInteger(value) || value < this.rules.minHouseTotal || value > this.rules.maxHouseTotal) {
          INVALID(`announce a number between ${this.rules.minHouseTotal} and ${this.rules.maxHouseTotal}`);
        }
        return { seat, action: { type: 'ANNOUNCE', value } };
      }
      case 'PLAY_CARD': {
        if (s.phase !== 'TURN_PLAY') INVALID(s.phase === 'ANNOUNCE' ? 'announce a number first' : 'the deal is over');
        if (a.playerId !== this.currentPlayerId()) INVALID('not your turn');
        const hand = s.hands[a.playerId] ?? [];
        const card = hand.findIndex((c) => c.id === a.cardId);
        if (card < 0) INVALID('card not in your hand');
        const v = captureValue(hand[card]!);
        const intent = a.intent;
        if (!intent) INVALID('missing play intent');
        switch (intent.kind) {
          case 'LAY_DOWN':
            return { seat, action: { type: 'LAY', card } };
          case 'CAPTURE': {
            const houseIds = intent.houseIds ?? [];
            const looseIds = intent.tableCardIds ?? [];
            if (looseIds.length === 0 && houseIds.length === 0) INVALID('select something to capture');
            // Houses of the played value are ALL compulsory; the core takes them.
            const matching = s.houses.filter((h) => h.total === v);
            if (matching.length !== houseIds.length) INVALID('a card must take every ghar it matches');
            for (const houseId of houseIds) {
              if (!matching.some((h) => h.id === houseId)) INVALID('your card does not match that house total');
            }
            return { seat, action: { type: 'CAPTURE', card, loose: this.looseMask(looseIds) } };
          }
          case 'BUILD': {
            const loose = this.looseMask(intent.tableCardIds);
            const total = intent.total;
            if (!Number.isInteger(total) || total < this.rules.minHouseTotal || total > this.rules.maxHouseTotal) {
              INVALID(`a ghar must total between ${this.rules.minHouseTotal} and ${this.rules.maxHouseTotal}`);
            }
            return { seat, action: { type: 'BUILD', card, loose, total } };
          }
          case 'ADD_TO_HOUSE': {
            const house = s.houses.find((h) => h.id === intent.houseId) ?? INVALID('no such house');
            return { seat, action: { type: 'ADD', card, total: house.total, loose: this.looseMask(intent.tableCardIds ?? []) } };
          }
          case 'BREAK_HOUSE': {
            const house = s.houses.find((h) => h.id === intent.houseId) ?? INVALID('no such house');
            return { seat, action: { type: 'BREAK', card, total: house.total } };
          }
          default:
            INVALID('unknown play intent');
        }
      }
      // eslint-disable-next-line no-fallthrough
      default:
        INVALID(`unknown action type: ${(a as { type: string }).type}`);
    }
  }

  private applyAction(a: SeepAction): void {
    const { seat, action } = this.translate(a);
    const s = this.getState();
    // The table as it stood: `refresh` replaces these, it does not change them.
    const hand = s.hands[a.playerId]!;
    const floor = s.tableLoose;
    const houses = s.houses;
    const restPending = s.dealRestPending;
    const sweepPoints = s.sweepPoints;
    const sweeps = s.sweeps;

    const refused = apply(this.round!, seat, action);
    if (refused !== null) INVALID(refused);
    this.refresh();

    if (a.type === 'ANNOUNCE') {
      this.emit('BID_ANNOUNCED', { playerId: a.playerId, value: a.value });
      this.emit('TURN_STARTED', { playerId: this.currentPlayerId() });
      return;
    }

    const played = hand.find((c) => c.id === a.cardId)!;
    const team = teamOfSeat(seat);
    const intent = a.intent;
    /** The chosen loose cards, in floor order (the order the core moves them in). */
    const chosen = (ids: string[] | undefined): Card[] => floor.filter((c) => (ids ?? []).includes(c.id));
    const without = (cards: Card[]): Card[] => floor.filter((c) => !cards.includes(c));

    switch (intent.kind) {
      case 'LAY_DOWN': {
        this.emit('PLAY_LAY', { playerId: a.playerId, cardId: played.id, value: captureValue(played) });
        break;
      }
      case 'CAPTURE': {
        const capturedIds = s.lastPickup!.cardIds;
        this.emit('PLAY_CAPTURE', {
          playerId: a.playerId,
          cardId: played.id,
          capturedIds,
          houseIds: intent.houseIds ?? [],
          capturedCount: capturedIds.length,
        });
        if (s.sweeps[team] > sweeps[team]) {
          this.emit('SEEP_SWEEP', { playerId: a.playerId, team, bonus: s.sweepPoints[team] - sweepPoints[team] });
        }
        break;
      }
      case 'BUILD': {
        const selected = chosen(intent.tableCardIds);
        const joined = [played, ...selected];
        const existing = houses.find((h) => h.total === intent.total);
        const houseId = existing?.id ?? `h-${(s.core as CoreSave).game.house_seq}`;
        this.emit('PLAY_BUILD', {
          playerId: a.playerId,
          cardId: played.id,
          houseId,
          total: intent.total,
          merged: !!existing,
          joinedIds: joined.map((c) => c.id),
        });
        this.emitCemented(houseId, intent.total, [...(existing?.cards ?? []), ...joined], without(selected));
        break;
      }
      case 'ADD_TO_HOUSE': {
        const house = houses.find((h) => h.id === intent.houseId)!;
        const selected = chosen(intent.tableCardIds);
        const owners = { ...house.ownerByTeam };
        // cementing an opponent-owned house: become a second owner
        owners[team] ??= a.playerId;
        this.emit('PLAY_ADD', {
          playerId: a.playerId,
          cardId: played.id,
          houseId: house.id,
          total: house.total,
          pakka: isPakka([...house.cards, played, ...selected], house.total),
          owners,
          joinedIds: [played.id, ...selected.map((c) => c.id)],
        });
        break;
      }
      case 'BREAK_HOUSE': {
        const house = houses.find((h) => h.id === intent.houseId)!;
        const toTotal = house.total + captureValue(played);
        // The breaker takes over the house; one that already has the new
        // total joins it and its owners stay.
        const twin = houses.find((h) => h.id !== house.id && h.total === toTotal);
        const owners: SeepHouse['ownerByTeam'] = { [team]: a.playerId };
        for (const t of [0, 1] as const) {
          if (owners[t] === undefined && twin?.ownerByTeam[t] !== undefined) owners[t] = twin.ownerByTeam[t];
        }
        this.emit('PLAY_BREAK', {
          playerId: a.playerId,
          cardId: played.id,
          houseId: house.id,
          fromTotal: house.total,
          toTotal,
          merged: !!twin,
          owners,
        });
        this.emitCemented(house.id, toTotal, [...house.cards, played, ...(twin?.cards ?? [])], floor);
        break;
      }
    }

    if (restPending) this.emitBatches(Object.fromEntries(s.players.map((p) => [p.id, (p.id === a.playerId ? hand.length - 1 : 0)])));
    if (s.phase === 'TURN_PLAY') {
      this.emit('TURN_STARTED', { playerId: this.currentPlayerId() });
      return;
    }
    const baazi = s.dealHistory[s.dealHistory.length - 1]!.baazi;
    this.emit('DEAL_COMPLETE', {
      dealNo: s.dealNo,
      teamScores: { ...s.teamScores! },
      winnerTeam: s.roundWinnerTeam,
      tiedTeams: s.tiedTeams,
      sweeps: { ...s.sweeps },
      baaziLead: s.baaziLead,
      baazisWon: { ...s.baazisWon },
      baazi,
      leftoverTeam: s.lastCaptureTeam,
    });
    if (baazi) {
      this.emit('MATCH_COMPLETE', {
        winnerTeam: baazi.winnerTeam,
        reason: baazi.reason,
        baazisWon: { ...s.baazisWon },
      });
    }
  }

  private emitDealStarted(): void {
    const s = this.getState();
    this.emit('DEAL_STARTED', {
      dealNo: s.dealNo,
      dealerId: s.players[s.dealerSeat]!.id,
      bidderId: s.players[s.bidderSeat]!.id,
      baaziLead: s.baaziLead,
      baazisWon: { ...s.baazisWon },
    });
    const redeals = (s.core as CoreSave).game.redeals;
    if (redeals > 0) this.emit('REDEAL', { redeals });
    this.emit('TURN_STARTED', { playerId: this.currentPlayerId() });
  }

  /**
   * The floor can never hold a loose card of a standing house's value: after
   * a build or a break, loose cards of the total — then one maximal choice
   * of loose sets summing to it — join the house by themselves. `cards` is
   * the house and `floor` the loose cards as the play left them.
   */
  private emitCemented(houseId: string, total: number, cards: Card[], floor: Card[]): void {
    const absorbed = floor.filter((c) => c.rank === total);
    const rest = floor.filter((c) => c.rank !== total);
    const sets = maximalCaptureAlternatives(rest, total)[0];
    if (sets) absorbed.push(...sets.flat().map((i) => rest[i]!));
    if (absorbed.length === 0) return;
    this.emit('HOUSE_CEMENTED', {
      houseId,
      total,
      absorbedIds: absorbed.map((c) => c.id),
      pakka: isPakka([...cards, ...absorbed], total),
    });
  }

  /**
   * The rest of the deal, as it went out after the bidder's first play:
   * counter-clockwise packets of `cardsPerBatch` starting at the bidder —
   * the bidder ends with 11 (they already played one), everyone else 12.
   */
  private emitBatches(handCounts: Record<string, number>): void {
    const s = this.getState();
    const bidderId = s.players[s.bidderSeat]!.id;
    const order: string[] = [];
    for (let seat = s.bidderSeat, i = 0; i < s.players.length; i++) {
      order.push(s.players[seat]!.id);
      seat = nextSeatCCW(seat);
    }
    const tableIds = s.tableLoose.map((c) => c.id);
    for (let round = 1; round <= s.batchesDealt; round++) {
      for (const id of order) {
        const target = id === bidderId ? CARDS_PER_PLAYER - 1 : CARDS_PER_PLAYER;
        handCounts[id] = Math.min(target, handCounts[id]! + this.rules.cardsPerBatch);
      }
      this.emit('BATCH_DEALT', { batch: round, round, handCounts: { ...handCounts }, tableIds });
    }
  }

  /** Rewrite the table's view of the match from the core's. */
  private refresh(): void {
    const s = this.getState();
    const saved = JSON.parse(this.round!.save()) as CoreSave;
    const g = saved.game;
    const card = (n: number): Card => s.cards[n] ?? INVALID('the saved match holds an unknown card');
    const id = (seat: number): string => s.players[seat]!.id;
    const byPlayer = (piles: number[][]): Record<string, Card[]> =>
      Object.fromEntries(s.players.map((p, i) => [p.id, piles[i]!.map(card)]));
    const baazi = (b: [SeepTeam, CoreReason] | null): SeepDealResult['baazi'] =>
      b ? { winnerTeam: b[0], reason: REASONS[b[1]] } : null;

    s.core = saved;
    s.rules = this.rules;
    s.phase = PHASES[g.phase];
    s.hands = byPlayer(g.hands);
    s.tableLoose = g.loose.map(card);
    s.houses = g.houses.map((h) => {
      const ownerByTeam: SeepHouse['ownerByTeam'] = {};
      for (const t of [0, 1] as const) {
        const seat = h.owners[t];
        if (seat !== null) ownerByTeam[t] = id(seat);
      }
      return { id: `h-${h.id}`, total: h.total, ownerByTeam, cards: h.cards.map(card) };
    });
    s.deck = g.deck.map(card);
    s.bidderSeat = g.bidder;
    s.dealerSeat = g.dealer;
    s.dealNo = g.deal_no;
    s.bid = g.bid;
    s.dealRestPending = g.deal_rest_pending;
    s.batchesDealt = g.batches_dealt;
    s.playsMade = g.plays_made;
    s.captures = byPlayer(g.captures);
    s.sweeps = pair(g.sweeps);
    s.sweepPoints = pair(g.sweep_points);
    s.lastCaptureTeam = g.last_capture_team;
    s.lastPickup = g.last_pickup
      ? { playerId: id(g.last_pickup.seat), cardIds: g.last_pickup.cards.map((n) => card(n).id), playsMade: g.last_pickup.plays_made }
      : null;
    s.currentTurn = g.turn;
    s.houseSeq = g.house_seq;
    s.baaziLead = g.baazi_lead;
    s.baazisWon = pair(g.baazis_won);
    s.dealHistory = g.deal_history.map((d) => ({
      dealNo: d.deal_no,
      teamScores: pair(d.team_scores),
      diff: d.diff,
      leftoverTeam: d.leftover_team,
      baazi: baazi(d.baazi),
      leadAfter: d.lead_after,
      baazisWonAfter: pair(d.baazis_won_after),
    }));
    s.teamScores = g.team_scores ? pair(g.team_scores) : null;
    s.roundWinnerTeam = g.round_winner;
    s.baaziWinnerTeam = g.baazi_winner;
    s.baaziReason = g.baazi_reason ? REASONS[g.baazi_reason] : null;
    s.tiedTeams = g.team_scores && g.round_winner === null ? [0, 1] : [];
    s.revision = g.revision;
  }

  private emit(type: string, payload?: Record<string, unknown>): void {
    const s = this.getState();
    s.events.push({
      seq: ++s.eventSeq,
      type,
      timestamp: new Date().toISOString(),
      payload,
    });
  }
}
