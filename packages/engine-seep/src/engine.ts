/**
 * Server-authoritative Seep (Sweep) engine.
 *
 * Pure state-machine over JSON state: no networking, no timers, no DOM.
 * All validation happens here — clients only ever send intentions.
 *
 * House-rule v1 highlights:
 *  - 4 players, fixed teams by seat parity (0&2 vs 1&3);
 *  - capture by exact value (single card or a set summing to it);
 *  - must-capture: if the played card can capture anything, it must;
 *  - houses (builds) are face-up obligations owned by the building team;
 *  - a seep — one play clearing the whole table — pays a bonus;
 *  - deal end: leftover loose cards go to the last capturing team, houses
 *    go to their owner team.
 */

import {
  standardDeck,
  shuffle,
  createRng,
  type Card,
  type GameAction,
  type GameEvent,
  type GamePlayer,
  type Rng,
} from '@game-night/shared';
import {
  captureValue,
  cardPoints,
  mergeSeepRules,
  reachableSubsetSum,
  teamOfSeat,
  type SeepRules,
  type SeepTeam,
} from './rules.js';
import type { SeepAction, SeepGameOptions, SeepHouse, SeepState } from './types.js';
import { buildPlayerView } from './views.js';

export type { SeepState } from './types.js';
export { teamOfSeat, reachableSubsetSum };

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

/** Does a card of value `v` have ANY capture on the current table? */
function captureExists(state: SeepState, v: number): boolean {
  if (state.tableLoose.some((c) => captureValue(c) === v)) return true;
  if (reachableSubsetSum(state.tableLoose, v)) return true;
  return state.houses.some((h) => h.total === v);
}

export class SeepEngine {
  readonly gameId = 'seep';
  readonly stateVersion = 1 as const;

  private state: SeepState | null = null;
  private rules: SeepRules = mergeSeepRules();
  private rng: Rng = createRng();

  getRules(): SeepRules {
    return this.rules;
  }

  getState(): SeepState {
    if (!this.state) INVALID('game not created');
    return this.state;
  }

  /** Restore a previously serialized state (reconnect / redis restore). */
  restoreState(state: SeepState, rules?: Partial<SeepRules>): void {
    if (state.stateVersion !== 1) INVALID('unsupported state version');
    this.state = state;
    this.rules = mergeSeepRules(rules);
    this.rng = createRng();
  }

  // -------------------------------------------------------------------
  // Lifecycle
  // -------------------------------------------------------------------

  createGame(players: GamePlayer[], options: SeepGameOptions = {}): void {
    this.rules = mergeSeepRules(options.rules);
    if (players.length !== 4) {
      INVALID(`seep requires exactly 4 players (2 partnerships)`);
    }
    const seats = [...players].sort((a, b) => a.seat - b.seat);
    this.rng = createRng(options.seed);

    const deck = options.forcedDeck ? options.forcedDeck.slice() : shuffle(standardDeck(), this.rng);
    const firstTurnSeat = options.firstTurnSeat ?? this.rng.int(seats.length);

    const state: SeepState = {
      stateVersion: 1,
      gameId: 'seep',
      phase: 'TURN_PLAY',
      players: seats,
      hands: {},
      tableLoose: [],
      houses: [],
      deck,
      batchesDealt: 0,
      captures: {},
      sweeps: { 0: 0, 1: 0 },
      lastCaptureTeam: null,
      currentTurn: firstTurnSeat,
      houseSeq: 0,
      teamScores: null,
      roundWinnerTeam: null,
      tiedTeams: [],
      events: [],
      revision: 1,
      eventSeq: 0,
    };
    for (const p of seats) {
      state.hands[p.id] = [];
      state.captures[p.id] = [];
    }
    this.state = state;

    this.emit('ROUND_STARTED', {
      playerIds: seats.map((p) => p.id),
      teams: { 0: seats.filter((_, i) => i % 2 === 0).map((p) => p.id), 1: seats.filter((_, i) => i % 2 === 1).map((p) => p.id) },
    });
    this.dealBatch();
    this.emit('TURN_STARTED', { playerId: this.currentPlayerId() });
  }

