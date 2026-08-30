/**
 * Server-authoritative Seep (Sweep) engine — canonical Punjabi 100-point
 * rules. Contract: docs/rules/seep-punjabi-100.md.
 *
 * Pure state-machine over JSON state: no networking, no timers, no DOM.
 * All validation happens here — clients only ever send intentions.
 *
 * Ruleset implemented (see the doc for the authoritative wording):
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
 *    points in a deal. The losing team's dealer rules drive progression.
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
  maximalCaptureAlternatives,
  nextSeatCCW,
  partitionableInto,
  reachableSubsetSum,
  teamOfSeat,
  type SeepRules,
  type SeepTeam,
} from './rules.js';
import type {
  SeepAction,
  SeepGameOptions,
  SeepHouse,
  SeepPlayIntent,
  SeepState,
} from './types.js';
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

export class SeepEngine {
  readonly gameId = 'seep';
  readonly stateVersion = 2 as const;

  private state: SeepState | null = null;
  private rules: SeepRules = mergeSeepRules();
  private rng: Rng = createRng();
  private forcedDeck: Card[] | null = null;

  getRules(): SeepRules {
    return this.rules;
  }

  getState(): SeepState {
    if (!this.state) INVALID('game not created');
    return this.state;
  }

  /** Restore a previously serialized state (reconnect / redis restore). */
  restoreState(state: SeepState, rules?: Partial<SeepRules>): void {
    if (state.stateVersion !== 2) INVALID('unsupported state version');
    this.state = state;
    this.rules = mergeSeepRules(state.rules ?? rules);
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
    this.rng = createRng(options.seed);
    this.forcedDeck = options.forcedDeck ?? null;
    const seats = [...players].sort((a, b) => a.seat - b.seat);
    const dealer = options.dealerSeat ?? this.rng.int(seats.length);
    this.state = null;
    this.startMatch(seats, dealer);
  }

  /** Fresh baazi: scores, lead, history and dealer all reset. */
  private startMatch(seats: GamePlayer[], dealerSeat: number): void {
    this.state = {
      stateVersion: 2,
      gameId: 'seep',
      phase: 'ANNOUNCE',
      rules: this.rules,
      players: seats,
      hands: {},
      tableLoose: [],
      houses: [],
      deck: [],
      bidderSeat: nextSeatCCW(dealerSeat),
      dealerSeat,
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
      currentTurn: nextSeatCCW(dealerSeat),
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
    for (const p of seats) {
      this.state.hands[p.id] = [];
      this.state.captures[p.id] = [];
    }
    this.emit('MATCH_STARTED', {
      playerIds: seats.map((p) => p.id),
      teams: {
        0: seats.filter((p) => teamOfSeat(p.seat) === 0).map((p) => p.id),
        1: seats.filter((p) => teamOfSeat(p.seat) === 1).map((p) => p.id),
      },
    });
    this.startDeal(dealerSeat);
  }

  /**
   * Deal the next hand of a live baazi (phase DEAL_COMPLETE). Dealer
   * progression per the contract: while the dealing team is behind or level
   * the same dealer deals again; when the dealing team is winning, the deal
   * passes to the next player to the right; after a baazi the partner of
   * that next dealer takes over.
   */
  nextDeal(): void {
    const s = this.getState();
    if (s.phase !== 'DEAL_COMPLETE') {
      INVALID(s.phase === 'MATCH_COMPLETE' ? 'the baazi is over' : 'the current deal is still running');
    }
    const last = s.dealHistory[s.dealHistory.length - 1] ?? INVALID('no completed deal');
    const dealerTeam = teamOfSeat(s.dealerSeat);
    // "is the dealing team now winning" — the running lead right after this deal.
    const dealerAhead = last.leadAfter === 0 ? null : last.leadAfter > 0 ? 0 : 1;
    let next = dealerAhead === dealerTeam ? nextSeatCCW(s.dealerSeat) : s.dealerSeat;
    if (last.baazi) {
      // after a baazi: the partner of the would-be next dealer deals
      next = (next + 2) % 4;
    }
    this.startDeal(next);
  }

  /** Shuffle, deal the opening instalment and set the bid phase. */
  private startDeal(dealerSeat: number): void {
    const s = this.getState();
    const bidderSeat = nextSeatCCW(dealerSeat);
    s.dealerSeat = dealerSeat;
    s.bidderSeat = bidderSeat;
    s.dealNo += 1;
    s.phase = 'ANNOUNCE';
    s.bid = null;
    s.dealRestPending = true;
    s.batchesDealt = 0;
    s.playsMade = 0;
    s.tableLoose = [];
    s.houses = [];
    s.captures = {};
    for (const p of s.players) s.captures[p.id] = [];
    s.sweeps = { 0: 0, 1: 0 };
    s.sweepPoints = { 0: 0, 1: 0 };
    s.lastCaptureTeam = null;
    s.lastPickup = null;
    s.currentTurn = bidderSeat;
    s.houseSeq = 0;
    s.teamScores = null;
    s.roundWinnerTeam = null;
    s.baaziWinnerTeam = null;
    s.baaziReason = null;
    s.tiedTeams = [];
    for (const p of s.players) {
      s.hands[p.id] = [];
    }

    const bidder = s.players[bidderSeat]!;
    let deck = this.forcedDeck ? [...this.forcedDeck] : shuffle(standardDeck(), this.rng);
    // The bidder must hold a card worth announcing (9–13). If all four
    // opening cards are 8 or below the deal is repeated (same dealer, new
    // shuffle) — deterministic under a seeded RNG. A forced deck (tests)
    // is used verbatim: fixtures must supply a biddable opening hand.
    let redeals = 0;
    if (!this.forcedDeck) {
      while (deck.slice(-this.rules.openingHandCards).every((c) => c.rank < this.rules.minHouseTotal)) {
        deck = shuffle(standardDeck(), this.rng);
        redeals += 1;
      }
    }
    s.deck = deck;

    this.emit('DEAL_STARTED', {
      dealNo: s.dealNo,
      dealerId: s.players[dealerSeat]!.id,
      bidderId: bidder.id,
      baaziLead: s.baaziLead,
      baazisWon: { ...s.baazisWon },
    });
    if (redeals > 0) this.emit('REDEAL', { redeals });

    for (let i = 0; i < this.rules.openingHandCards; i++) {
      const card = s.deck.pop();
      if (!card) INVALID('deck exhausted while dealing');
      s.hands[bidder.id]!.push(card);
    }
    for (let i = 0; i < this.rules.tableStartCards; i++) {
      const card = s.deck.pop();
      if (!card) INVALID('deck exhausted while dealing the floor');
      s.tableLoose.push(card);
    }

    this.emit('TURN_STARTED', { playerId: this.currentPlayerId() });
  }

  /**
   * Complete the deal (called right after the bidder's first play):
   * counter-clockwise packets of `cardsPerBatch` starting at the bidder —
   * the bidder ends with 11 (they already played one), everyone else 12.
   */
  private dealRest(): void {
    const s = this.getState();
    const order: GamePlayer[] = [];
    for (let seat = s.bidderSeat, i = 0; i < s.players.length; i++) {
      order.push(s.players[seat]!);
      seat = nextSeatCCW(seat);
    }
    // The bidder's target counts the card already played before the rest of
    // the deck came out: he ends the deal holding 11, the others 12.
    const targetFor = (playerId: string): number =>
      playerId === s.players[s.bidderSeat]!.id ? CARDS_PER_PLAYER - 1 : CARDS_PER_PLAYER;
    let round = 0;
    while (s.players.some((p) => (s.hands[p.id]?.length ?? 0) < targetFor(p.id))) {
      round += 1;
      for (const p of order) {
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
        if (a.playerId !== this.currentPlayerId()) INVALID('only the bidder announces');
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
    const myTeam = this.teamOfPlayer(a.playerId);

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
     * Per-card must-capture: a card that is NOT being used in a house may
     * not be thrown if it could take something. Building, cementing and
     * breaking are legitimate alternative uses of the played card.
     */
    const thisCardCanCapture =
      intent.kind === 'LAY_DOWN' &&
      (reachableSubsetSum(s.tableLoose, v) || s.houses.some((h) => h.total === v));
    if (thisCardCanCapture) INVALID('this card can take something — it cannot be thrown');

    const handAfter = hand.filter((c) => c.id !== played!.id);

    switch (intent.kind) {
      case 'LAY_DOWN':
        break;

      case 'CAPTURE': {
        const houseIds = intent.houseIds ?? [];
        const looseIds = intent.tableCardIds ?? [];
        if (looseIds.length === 0 && houseIds.length === 0) INVALID('select something to capture');
        // Houses of the played value are ALL compulsory.
        const matchingHouses = s.houses.filter((h) => h.total === v);
        if (matchingHouses.length !== houseIds.length) {
          INVALID('a card must take every ghar it matches');
        }
        for (const houseId of houseIds) {
          if (!matchingHouses.some((h) => h.id === houseId)) {
            INVALID('your card does not match that house total');
          }
        }
        // Loose cards: exactly one maximal collection of non-overlapping groups.
        const alternatives = maximalCaptureAlternatives(s.tableLoose, v);
        if (looseIds.length > 0) {
          if (alternatives.length === 0) INVALID('no set of table cards matches your card');
          const selectedSet = new Set(looseIds);
          const matches = alternatives.some((groups) => {
            const ids = groups.flat();
            return ids.length === looseIds.length && ids.every((id) => selectedSet.has(s.tableLoose[id]!.id));
          });
          if (!matches) {
            INVALID('you must take a maximal set — pick a highlighted combination');
          }
        } else if (alternatives.length > 0) {
          INVALID('a card must take every loose set it matches');
        }
        break;
      }

      case 'BUILD': {
        const selected = this.selectedLooseCards(intent.tableCardIds);
        const total = intent.total;
        if (total < this.rules.minHouseTotal || total > this.rules.maxHouseTotal) {
          INVALID(`a ghar must total between ${this.rules.minHouseTotal} and ${this.rules.maxHouseTotal}`);
        }
        // The played card plus the selected loose cards must form complete
        // copies of the total (usually one; two 9s on a loose 9 make a
        // cemented house in a single turn).
        const sum = v + selected.reduce((acc, c) => acc + captureValue(c), 0);
        if (sum < total || sum % total !== 0) {
          INVALID('the build does not form complete copies of the house total');
        }
        // Establishing requires a backing card; merging into a house my
        // team already owns does not (the existing owner retains).
        const existing = s.houses.find((h) => h.total === total);
        if (!existing || existing.ownerByTeam[myTeam] === undefined) {
          if (!handAfter.some((c) => captureValue(c) === total)) {
            INVALID(`you must hold a ${total} to promise this ghar`);
          }
        }
        break;
      }

      case 'ADD_TO_HOUSE': {
        const house = s.houses.find((h) => h.id === intent.houseId);
        if (!house) INVALID('no such house');
        const selected = intent.tableCardIds ?? [];
        const rest = this.selectedLooseCards(selected);
        const groupSum = v + rest.reduce((acc, c) => acc + captureValue(c), 0);
        if (groupSum !== house!.total) {
          INVALID(`the cards you add must make another complete set of ${house!.total}`);
        }
        // Cementing/adding to an opponent-owned house requires retention and
        // makes you a second owner. Adding to your own side's house does not.
        if (house!.ownerByTeam[myTeam] === undefined) {
          if (!handAfter.some((c) => captureValue(c) === house!.total)) {
            INVALID(`you must keep a ${house!.total} to cement an opponent's ghar`);
          }
        }
        break;
      }

      case 'BREAK_HOUSE': {
        const house = s.houses.find((h) => h.id === intent.houseId);
        if (!house) INVALID('no such house');
        const copies = Math.round(house!.cards.reduce((acc, c) => acc + c.rank, 0) / house!.total);
        if (copies !== 1) INVALID('a pakka ghar cannot be broken');
        if (house!.ownerByTeam[myTeam] === a.playerId) INVALID('you cannot break your own ghar');
        const newTotal = house!.total + v;
        if (newTotal > this.rules.maxHouseTotal) {
          INVALID(`a ghar cannot exceed ${this.rules.maxHouseTotal}`);
        }
        if (!handAfter.some((c) => captureValue(c) === newTotal)) {
          INVALID(`you must hold a ${newTotal} to raise this ghar`);
        }
        // Merging the broken house into an existing one: if the target is
        // owned by the opponents and I am not taking ownership, my partner
        // (as the existing owner) retains — no extra duty on me.
        break;
      }

      default:
        INVALID('unknown play intent');
    }

    this.checkRetention(s, a.playerId, handAfter, intent);
  }

  /**
   * Every owner of every surviving house must keep a card of that house's
   * total in hand. Simulated: the hand loses the played card; houses picked
   * up in the same play no longer demand anything.
   *
   * Relaxation: a player on their LAST card cannot be blocked by their own
   * retention duty — the deal would deadlock (the house simply remains on
   * the floor capturable by its value, and sweeps as a leftover at the end).
   */
  private checkRetention(
    s: SeepState,
    playerId: string,
    handAfter: Card[],
    intent: SeepPlayIntent,
  ): void {
    let survivingHouses: SeepHouse[] = s.houses;
    if (intent.kind === 'CAPTURE') {
      const captured = new Set(intent.houseIds ?? []);
      survivingHouses = s.houses.filter((h) => !captured.has(h.id));
    }
    for (const house of survivingHouses) {
      for (const [teamStr, owner] of Object.entries(house.ownerByTeam)) {
        if (!owner) continue;
        const team = Number(teamStr) as SeepTeam;
        if (owner === playerId) {
          if (handAfter.length === 0) continue; // last-card relaxation
          if (!handAfter.some((c) => captureValue(c) === house.total)) {
            INVALID(`a ${house.total} must stay behind while the ghar ${house.total} stands`);
          }
        } else {
          void team;
        }
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
        const houses = houseIds.map((id) => s.houses.find((h) => h.id === id)!);
        s.tableLoose = s.tableLoose.filter((c) => !(intent.tableCardIds ?? []).includes(c.id));
        s.houses = s.houses.filter((h) => !houseIds.includes(h.id));
        const pile = s.captures[a.playerId]!;
        pile.push(played, ...loose, ...houses.flatMap((h) => h.cards));
        s.lastCaptureTeam = team;
        const capturedIds = [
          played.id,
          ...loose.map((c) => c.id),
          ...houses.flatMap((h) => h.cards.map((c) => c.id)),
        ];
        s.lastPickup = { playerId: a.playerId, cardIds: capturedIds, playsMade: s.playsMade };
        this.emit('PLAY_CAPTURE', {
          playerId: a.playerId,
          cardId: played.id,
          capturedIds,
          houseIds,
          capturedCount: capturedIds.length,
        });
        this.checkSweep(s, team, a.playerId);
        break;
      }
      case 'BUILD': {
        const selected = this.selectedLooseCards(intent.tableCardIds);
        s.tableLoose = s.tableLoose.filter((c) => !intent.tableCardIds.includes(c.id));
        const existing = s.houses.find((h) => h.total === intent.total);
        let house: SeepHouse;
        const joined = [played, ...selected];
        if (existing) {
          // A second house of the same value merges into a cemented one.
          existing.cards.push(...joined);
          if (existing.ownerByTeam[team] === undefined) {
            existing.ownerByTeam[team] = a.playerId;
          }
          house = existing;
          this.emit('PLAY_BUILD', {
            playerId: a.playerId,
            cardId: played.id,
            houseId: house.id,
            total: house.total,
            merged: true,
            joinedIds: joined.map((c) => c.id),
          });
        } else {
          house = {
            id: `h-${++s.houseSeq}`,
            total: intent.total,
            ownerByTeam: { [team]: a.playerId },
            cards: [...joined],
          };
          s.houses.push(house);
          this.emit('PLAY_BUILD', {
            playerId: a.playerId,
            cardId: played.id,
            houseId: house.id,
            total: house.total,
            merged: false,
            joinedIds: house.cards.map((c) => c.id),
          });
        }
        this.autoCement(house);
        break;
      }
      case 'ADD_TO_HOUSE': {
        const house = s.houses.find((h) => h.id === intent.houseId)!;
        const selected = this.selectedLooseCards(intent.tableCardIds ?? []);
        s.tableLoose = s.tableLoose.filter((c) => !(intent.tableCardIds ?? []).includes(c.id));
        house.cards.push(played, ...selected);
        if (house.ownerByTeam[team] === undefined) {
          // cementing an opponent-owned house: become a second owner
          house.ownerByTeam[team] = a.playerId;
        }
        this.emit('PLAY_ADD', {
          playerId: a.playerId,
          cardId: played.id,
          houseId: house.id,
          total: house.total,
          pakka: Math.round(house.cards.reduce((acc, c) => acc + c.rank, 0) / house.total) >= 2,
          owners: { ...house.ownerByTeam },
          joinedIds: [played.id, ...selected.map((c) => c.id)],
        });
        break;
      }
      case 'BREAK_HOUSE': {
        const house = s.houses.find((h) => h.id === intent.houseId)!;
        const fromTotal = house.total;
        house.total += captureValue(played);
        house.cards.push(played);
        // The breaker takes over ownership of the broken house…
        house.ownerByTeam = { [team]: a.playerId };
        // …and if the new total matches another house, the two combine.
        const twin = s.houses.find((h) => h.id !== house.id && h.total === house.total);
        if (twin) {
          // combined cemented house: the target's owners stay, the breaker
          // joins (their team keeps its existing owner if it had one)
          house.cards.push(...twin.cards);
          for (const [ownerTeamStr, owner] of Object.entries(twin.ownerByTeam)) {
            const ownerTeam = Number(ownerTeamStr) as SeepTeam;
            if (house.ownerByTeam[ownerTeam] === undefined) {
              house.ownerByTeam[ownerTeam] = owner!;
            }
          }
          s.houses = s.houses.filter((h) => h.id !== twin.id);
        }
        this.emit('PLAY_BREAK', {
          playerId: a.playerId,
          cardId: played.id,
          houseId: house.id,
          fromTotal,
          toTotal: house.total,
          merged: !!twin,
          owners: { ...house.ownerByTeam },
        });
        this.autoCement(house);
        break;
      }
    }

    s.revision += 1;
    this.advanceAfterPlay();
  }

  /**
   * The floor can never hold a loose card of a standing house's value: after
   * establishing/breaking, loose cards of the total — or a set of loose
   * cards summing to it — are automatically absorbed, cementing the house.
   */
  private autoCement(house: SeepHouse): void {
    const s = this.getState();
    const absorbed: string[] = [];
    // every loose card equal to the total joins first
    for (const card of [...s.tableLoose]) {
      if (card.rank === house.total) {
        house.cards.push(card);
        absorbed.push(card.id);
        s.tableLoose = s.tableLoose.filter((c) => c.id !== card.id);
      }
    }
    // then one maximal set of remaining loose cards summing to the total
    if (s.tableLoose.length > 0) {
      const alternatives = maximalCaptureAlternatives(s.tableLoose, house.total);
      if (alternatives.length > 0) {
        const ids = alternatives[0]!.flat().map((i) => s.tableLoose[i]!.id);
        for (const id of ids) {
          const card = s.tableLoose.find((c) => c.id === id)!;
          house.cards.push(card);
          absorbed.push(id);
          s.tableLoose = s.tableLoose.filter((c) => c.id !== id);
        }
      }
    }
    if (absorbed.length > 0) {
      this.emit('HOUSE_CEMENTED', {
        houseId: house.id,
        total: house.total,
        absorbedIds: absorbed,
        pakka: Math.round(house.cards.reduce((acc, c) => acc + c.rank, 0) / house.total) >= 2,
      });
    }
  }

  /** Sweep detection: only a capture can clear the floor. */
  private checkSweep(s: SeepState, team: SeepTeam, playerId: string): void {
    if (s.tableLoose.length === 0 && s.houses.length === 0) {
      const handsEmptyAfter = s.players.every((p) => (s.hands[p.id] ?? []).length === 0);
      const bonus =
        s.playsMade === 1
          ? this.rules.firstPlaySweepBonus
          : this.rules.lastPlaySweepZero && !s.dealRestPending && handsEmptyAfter
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
    s.currentTurn = nextSeatCCW(s.currentTurn);
    this.emit('TURN_STARTED', { playerId: this.currentPlayerId() });
  }

  /** Distribute leftovers, settle the deal and apply the baazi rules. */
  private finishDeal(): void {
    const s = this.getState();
    const firstSeatOf = (team: SeepTeam): string | null =>
      s.players.find((p) => teamOfSeat(p.seat) === team)?.id ?? null;

    // Leftover floor cards — loose cards and any surviving houses — go to
    // the team that picked up last. (Houses are in practice always gone:
    // their owners must have held and eventually played matching cards.)
    if (s.lastCaptureTeam !== null) {
      const receiver = firstSeatOf(s.lastCaptureTeam);
      if (receiver) {
        (s.captures[receiver] ??= []).push(...s.tableLoose, ...s.houses.flatMap((h) => h.cards));
      }
    }
    s.tableLoose = [];
    s.houses = [];

    // Team deal score: card points + sweep bonuses (+ majority in the casual preset).
    const tp = this.teamPoints(s);
    if (this.rules.majorityCardsBonus > 0) {
      const count = (team: SeepTeam): number =>
        s.players.filter((p) => teamOfSeat(p.seat) === team).reduce((n, p) => n + (s.captures[p.id]?.length ?? 0), 0);
      const c0 = count(0);
      const c1 = count(1);
      if (c0 !== c1) {
        tp[c0 > c1 ? 0 : 1] += this.rules.majorityCardsBonus;
      }
    }

    s.teamScores = tp;
    s.roundWinnerTeam = tp[0] > tp[1] ? 0 : tp[1] > tp[0] ? 1 : null;
    s.tiedTeams = s.roundWinnerTeam === null ? [0, 1] : [];

    // Baazi rules: instant loss below the minimum, else accumulate the
    // signed difference until a side leads by the target.
    let baazi: { winnerTeam: SeepTeam; reason: 'lead' | 'minimum-points' } | null = null;
    const min = this.rules.minimumDealPoints;
    if (tp[0] < min || tp[1] < min) {
      // the side below the minimum loses instantly; if the ruleset makes
      // both fall short, the higher scorer takes the baazi
      const winnerTeam: SeepTeam =
        tp[0] < min && tp[1] < min ? (tp[0] < tp[1] ? 1 : 0) : tp[0] < min ? 1 : 0;
      baazi = { winnerTeam, reason: 'minimum-points' };
    } else {
      s.baaziLead += tp[0] - tp[1];
      if (Math.abs(s.baaziLead) >= this.rules.baaziLeadTarget) {
        baazi = { winnerTeam: s.baaziLead > 0 ? 0 : 1, reason: 'lead' };
      }
    }

    const leadAfterDeal = s.baaziLead;
    if (baazi) {
      s.baazisWon[baazi.winnerTeam] += 1;
      s.baaziLead = 0;
      s.baaziWinnerTeam = baazi.winnerTeam;
      s.baaziReason = baazi.reason;
      s.phase = 'MATCH_COMPLETE';
    } else {
      s.baaziWinnerTeam = null;
      s.baaziReason = null;
      s.phase = 'DEAL_COMPLETE';
    }

    s.dealHistory.push({
      dealNo: s.dealNo,
      teamScores: { ...tp },
      diff: tp[0] - tp[1],
      leftoverTeam: s.lastCaptureTeam,
      baazi,
      leadAfter: leadAfterDeal,
      baazisWonAfter: { ...s.baazisWon },
    });

    s.revision += 1;
    this.emit('DEAL_COMPLETE', {
      dealNo: s.dealNo,
      teamScores: { ...tp },
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
