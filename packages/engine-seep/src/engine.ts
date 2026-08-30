/**
 * Server-authoritative Seep (Sweep) engine — Punjabi rules.
 *
 * Pure state-machine over JSON state: no networking, no timers, no DOM.
 * All validation happens here — clients only ever send intentions.
 *
 * Ruleset implemented:
 *  - 4 players, fixed teams by seat parity (partners sit opposite);
 *  - the opener receives 4 cards and 4 go face-down to the table; the opener
 *    announces a number 9–13 they hold (auto-redeal if all cards are ≤ 8);
 *  - the table turns up and the opener's FIRST play must relate to the
 *    announced number: capture it, build a ghar of it, or throw that card;
 *  - only then is the rest of the deck dealt (opener ends with 11 cards,
 *    everyone else 12 — 12 plays apiece);
 *  - a play captures loose cards that group into the played value (several
 *    groups at once is fine) and/or any ghar of the same total;
 *  - must-capture: if the played card can capture, it must;
 *  - ghars are 9–13. Kachcha (one set) may be broken to a higher total by
 *    anyone except its owner; pakka (2+ sets) is locked. A ghar's owner
 *    must retain a matching card until it is captured or broken;
 *  - sweep: clearing the whole table pays 50 — 25 on the opening play,
 *    nothing on the deal's final card;
 *  - deal end: every leftover table card goes to the team that captured
 *    last; scoring = spades (face value) + other aces + 10♦ + sweep
 *    bonuses + majority-cards bonus.
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
  partitionableInto,
  reachableSubsetSum,
  teamOfSeat,
  type SeepRules,
  type SeepTeam,
} from './rules.js';
import type { SeepAction, SeepGameOptions, SeepHouse, SeepState } from './types.js';
import { buildPlayerView } from './views.js';

export type { SeepState } from './types.js';
export { teamOfSeat, reachableSubsetSum, partitionableInto };

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

/** Cards each player plays over the deal (48 cards across 4 players). */
const CARDS_PER_PLAYER = 12;

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
    const firstTurnSeat = options.firstTurnSeat ?? this.rng.int(seats.length);
    const opener = seats[firstTurnSeat]!;
    const minBid = this.rules.minHouseTotal;

    let deck = options.forcedDeck ? options.forcedDeck.slice() : shuffle(standardDeck(), this.rng);
    // The opener must hold a card worth announcing (9–13). If all four
    // opening cards are 8 or below the hand is redealt — with a seeded RNG
    // this is a deterministic re-shuffle, replayable bit for bit.
    let redeals = 0;
    while (
      !options.forcedDeck &&
      deck.slice(-this.rules.openingHandCards).every((c) => c.rank < minBid)
    ) {
      deck = shuffle(standardDeck(), this.rng);
      redeals += 1;
    }

    const state: SeepState = {
      stateVersion: 1,
      gameId: 'seep',
      phase: 'ANNOUNCE',
      players: seats,
      hands: {},
      tableLoose: [],
      houses: [],
      deck,
      openerId: opener.id,
      bid: null,
      dealRestPending: true,
      batchesDealt: 0,
      playsMade: 0,
      captures: {},
      sweeps: { 0: 0, 1: 0 },
      sweepPoints: { 0: 0, 1: 0 },
      lastCaptureTeam: null,
      currentTurn: firstTurnSeat,
      houseSeq: 0,
      teamScores: null,
      majorityTeam: null,
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
      openerId: opener.id,
      teams: { 0: seats.filter((_, i) => i % 2 === 0).map((p) => p.id), 1: seats.filter((_, i) => i % 2 === 1).map((p) => p.id) },
    });
    if (redeals > 0) this.emit('REDEAL', { redeals });

    // Opening instalment: 4 to the opener, 4 face-down to the table.
    const s = this.getState();
    for (let i = 0; i < this.rules.openingHandCards; i++) {
      const card = s.deck.pop();
      if (!card) INVALID('deck exhausted while dealing');
      s.hands[opener.id]!.push(card);
    }
    for (let i = 0; i < this.rules.tableStartCards; i++) {
      const card = s.deck.pop();
      if (!card) INVALID('deck exhausted while dealing the table');
      s.tableLoose.push(card);
    }

    this.emit('TURN_STARTED', { playerId: this.currentPlayerId() });
  }

  /**
   * Deal the rest of the deck (called right after the opener's first play):
   * rounds of `cardsPerBatch` cards until everyone is topped up — the opener
   * ends with 11 in hand (they already played one), everyone else 12, so
   * every player makes exactly 12 plays.
   */
  private dealRest(): void {
    const s = this.getState();
    const targetFor = (playerId: string): number =>
      playerId === s.openerId ? CARDS_PER_PLAYER - 1 : CARDS_PER_PLAYER;
    let round = 0;
    while (
      s.players.some((p) => (s.hands[p.id]?.length ?? 0) < targetFor(p.id))
    ) {
      round += 1;
      for (const p of s.players) {
        const hand = s.hands[p.id]!;
        const target = targetFor(p.id);
        if (hand.length >= target) continue;
        for (let i = 0; i < this.rules.cardsPerBatch && hand.length < target; i++) {
          const card = s.deck.pop();
          if (!card) INVALID('deck exhausted while dealing');
          hand.push(card);
        }
      }
      s.batchesDealt += 1;
      this.emit('BATCH_DEALT', {
        batch: s.batchesDealt,
        round,
        handCounts: Object.fromEntries(s.players.map((p) => [p.id, s.hands[p.id]!.length])),
        tableIds: s.tableLoose.map((c) => c.id),
      });
    }
    s.dealRestPending = false;
  }

  // -------------------------------------------------------------------
  // Queries
  // -------------------------------------------------------------------

  isGameFinished(): boolean {
    return this.getState().phase === 'ROUND_COMPLETE';
  }

  /** Live team points: card points + banked sweep bonuses (majority only at end). */
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
      openerId: s.openerId,
      bid: s.bid,
      deckCount: s.deck.length,
      playsMade: s.playsMade,
      looseCount: s.bid === null ? 0 : s.tableLoose.length,
      houseTotals: s.houses.map((h) => ({ id: h.id, total: h.total, ownerId: h.ownerId, sets: h.sets })),
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
      case 'ANNOUNCE': {
        if (s.phase !== 'ANNOUNCE') INVALID('the number has already been announced');
        if (a.playerId !== this.currentPlayerId()) INVALID('only the opener announces');
        const value = a.value;
        if (!Number.isInteger(value) || value < this.rules.minHouseTotal || value > this.rules.maxHouseTotal) {
          INVALID(`announce a number between ${this.rules.minHouseTotal} and ${this.rules.maxHouseTotal}`);
        }
        const hand = s.hands[a.playerId] ?? [];
        if (!hand.some((c) => captureValue(c) === value)) INVALID(`you must hold a card of value ${value}`);
        return;
      }
      case 'PLAY_CARD': {
        if (s.phase !== 'TURN_PLAY') INVALID(s.phase === 'ANNOUNCE' ? 'announce a number first' : 'the deal is over');
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
    const bid = s.bid ?? INVALID('no announce yet');

    // The opening play must relate to the announced number.
    if (s.playsMade === 0) {
      if (intent.kind === 'CAPTURE' && v !== bid) INVALID(`the first play must involve the announced ${bid}`);
      if (intent.kind === 'BUILD' && intent.total !== bid) INVALID(`the first play must involve the announced ${bid}`);
      if (intent.kind === 'LAY_DOWN' && v !== bid) INVALID(`throw the announced ${bid}`);
      if (intent.kind === 'ADD_TO_HOUSE' || intent.kind === 'BREAK_HOUSE') {
        INVALID('there are no houses on the opening play');
      }
    }

    /**
     * Must-capture: if the played card can take table cards — or matches a
     * house — it may not be thrown away, built or used to break; it must be
     * used to CAPTURE (or, for an own-team house, to ADD to that house —
     * otherwise the pakka move from the rules would be impossible).
     */
    const looseCaptureExists = reachableSubsetSum(s.tableLoose, v);
    const matchingHouses = s.houses.filter((h) => h.total === v);
    if (
      (intent.kind === 'LAY_DOWN' || intent.kind === 'BUILD' || intent.kind === 'BREAK_HOUSE') &&
      (looseCaptureExists || matchingHouses.length > 0)
    ) {
      INVALID('you must capture when you can');
    }
    if (intent.kind === 'ADD_TO_HOUSE' && looseCaptureExists) {
      INVALID('you must capture when you can');
    }

    switch (intent.kind) {
      case 'LAY_DOWN':
        break;
      case 'CAPTURE': {
        const houseIds = intent.houseIds ?? [];
        const loose = intent.tableCardIds ?? [];
        if (loose.length === 0 && houseIds.length === 0) INVALID('select something to capture');
        const selected = this.selectedLooseCards(loose);
        if (loose.length > 0 && !partitionableInto(selected, v)) {
          INVALID('the selected cards must group into sets matching your card');
        }
        for (const houseId of houseIds) {
          const house = s.houses.find((h) => h.id === houseId);
          if (!house) INVALID('no such house');
          if (house!.total !== v) INVALID('your card does not match that house total');
        }
        break;
      }
      case 'BUILD': {
        const selected = this.selectedLooseCards(intent.tableCardIds);
        const total = v + selected.reduce((acc, c) => acc + captureValue(c), 0);
        if (intent.total !== total) INVALID('build total does not match the selection');
        if (total < this.rules.minHouseTotal || total > this.rules.maxHouseTotal) {
          INVALID(`a ghar must total between ${this.rules.minHouseTotal} and ${this.rules.maxHouseTotal}`);
        }
        const backing = hand.some((c) => c.id !== played!.id && captureValue(c) === total);
        if (!backing) INVALID(`you must hold a ${total} to promise this ghar`);
        break;
      }
      case 'ADD_TO_HOUSE': {
        const house = s.houses.find((h) => h.id === intent.houseId);
        if (!house) INVALID('no such house');
        const owner = s.players.find((p) => p.id === house!.ownerId);
        if (!owner || teamOfSeat(owner.seat) !== this.teamOfPlayer(a.playerId)) {
          INVALID('only the owning team may add to a ghar');
        }
        const selected = intent.tableCardIds ?? [];
        const rest = this.selectedLooseCards(selected);
        const groupSum = v + rest.reduce((acc, c) => acc + captureValue(c), 0);
        if (groupSum !== house!.total) {
          INVALID(`the cards you add must make another complete set of ${house!.total}`);
        }
        break;
      }
      case 'BREAK_HOUSE': {
        const house = s.houses.find((h) => h.id === intent.houseId);
        if (!house) INVALID('no such house');
        if (house!.sets !== 1) INVALID('a pakka ghar cannot be broken');
        if (house!.ownerId === a.playerId) INVALID('you cannot break your own ghar');
        const newTotal = house!.total + v;
        if (newTotal > this.rules.maxHouseTotal) {
          INVALID(`a ghar cannot exceed ${this.rules.maxHouseTotal}`);
        }
        const backing = hand.some((c) => c.id !== played!.id && captureValue(c) === newTotal);
        if (!backing) INVALID(`you must hold a ${newTotal} to raise this ghar`);
        break;
      }
      default:
        INVALID('unknown play intent');
    }

    this.checkOwnerRetention(s, a.playerId, played!.id, intent);
  }

  /**
   * As long as you own a ghar you must keep a matching card in hand. Simulate
   * the play: the hand loses the played card; houses that survive it (they
   * may be captured in the same play) still demand their matching card.
   */
  private checkOwnerRetention(s: SeepState, playerId: string, playedId: string, intent: Extract<SeepAction, { type: 'PLAY_CARD' }>['intent']): void {
    const handAfter = (s.hands[playerId] ?? []).filter((c) => c.id !== playedId);
    let survivingHouses: SeepHouse[] = s.houses;
    if (intent.kind === 'CAPTURE') {
      const captured = new Set(intent.houseIds ?? []);
      survivingHouses = s.houses.filter((h) => !captured.has(h.id));
    }
    for (const house of survivingHouses) {
      if (house.ownerId !== playerId) continue;
      if (!handAfter.some((c) => captureValue(c) === house.total)) {
        INVALID(`you must keep a ${house.total} while your ghar ${house.total} stands`);
      }
    }
  }

  private teamOfPlayer(playerId: string): SeepTeam {
    const s = this.getState();
    const p = s.players.find((x) => x.id === playerId);
    if (!p) INVALID('player not in this game');
    return teamOfSeat(p.seat);
  }

  /** Resolve + verify selected loose table cards (distinct, all present). */
  private selectedLooseCards(cardIds: string[]): Card[] {
    const s = this.getState();
    if (!Array.isArray(cardIds)) INVALID('invalid table card selection');
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
    if (a.type === 'ANNOUNCE') {
      const s = this.getState();
      s.bid = a.value;
      s.phase = 'TURN_PLAY';
      s.revision += 1;
      this.emit('BID_ANNOUNCED', { playerId: a.playerId, value: a.value });
      this.emit('TURN_STARTED', { playerId: this.currentPlayerId() });
      return;
    }
    this.applyPlay(a);
  }

  private applyPlay(a: Extract<SeepAction, { type: 'PLAY_CARD' }>): void {
    const s = this.getState();
    const hand = s.hands[a.playerId]!;
    const idx = hand.findIndex((c) => c.id === a.cardId);
    const played = hand[idx]!;
    const team = this.teamOfPlayer(a.playerId);
    const intent = a.intent;

    // Remove the played card from the hand up front; every intent consumes it.
    hand.splice(idx, 1);
    s.playsMade += 1;

    switch (intent.kind) {
      case 'LAY_DOWN': {
        s.tableLoose.push(played);
        this.emit('PLAY_LAY', { playerId: a.playerId, cardId: played.id, value: captureValue(played) });
        break;
      }
      case 'CAPTURE': {
        const loose = this.selectedLooseCards(intent.tableCardIds ?? []);
        const houseIds = intent.houseIds ?? [];
        const houses = houseIds.map((id) => {
          const house = s.houses.find((h) => h.id === id)!;
          return house;
        });
        s.tableLoose = s.tableLoose.filter((c) => !(intent.tableCardIds ?? []).includes(c.id));
        s.houses = s.houses.filter((h) => !houseIds.includes(h.id));
        const pile = s.captures[a.playerId]!;
        pile.push(played, ...loose, ...houses.flatMap((h) => h.cards));
        s.lastCaptureTeam = team;
        this.emit('PLAY_CAPTURE', {
          playerId: a.playerId,
          cardId: played.id,
          capturedIds: [...loose.map((c) => c.id), ...houses.flatMap((h) => h.cards.map((c) => c.id))],
          houseIds,
          capturedCount: 1 + loose.length + houses.reduce((n, h) => n + h.cards.length, 0),
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
          ownerId: a.playerId,
          sets: 1,
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
      case 'ADD_TO_HOUSE': {
        const house = s.houses.find((h) => h.id === intent.houseId)!;
        const selected = this.selectedLooseCards(intent.tableCardIds ?? []);
        s.tableLoose = s.tableLoose.filter((c) => !(intent.tableCardIds ?? []).includes(c.id));
        house.cards.push(played, ...selected);
        house.sets += 1;
        this.emit('PLAY_ADD', {
          playerId: a.playerId,
          cardId: played.id,
          houseId: house.id,
          total: house.total,
          pakka: house.sets >= 2,
          joinedIds: [played.id, ...selected.map((c) => c.id)],
        });
        break;
      }
      case 'BREAK_HOUSE': {
        const house = s.houses.find((h) => h.id === intent.houseId)!;
        const fromTotal = house.total;
        house.total += captureValue(played);
        house.ownerId = a.playerId;
        house.sets = 1;
        house.cards.push(played);
        this.emit('PLAY_BREAK', {
          playerId: a.playerId,
          cardId: played.id,
          houseId: house.id,
          fromTotal,
          toTotal: house.total,
        });
        break;
      }
    }

    s.revision += 1;
    this.advanceAfterPlay();
  }

  /** Sweep detection: only a capture can clear the table. */
  private checkSweep(s: SeepState, team: SeepTeam, playerId: string): void {
    if (s.tableLoose.length === 0 && s.houses.length === 0) {
      const handsEmptyAfter = s.players.every((p) => (s.hands[p.id] ?? []).length === 0);
      const bonus =
        s.playsMade === 1
          ? this.rules.firstPlaySweepBonus
          : !s.dealRestPending && handsEmptyAfter
            ? 0 // sweeping with the very last card of the deal scores nothing
            : this.rules.sweepBonus;
      s.sweeps[team] += 1;
      s.sweepPoints[team] += bonus;
      this.emit('SEEP_SWEEP', { playerId, team, bonus });
    }
  }

  private advanceAfterPlay(): void {
    const s = this.getState();
    if (s.dealRestPending) this.dealRest();
    const allHandsEmpty = s.players.every((p) => (s.hands[p.id] ?? []).length === 0);
    if (allHandsEmpty) {
      this.finishDeal();
      return;
    }
    s.currentTurn = (s.currentTurn + 1) % s.players.length;
    this.emit('TURN_STARTED', { playerId: this.currentPlayerId() });
  }

  /** Distribute leftovers and settle the final team scores. */
  private finishDeal(): void {
    const s = this.getState();
    const firstSeatOf = (team: SeepTeam): string | null =>
      s.players.find((p) => teamOfSeat(p.seat) === team)?.id ?? null;

    // Everything left on the table — loose cards and any surviving houses —
    // goes to the team that captured last.
    if (s.lastCaptureTeam !== null) {
      const receiver = firstSeatOf(s.lastCaptureTeam);
      if (receiver) {
        (s.captures[receiver] ??= []).push(...s.tableLoose, ...s.houses.flatMap((h) => h.cards));
      }
    }
    s.tableLoose = [];
    s.houses = [];

    // Majority bonus: strictly more captured cards than the other team.
    const tp = this.teamPoints(s);
    let majorityTeam: SeepTeam | null = null;
    if (this.rules.majorityCardsBonus > 0) {
      const count = (team: SeepTeam): number =>
        s.players.filter((p) => teamOfSeat(p.seat) === team).reduce((n, p) => n + (s.captures[p.id]?.length ?? 0), 0);
      const c0 = count(0);
      const c1 = count(1);
      if (c0 !== c1) {
        majorityTeam = c0 > c1 ? 0 : 1;
        tp[majorityTeam] += this.rules.majorityCardsBonus;
      }
    }

    s.teamScores = tp;
    s.majorityTeam = majorityTeam;
    s.roundWinnerTeam = tp[0] > tp[1] ? 0 : tp[1] > tp[0] ? 1 : null;
    s.tiedTeams = s.roundWinnerTeam === null ? [0, 1] : [];
    s.phase = 'ROUND_COMPLETE';
    s.revision += 1;
    this.emit('ROUND_COMPLETE', {
      teamScores: tp,
      winnerTeam: s.roundWinnerTeam,
      tiedTeams: s.tiedTeams,
      majorityTeam,
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