  /** Deal the next batch: `cardsPerBatch` to each player, round-robin. */
  private dealBatch(): void {
    const s = this.getState();
    const rules = this.rules;
    s.batchesDealt += 1;
    for (let round = 0; round < rules.cardsPerBatch; round++) {
      for (const p of s.players) {
        const card = s.deck.pop();
        if (!card) INVALID('deck exhausted while dealing');
        s.hands[p.id]!.push(card);
      }
    }
    // First batch also lays the starting table cards face-up.
    if (s.batchesDealt === 1) {
      for (let i = 0; i < rules.tableStartCards; i++) {
        const card = s.deck.pop();
        if (!card) INVALID('deck exhausted while dealing the table');
        s.tableLoose.push(card);
      }
    }
    this.emit('BATCH_DEALT', {
      batch: s.batchesDealt,
      handCounts: Object.fromEntries(s.players.map((p) => [p.id, s.hands[p.id]!.length])),
      tableIds: s.tableLoose.map((c) => c.id),
    });
  }

  // -------------------------------------------------------------------
  // Queries
  // -------------------------------------------------------------------

  isGameFinished(): boolean {
    return this.getState().phase === 'ROUND_COMPLETE';
  }

  /** Live team points (also used as the final score at ROUND_COMPLETE). */
  teamPoints(s: SeepState): { 0: number; 1: number } {
    const out: { 0: number; 1: number } = { 0: 0, 1: 0 };
    for (const p of s.players) {
      const team = teamOfSeat(p.seat);
      for (const c of s.captures[p.id] ?? []) out[team] += cardPoints(c, this.rules);
    }
    out[0] += s.sweeps[0] * this.rules.sweepBonus;
    out[1] += s.sweeps[1] * this.rules.sweepBonus;
    return out;
  }

  /** Per-player score map (partners share their team's points). */
  calculateScore(): Record<string, number> {
    const s = this.getState();
    const tp = s.teamScores ?? this.teamPoints(s);
    const out: Record<string, number> = {};
    for (const p of s.players) out[p.id] = tp[teamOfSeat(p.seat) as SeepTeam];
    return out;
  }

  getPublicState(): unknown {
    const s = this.getState();
    return {
      phase: s.phase,
      currentTurnPlayerId: s.players[s.currentTurn]?.id ?? null,
      deckCount: s.deck.length,
      batchesDealt: s.batchesDealt,
      looseCount: s.tableLoose.length,
      houseTotals: s.houses.map((h) => ({ id: h.id, total: h.total, ownerTeam: h.ownerTeam })),
      sweeps: { ...s.sweeps },
      teamPoints: this.teamPoints(s),
      revision: s.revision,
    };
  }

  getPlayerState(viewerId: string, opts?: { revealAll?: boolean }): import('./views.js').SeepPlayerView {
    return buildPlayerView(this.getState(), viewerId, this.rules, opts);
  }

  // -------------------------------------------------------------------
  // Actions
  // -------------------------------------------------------------------

  validateAction(action: GameAction): boolean {
    try {
      this.checkAction(action as SeepAction);
      return true;
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

  private currentPlayerId(): string {
    const s = this.getState();
    return s.players[s.currentTurn]?.id ?? INVALID('no current player');
  }

  private checkAction(a: SeepAction): void {
    const s = this.getState();
    const ids = s.players.map((p) => p.id);
    if (!ids.includes(a.playerId)) INVALID('player not in this game');
    switch (a.type) {
      case 'PLAY_CARD': {
        if (s.phase !== 'TURN_PLAY') INVALID('the deal is over');
        if (a.playerId !== this.currentPlayerId()) INVALID('not your turn');
        this.validatePlay(a);
        return;
      }
      default:
        INVALID(`unknown action type: ${(a as { type: string }).type}`);
    }
  }

  /** Full read-only validation of a play. Throws SeepEngineError. */
  private validatePlay(a: Extract<SeepAction, { type: 'PLAY_CARD' }>): void {
    const s = this.getState();
    const hand = s.hands[a.playerId] ?? [];
    const played = hand.find((c) => c.id === a.cardId);
    if (!played) INVALID('card not in your hand');
    const v = captureValue(played!);
    const intent = a.intent;
    if (!intent) INVALID('missing play intent');

    const hasCapture = captureExists(s, v);
    if (intent.kind === 'LAY_DOWN' || intent.kind === 'BUILD') {
      if (hasCapture) INVALID('you must capture when you can');
    }

    switch (intent.kind) {
      case 'LAY_DOWN':
        return;
      case 'CAPTURE': {
        const selected = this.selectedLooseCards(intent.tableCardIds);
        const sum = selected.reduce((acc, c) => acc + captureValue(c), 0);
        if (sum !== v) INVALID('selected cards do not sum to your card');
        return;
      }
      case 'CAPTURE_HOUSE': {
        const house = s.houses.find((h) => h.id === intent.houseId);
        if (!house) INVALID('no such house');
        if (house!.total !== v) INVALID('your card does not match the house total');
        return;
      }
      case 'BUILD': {
        const selected = this.selectedLooseCards(intent.tableCardIds);
        const total = v + selected.reduce((acc, c) => acc + captureValue(c), 0);
        if (intent.total !== total) INVALID('build total does not match the selection');
        if (total < 2 || total > 13) INVALID('house total must be between 2 and 13');
        const backing = hand.some((c) => c.id !== played!.id && captureValue(c) === total);
        if (!backing) INVALID('you must hold another card of the build total');
        return;
      }
      case 'RAISE_HOUSE': {
        const house = s.houses.find((h) => h.id === intent.houseId);
        if (!house) INVALID('no such house');
        if (house!.ownerTeam !== teamOfSeat(s.currentTurn)) INVALID('only your team may raise this house');
        if (house!.total !== v) INVALID('your card does not match the house total');
        const backing = hand.some((c) => c.id !== played!.id && captureValue(c) === v);
        if (!backing) INVALID('you must hold another card of the house total to raise');
        return;
      }
      default:
        INVALID('unknown play intent');
    }
  }

  /** Resolve + verify selected loose table cards (distinct, all present). */
  private selectedLooseCards(cardIds: string[]): Card[] {
    const s = this.getState();
    if (!Array.isArray(cardIds) || cardIds.length === 0) INVALID('no table cards selected');
    const seen = new Set<string>();
    const out: Card[] = [];
    for (const id of cardIds) {
      if (seen.has(id)) INVALID('duplicate table card in selection');
      seen.add(id);
      const card = s.tableLoose.find((c) => c.id === id);
      if (!card) INVALID('card not on the table');
      out.push(card);
    }
    return out;
  }

  private applyAction(a: SeepAction): void {
    this.checkAction(a);
    if (a.type !== 'PLAY_CARD') return;
    this.applyPlay(a);
  }

  private applyPlay(a: Extract<SeepAction, { type: 'PLAY_CARD' }>): void {
    const s = this.getState();
    const hand = s.hands[a.playerId]!;
    const idx = hand.findIndex((c) => c.id === a.cardId);
    const played = hand[idx]!;
    const team = teamOfSeat(s.players[s.currentTurn]!.seat);
    const intent = a.intent;

    // Remove the played card from the hand up front; every intent consumes it.
    hand.splice(idx, 1);

    switch (intent.kind) {
      case 'LAY_DOWN': {
        s.tableLoose.push(played);
        this.emit('PLAY_LAY', { playerId: a.playerId, cardId: played.id, value: captureValue(played) });
        break;
      }
      case 'CAPTURE': {
        const selected = this.selectedLooseCards(intent.tableCardIds);
        s.tableLoose = s.tableLoose.filter((c) => !intent.tableCardIds.includes(c.id));
        const pile = s.captures[a.playerId]!;
        pile.push(played, ...selected);
        s.lastCaptureTeam = team;
        this.emit('PLAY_CAPTURE', {
          playerId: a.playerId,
          cardId: played.id,
          capturedIds: selected.map((c) => c.id),
          capturedCount: selected.length + 1,
        });
        this.checkSweep(s, team, a.playerId);
        break;
      }
      case 'CAPTURE_HOUSE': {
        const house = s.houses.find((h) => h.id === intent.houseId)!;
        s.houses = s.houses.filter((h) => h.id !== house.id);
        const pile = s.captures[a.playerId]!;
        pile.push(played, ...house.cards);
        s.lastCaptureTeam = team;
        this.emit('PLAY_CAPTURE', {
          playerId: a.playerId,
          cardId: played.id,
          capturedIds: house.cards.map((c) => c.id),
          houseId: house.id,
          houseTotal: house.total,
          capturedCount: house.cards.length + 1,
        });
        this.checkSweep(s, team, a.playerId);
        break;
      }
      case 'BUILD': {
        const selected = this.selectedLooseCards(intent.tableCardIds);
        s.tableLoose = s.tableLoose.filter((c) => !intent.tableCardIds.includes(c.id));
        const house: SeepHouse = {
          id: `h-${++s.houseSeq}`,
          total: intent.total,
          ownerTeam: team,
          cards: [played, ...selected],
        };
        s.houses.push(house);
        this.emit('PLAY_BUILD', {
          playerId: a.playerId,
          cardId: played.id,
          houseId: house.id,
          total: house.total,
          joinedIds: house.cards.map((c) => c.id),
        });
        break;
      }
      case 'RAISE_HOUSE': {
        const house = s.houses.find((h) => h.id === intent.houseId)!;
        house.cards.push(played);
        this.emit('PLAY_RAISE', {
          playerId: a.playerId,
          cardId: played.id,
          houseId: house.id,
          total: house.total,
        });
        break;
      }
    }

    s.revision += 1;
    this.advanceAfterPlay();
  }

  /** After a play: sweep detection happened in the intent arm. */
  private checkSweep(s: SeepState, team: SeepTeam, playerId: string): void {
    if (s.tableLoose.length === 0 && s.houses.length === 0) {
      s.sweeps[team] += 1;
      this.emit('SEEP_SWEEP', { playerId, team, bonus: this.rules.sweepBonus });
    }
  }

  private advanceAfterPlay(): void {
    const s = this.getState();
    const allHandsEmpty = s.players.every((p) => (s.hands[p.id] ?? []).length === 0);
    if (allHandsEmpty) {
      const canDealMore =
        s.batchesDealt < this.rules.maxBatches &&
        s.deck.length >= s.players.length * this.rules.cardsPerBatch;
      if (canDealMore) {
        this.dealBatch();
      } else {
        this.finishDeal();
        return;
      }
    }
    s.currentTurn = (s.currentTurn + 1) % s.players.length;
    this.emit('TURN_STARTED', { playerId: this.currentPlayerId() });
  }

  /** Distribute leftovers and settle the final team scores. */
  private finishDeal(): void {
    const s = this.getState();
    const firstSeatOf = (team: SeepTeam): string | null =>
      s.players.find((p) => teamOfSeat(p.seat) === team)?.id ?? null;

    // Loose table cards go to the team that captured last (vanish if nobody
    // ever captured). Houses stay with their owner team.
    if (s.lastCaptureTeam !== null) {
      const receiver = firstSeatOf(s.lastCaptureTeam);
      if (receiver) (s.captures[receiver] ??= []).push(...s.tableLoose);
    }
    s.tableLoose = [];
    for (const house of s.houses) {
      const receiver = firstSeatOf(house.ownerTeam);
      if (receiver) (s.captures[receiver] ??= []).push(...house.cards);
    }
    s.houses = [];

    const tp = this.teamPoints(s);
    s.teamScores = tp;
    s.roundWinnerTeam = tp[0] > tp[1] ? 0 : tp[1] > tp[0] ? 1 : null;
    s.tiedTeams = s.roundWinnerTeam === null ? [0, 1] : [];
    s.phase = 'ROUND_COMPLETE';
    s.revision += 1;
    this.emit('ROUND_COMPLETE', {
      teamScores: tp,
      winnerTeam: s.roundWinnerTeam,
      tiedTeams: s.tiedTeams,
      sweeps: { ...s.sweeps },
    });
  }

  // -------------------------------------------------------------------
  // Infrastructure
  // -------------------------------------------------------------------

  private emit(type: string, payload?: Record<string, unknown>): void {
    const s = this.getState();
    s.events.push({
      seq: ++s.eventSeq,
      type,
      timestamp: new Date().toISOString(),
      payload,
    });
    s.revision += 1;
  }
}
