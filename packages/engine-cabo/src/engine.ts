/**
 * Server-authoritative Cabo, played by the rules core.
 *
 * The core (`core/gamelab`, loaded through `@game-night/core`) holds the
 * round and decides every action. This class is the table's side of it: it
 * names players and cards (the core knows seats and card numbers), keeps the
 * state in the shape the views read, and writes the event log the clients
 * animate from.
 */

import { apply, check, deal, gameInfo, load, type Round } from '@game-night/core';
import { SUITS, type Card, type GameAction, type GameEvent, type GamePlayer, type Rank } from '@game-night/shared';
import { DEFAULT_CABO_RULES, cardValue, type CaboPower, type CaboRules } from './rules.js';
import type { CaboAction, CaboGameOptions, CaboPhase, CaboState } from './types.js';
import { buildPlayerView } from './views.js';

export type { CaboState } from './types.js';

export class CaboEngineError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CaboEngineError';
  }
}

function INVALID(msg: string): never {
  throw new CaboEngineError(msg);
}

/** Lightweight structured warn (no card values / secrets). */
function logWarn(msg: string, fields?: Record<string, unknown>): void {
  // eslint-disable-next-line no-console
  console.warn(JSON.stringify({ ts: new Date().toISOString(), level: 'warn', msg, ...fields }));
}

// ---------------------------------------------------------------------------
// The core's side: seats, card numbers, its own names for phases and events
// ---------------------------------------------------------------------------

type CorePhase = 'InitialPeek' | 'TurnDraw' | 'DrawDecision' | 'PowerPending' | 'TurnEnd' | 'Complete';

const PHASES: Record<CorePhase, CaboPhase> = {
  InitialPeek: 'INITIAL_PEEK',
  TurnDraw: 'TURN_DRAW',
  DrawDecision: 'DRAW_DECISION',
  PowerPending: 'POWER_PENDING',
  TurnEnd: 'TURN_END',
  Complete: 'ROUND_COMPLETE',
};

/** What the core tells the whole table happened (`CaboEvent`). */
type CoreEvent =
  | 'Reshuffled'
  | { TurnStarted: { seat: number } }
  | { Peeked: { seat: number; owner: number; slot: number } }
  | { Drew: { seat: number } }
  | { Kept: { seat: number; slot: number; discarded: number } }
  | { Discarded: { seat: number; card: number } }
  | { Swapped: { seat: number; own: number; target: number; slot: number } }
  | { Flushed: { seat: number; owner: number; slot: number; card: number } }
  | { FailedFlushOwn: { seat: number; slot: number; card: number } }
  | { FailedFlushOther: { seat: number; target: number; slot: number } }
  | { Penalty: { seat: number; slot: number } }
  | { Transferred: { from: number; from_slot: number; to: number; to_slot: number } }
  | { CaboCalled: { seat: number; auto: boolean } };

/** The round as `Round.save` writes it (the fields used here). */
interface CoreGame {
  phase: CorePhase;
  hands: (number | null)[][];
  known: number[][];
  deck: number[];
  discard: number[];
  turn: number;
  drawn: number | null;
  pending_power: [CaboPower, number] | null;
  transfers: { from: number; to: number }[];
  cabo: { caller: number; taken: number[] } | null;
  peeks_remaining: number;
  turns_started: number;
  result: { scores: number[]; winners: number[] } | null;
  log: CoreEvent[];
}

interface CoreSave {
  rules: CaboRules;
  game: CoreGame;
}

type CoreAction =
  | { type: 'PEEK_STARTING'; slots: number }
  | { type: 'DRAW' | 'DISCARD_DRAWN' | 'CALL_CABO' | 'END_TURN' }
  | { type: 'KEEP' | 'PEEK_OWN' | 'TRANSFER'; slot: number }
  | { type: 'PEEK_OTHER' | 'FLUSH_OTHER'; target: number; slot: number }
  | { type: 'BLIND_SWAP'; own: number; target: number; slot: number }
  | { type: 'FLUSH_OWN'; slots: number };

/** The face a card number stands for in the core. */
function faceOf(n: number): { suit: Card['suit']; rank: Rank } {
  return { suit: SUITS[Math.floor((n % 52) / 13)]!, rank: ((n % 13) + 1) as Rank };
}

function liveCount(hand: (unknown | null)[]): number {
  return hand.filter((c) => c !== null).length;
}

export class CaboEngine {
  readonly gameId = 'cabo';
  readonly stateVersion = 2 as const;

  private state: CaboState | null = null;
  private round: Round | null = null;
  private rules: CaboRules = { ...DEFAULT_CABO_RULES };

  getRules(): CaboRules {
    return this.rules;
  }

  getState(): CaboState {
    if (!this.state) INVALID('game not created');
    return this.state;
  }

  /** Restore a previously serialized state (reconnect / redis restore). The
   *  round continues from `state.core`; the rules are the ones it was dealt with. */
  restoreState(state: CaboState, _rules?: Partial<CaboRules>): void {
    if (state.stateVersion !== 2) INVALID('unsupported state version');
    try {
      this.round = load('cabo', state.core);
    } catch (err) {
      INVALID(String((err as Error).message ?? err));
    }
    this.rules = (state.core as CoreSave).rules;
    this.state = state;
    this.refresh();
  }

  // -------------------------------------------------------------------
  // Lifecycle
  // -------------------------------------------------------------------

  createGame(players: GamePlayer[], options: CaboGameOptions = {}): void {
    const rules: CaboRules = { ...DEFAULT_CABO_RULES, ...options.rules };
    const info = gameInfo('cabo');
    if (players.length < info.minPlayers || players.length > info.maxPlayers) {
      INVALID(`cabo requires ${info.minPlayers}-${info.maxPlayers} players`);
    }
    const seats = [...players].sort((a, b) => a.seat - b.seat);
    let round: Round;
    try {
      round = deal('cabo', rules, seats.length, options.seed);
    } catch (err) {
      INVALID(String((err as Error).message ?? err));
    }
    let saved = JSON.parse(round.save()) as CoreSave;
    const cards: Record<string, Card> = {};

    if (options.forcedDeck) {
      // A deck given card by card (debug mode, tests): the cards keep the ids
      // they came with and stand in the core as numbers of the same face.
      const numbers = this.numberForced(options.forcedDeck, rules, cards);
      const hands: number[][] = seats.map(() => []);
      for (let r = 0; r < rules.startingCards; r++) {
        for (const hand of hands) {
          const n = numbers.pop();
          if (n === undefined) INVALID('deck exhausted while dealing');
          hand.push(n);
        }
      }
      saved.game.deck = numbers;
      saved.game.hands = hands;
    } else {
      // Ids follow the order of the shuffled deck before the deal, so they
      // say nothing about the face.
      const g = saved.game;
      const dealt: number[] = [];
      for (let r = 0; r < rules.startingCards; r++) for (const hand of g.hands) dealt.push(hand[r]!);
      [...g.deck, ...dealt.reverse()].forEach((n, i) => {
        cards[n] = { id: `c-${i}`, ...faceOf(n) };
      });
    }
    if (options.firstTurnSeat !== undefined) saved.game.turn = options.firstTurnSeat;
    if (options.forcedDeck || options.firstTurnSeat !== undefined) {
      try {
        round = load('cabo', saved);
      } catch (err) {
        INVALID(String((err as Error).message ?? err));
      }
      saved = JSON.parse(round.save()) as CoreSave;
    }

    this.round = round;
    this.rules = rules;
    this.state = {
      stateVersion: 2,
      gameId: 'cabo',
      phase: 'INITIAL_PEEK',
      players: seats,
      hands: {},
      knowledge: {},
      deck: [],
      discard: [],
      currentTurn: 0,
      drawnCard: null,
      pendingPower: null,
      pendingTransfer: null,
      pendingTransfers: [],
      cabo: null,
      initialPeeksRemaining: [],
      initialPeekCardIds: Object.fromEntries(seats.map((p) => [p.id, []])),
      scores: null,
      roundWinnerId: null,
      tiedWinnerIds: [],
      events: [],
      revision: 1,
      eventSeq: 0,
      core: saved,
      cards,
    };
    this.refresh();
    this.emit('ROUND_STARTED', { playerIds: seats.map((p) => p.id) });
    this.emit('CARDS_DEALT', {
      perPlayer: seats.map((p) => ({ playerId: p.id, cardCount: this.state!.hands[p.id]!.length })),
    });
  }

  /**
   * Core numbers for a forced deck. Only a card's rank, and for a king its
   * colour, matter to the rules, so a face given more often than the core
   * has copies of it borrows the number of another suit; the card the table
   * sees stays the one that was given.
   */
  private numberForced(deck: Card[], rules: CaboRules, cards: Record<string, Card>): number[] {
    const kingsDiffer = rules.redKingValue !== rules.blackKingValue;
    const red = (suit: number) => suit === 1 || suit === 2;
    return deck.map((card) => {
      const own = SUITS.indexOf(card.suit);
      const suits = [own, ...[0, 1, 2, 3].filter((s) => s !== own)].filter(
        (s) => !(card.rank === 13 && kingsDiffer) || red(s) === red(own),
      );
      // The core holds card numbers below 128: two full decks and part of a third.
      for (let copy = 0; copy < 3; copy++) {
        for (const suit of suits) {
          const n = copy * 52 + suit * 13 + card.rank - 1;
          if (n < 128 && !(n in cards)) {
            cards[n] = card;
            return n;
          }
        }
      }
      INVALID('too many copies of one card in the forced deck');
    });
  }

  // -------------------------------------------------------------------
  // Queries
  // -------------------------------------------------------------------

  isGameFinished(): boolean {
    const s = this.getState();
    return s.phase === 'ROUND_REVEAL' || s.phase === 'ROUND_COMPLETE';
  }

  calculateScore(): Record<string, number> {
    const s = this.getState();
    return Object.fromEntries(
      s.players.map((p) => [p.id, s.hands[p.id]!.reduce((sum, c) => sum + (c ? cardValue(c, this.rules) : 0), 0)]),
    );
  }

  getPublicState(): unknown {
    const s = this.getState();
    return {
      phase: s.phase,
      currentTurnPlayerId: s.players[s.currentTurn]?.id ?? null,
      deckCount: s.deck.length,
      discardTop: s.discard[s.discard.length - 1] ?? null,
      playerCardCounts: Object.fromEntries(s.players.map((p) => [p.id, liveCount(s.hands[p.id]!)])),
      caboCallerId: s.cabo?.callerId ?? null,
      revision: s.revision,
    };
  }

  getSpectatorView(): ReturnType<typeof buildPlayerView> {
    return buildPlayerView(this.getState(), '__spectator__');
  }

  getPlayerState(viewerId: string, opts?: { revealAll?: boolean }): import('./views.js').CaboPlayerView {
    return buildPlayerView(this.getState(), viewerId, opts);
  }

  // -------------------------------------------------------------------
  // Actions
  // -------------------------------------------------------------------

  validateAction(action: GameAction): boolean {
    try {
      const { seat, move } = this.translate(action as CaboAction);
      return check(this.round!, seat, move) === null;
    } catch {
      return false;
    }
  }

  handleAction(action: GameAction): { ok: boolean; error?: string; events: GameEvent[] } {
    const before = this.getState().eventSeq;
    try {
      this.applyAction(action as CaboAction);
    } catch (err) {
      if (err instanceof CaboEngineError) {
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

  /** The round in the rules core, as it stands (for the model seat; do not change it). */
  get table(): Round {
    return this.round ?? INVALID('game not started');
  }

  /** An action of the rules core, by `seat`, as the action the table takes. */
  fromCore(seat: number, move: unknown): CaboAction {
    const s = this.getState();
    const m = move as CoreAction;
    const playerId = s.players[seat]?.id ?? INVALID('player not in this game');
    const idAt = (owner: number, slot: number): string =>
      s.hands[s.players[owner]?.id ?? '']?.[slot]?.id ?? INVALID('no card in that position');
    const slotsOf = (mask: number): number[] => [...Array(32).keys()].filter((i) => (mask >>> i) & 1);
    switch (m.type) {
      case 'PEEK_STARTING':
        return { type: 'PEEK_STARTING', playerId, cardIndexes: slotsOf(m.slots) };
      case 'DRAW':
      case 'DISCARD_DRAWN':
      case 'CALL_CABO':
      case 'END_TURN':
        return { type: m.type, playerId };
      case 'KEEP':
        return { type: 'KEEP_DRAWN', playerId, handIndex: m.slot };
      case 'PEEK_OWN':
        return { type: 'POWER_APPLY', playerId, payload: { power: 'PEEK_OWN', cardId: idAt(seat, m.slot) } };
      case 'PEEK_OTHER':
        return {
          type: 'POWER_APPLY',
          playerId,
          payload: { power: 'PEEK_OTHER', targetPlayerId: s.players[m.target]!.id, cardId: idAt(m.target, m.slot) },
        };
      case 'BLIND_SWAP':
        return {
          type: 'POWER_APPLY',
          playerId,
          payload: {
            power: 'BLIND_SWAP',
            ownCardId: idAt(seat, m.own),
            targetPlayerId: s.players[m.target]!.id,
            targetCardId: idAt(m.target, m.slot),
          },
        };
      case 'FLUSH_OWN':
        return { type: 'FLUSH_OWN', playerId, cardIds: slotsOf(m.slots).map((i) => idAt(seat, i)) };
      case 'FLUSH_OTHER':
        return { type: 'FLUSH_OTHER', playerId, targetPlayerId: s.players[m.target]!.id, cardId: idAt(m.target, m.slot) };
      case 'TRANSFER':
        return { type: 'TRANSFER_CARD', playerId, cardId: idAt(seat, m.slot) };
      default:
        return INVALID(`unknown action type: ${(m as { type: string }).type}`);
    }
  }

  /** The action as the core takes it: a seat, and hand positions for card ids. */
  private translate(a: CaboAction): { seat: number; move: CoreAction } {
    const s = this.getState();
    const seatOf = (id: string) => s.players.findIndex((p) => p.id === id);
    const seat = seatOf(a.playerId);
    if (seat < 0) INVALID('player not in this game');
    const slotOf = (playerId: string, cardId: string, missing: string): number => {
      const slot = s.hands[playerId]!.findIndex((c) => c?.id === cardId);
      return slot >= 0 ? slot : INVALID(missing);
    };
    const target = (id: string, missing: string): number => {
      const t = seatOf(id);
      return t >= 0 ? t : INVALID(missing);
    };
    const mask = (slots: number[], duplicate: string): number => {
      if (new Set(slots).size !== slots.length) INVALID(duplicate);
      return slots.reduce((m, i) => m | (1 << i), 0) >>> 0;
    };
    switch (a.type) {
      case 'PEEK_STARTING': {
        const hand = s.hands[a.playerId]!;
        for (const i of a.cardIndexes) {
          if (!Number.isInteger(i) || i < 0 || i >= hand.length) INVALID('peek index out of range');
        }
        if (a.cardIndexes.length !== this.rules.initialPeekCards && s.phase === 'INITIAL_PEEK') {
          INVALID(`must peek exactly ${this.rules.initialPeekCards} cards`);
        }
        return { seat, move: { type: 'PEEK_STARTING', slots: mask(a.cardIndexes, 'duplicate peek indexes') } };
      }
      case 'DRAW':
      case 'DISCARD_DRAWN':
      case 'CALL_CABO':
      case 'END_TURN':
        return { seat, move: { type: a.type } };
      case 'KEEP_DRAWN': {
        if (!Number.isInteger(a.handIndex) || a.handIndex < 0 || a.handIndex >= s.hands[a.playerId]!.length) {
          INVALID(s.phase === 'DRAW_DECISION' ? 'hand index out of range' : 'no drawn card to resolve');
        }
        return { seat, move: { type: 'KEEP', slot: a.handIndex } };
      }
      case 'POWER_APPLY': {
        const p = a.payload;
        // Without a power to use there is no card to look for.
        if (!s.pendingPower || s.phase !== 'POWER_PENDING') INVALID('no power pending');
        switch (p.power) {
          case 'PEEK_OWN':
            return { seat, move: { type: 'PEEK_OWN', slot: slotOf(a.playerId, p.cardId, 'card not in your hand') } };
          case 'PEEK_OTHER': {
            const t = target(p.targetPlayerId, 'target not in game');
            return { seat, move: { type: 'PEEK_OTHER', target: t, slot: slotOf(p.targetPlayerId, p.cardId, 'card not in target hand') } };
          }
          case 'BLIND_SWAP': {
            const own = slotOf(a.playerId, p.ownCardId, 'own card not in hand');
            const t = target(p.targetPlayerId, 'must target another player');
            const slot = slotOf(p.targetPlayerId, p.targetCardId, 'target card not in target hand');
            return { seat, move: { type: 'BLIND_SWAP', own, target: t, slot } };
          }
          default:
            INVALID('wrong power action');
        }
      }
      // eslint-disable-next-line no-fallthrough
      case 'FLUSH_OWN': {
        if (a.cardIds.length === 0) INVALID('no cards selected');
        if (new Set(a.cardIds).size !== a.cardIds.length) INVALID('duplicate card in flush');
        const slots = a.cardIds.map((id) => slotOf(a.playerId, id, 'card not in your hand'));
        return { seat, move: { type: 'FLUSH_OWN', slots: mask(slots, 'duplicate card in flush') } };
      }
      case 'FLUSH_OTHER': {
        if (a.playerId === a.targetPlayerId) INVALID('target must be another player');
        const t = target(a.targetPlayerId, 'target not in game');
        return { seat, move: { type: 'FLUSH_OTHER', target: t, slot: slotOf(a.targetPlayerId, a.cardId, 'card not in target hand') } };
      }
      case 'TRANSFER_CARD': {
        if (s.pendingTransfers.length === 0) INVALID('no pending transfer');
        if (!s.pendingTransfers.some((t) => t.fromPlayerId === a.playerId)) INVALID('you have no pending transfer');
        return { seat, move: { type: 'TRANSFER', slot: slotOf(a.playerId, a.cardId, 'card not in your hand') } };
      }
      default:
        INVALID(`unknown action type: ${(a as { type: string }).type}`);
    }
  }

  private applyAction(a: CaboAction): void {
    const { move, seat } = this.translate(a);
    const before = this.getState();
    const was = (before.core as CoreSave).game;
    const refused = apply(this.round!, seat, move);
    if (refused !== null) INVALID(refused);

    // The state is rebuilt, not edited, so `before` still shows the table as
    // it was: the events below name cards by where they lay.
    const prior = { ...before, hands: { ...before.hands } };
    if (a.type === 'PEEK_STARTING') {
      before.initialPeekCardIds[a.playerId] = a.cardIndexes.map((i) => prior.hands[a.playerId]![i]!.id);
    }
    this.refresh();
    this.report(a, prior, was);
  }

  // -------------------------------------------------------------------
  // State, as the views read it
  // -------------------------------------------------------------------

  /** Rewrite the state from the round as the core now has it. */
  private refresh(): void {
    const s = this.state!;
    const saved = JSON.parse(this.round!.save()) as CoreSave;
    const g = saved.game;
    const card = (n: number): Card => s.cards[n] ?? INVALID('unknown card in the round');
    const id = (seat: number): string => s.players[seat]!.id;
    const phase = PHASES[g.phase];

    s.core = saved;
    s.phase = g.transfers.length > 0 ? 'TRANSFER_PENDING' : phase;
    s.deck = g.deck.map(card);
    s.discard = g.discard.map(card);
    s.currentTurn = g.turn;
    s.drawnCard = g.drawn === null ? null : card(g.drawn);
    s.hands = {};
    s.knowledge = {};
    s.players.forEach((p, seat) => {
      s.hands[p.id] = g.hands[seat]!.map((n) => (n === null ? null : card(n)));
      s.knowledge[p.id] = g.known[seat]!.map((n) => card(n).id);
    });
    s.pendingPower = g.pending_power
      ? { playerId: id(g.turn), power: g.pending_power[0], sourceCardId: card(g.pending_power[1]).id }
      : null;
    s.pendingTransfers = g.transfers.map((t) => ({ fromPlayerId: id(t.from), toPlayerId: id(t.to), phaseBefore: phase }));
    s.pendingTransfer = s.pendingTransfers[0] ?? null;
    s.cabo = g.cabo
      ? { callerId: id(g.cabo.caller), takenFinalTurn: g.cabo.taken.flatMap((n, seat) => Array<string>(n).fill(id(seat))) }
      : null;
    s.initialPeeksRemaining = s.players.filter((_, seat) => (g.peeks_remaining >> seat) & 1).map((p) => p.id);
    s.scores = g.result ? Object.fromEntries(g.result.scores.map((v, seat) => [id(seat), v])) : null;
    s.tiedWinnerIds = g.result ? g.result.winners.map(id) : [];
    s.roundWinnerId = s.tiedWinnerIds.length === 1 ? s.tiedWinnerIds[0]! : null;
  }

  // -------------------------------------------------------------------
  // Events
  // -------------------------------------------------------------------

  /**
   * Write the events of one action: what the core logged since `was`, with
   * the cards named as the table knows them, plus the consequences the core
   * leaves to be read off the state (a card now owed, a power that lapsed,
   * the end of the round).
   */
  private report(a: CaboAction, prior: CaboState, was: CoreGame): void {
    const s = this.getState();
    const now = (s.core as CoreSave).game;
    const id = (seat: number): string => s.players[seat]!.id;
    const card = (n: number): Card => s.cards[n]!;
    const actor = a.playerId;
    const ended = now.phase === 'Complete' && was.phase !== 'Complete';
    const flushOrTransfer = a.type === 'FLUSH_OWN' || a.type === 'FLUSH_OTHER' || a.type === 'TRANSFER_CARD';
    const playerOut = ended && flushOrTransfer && this.rules.endRoundWhenPlayerOut;
    const empty = (playerId: string) => liveCount(s.hands[playerId]!) === 0;

    const delta = now.log.slice(was.log.length);
    const isTail = (e: CoreEvent) => typeof e !== 'string' && ('CaboCalled' in e || 'TurnStarted' in e);
    const failedOwn: Card[] = [];
    let flushed = false;
    let failed = false;

    if (a.type === 'PEEK_STARTING') this.emit('INITIAL_PEEKED', { playerId: actor, count: a.cardIndexes.length });
    if (a.type === 'POWER_APPLY') {
      const p = a.payload;
      if (p.power === 'PEEK_OWN') {
        this.emit('POWER_RESOLVED', { playerId: actor, power: 'PEEK_OWN', cardId: p.cardId, viewerId: actor });
      } else if (p.power === 'PEEK_OTHER') {
        this.emit('POWER_RESOLVED', {
          playerId: actor,
          power: 'PEEK_OTHER',
          targetPlayerId: p.targetPlayerId,
          cardId: p.cardId,
          viewerId: actor,
        });
      } else {
        this.emit('POWER_RESOLVED', {
          playerId: actor,
          power: 'BLIND_SWAP',
          ownCardId: p.ownCardId,
          targetPlayerId: p.targetPlayerId,
          targetCardId: p.targetCardId,
        });
        this.emit('POWER_RESOLVED', { playerId: actor, power: p.power });
      }
    }

    for (const e of delta) {
      if (isTail(e)) continue;
      if (e === 'Reshuffled') {
        const drew = delta.some((x) => typeof x !== 'string' && 'Drew' in x);
        this.emit('DECK_RESHUFFLED', { newDeckCount: now.deck.length + (drew ? 1 : 0) });
      } else if (typeof e === 'string') {
        continue;
      } else if ('Drew' in e) {
        this.emit('CARD_DRAWN', { playerId: actor, deckCount: now.deck.length });
      } else if ('Kept' in e) {
        const replaced = card(e.Kept.discarded);
        this.emit('CARD_REPLACED', {
          playerId: actor,
          keptCardId: prior.drawnCard!.id,
          replacedCardId: replaced.id,
          rank: replaced.rank,
        });
      } else if ('Discarded' in e) {
        const c = card(e.Discarded.card);
        this.emit('CARD_DISCARDED', { playerId: actor, cardId: c.id, rank: c.rank });
      } else if ('Flushed' in e) {
        const c = card(e.Flushed.card);
        flushed = true;
        this.emit('CARD_FLUSHED', { playerId: actor, sourcePlayerId: id(e.Flushed.owner), cardId: c.id, rank: c.rank });
      } else if ('FailedFlushOwn' in e) {
        failed = true;
        failedOwn.push(card(e.FailedFlushOwn.card));
      } else if ('FailedFlushOther' in e) {
        failed = true;
        const target = id(e.FailedFlushOther.target);
        this.emit('FAILED_FLUSH_OTHER', {
          playerId: actor,
          targetPlayerId: target,
          cardId: prior.hands[target]![e.FailedFlushOther.slot]!.id,
        });
      } else if ('Transferred' in e) {
        const from = id(e.Transferred.from);
        this.emit('CARD_TRANSFERRED', {
          fromPlayerId: from,
          toPlayerId: id(e.Transferred.to),
          cardId: prior.hands[from]![e.Transferred.from_slot]!.id,
        });
      }
    }

    if (failedOwn.length > 0) {
      this.emit('FAILED_FLUSH_OWN', {
        playerId: actor,
        cardIds: failedOwn.map((c) => c.id),
        ranks: failedOwn.map((c) => c.rank),
      });
    }
    if (failed && this.rules.wrongFlushPenalty > 0) {
      this.emit('PENALTY_DRAWN', { playerId: actor, count: this.rules.wrongFlushPenalty });
    }
    if ((a.type === 'KEEP_DRAWN' || a.type === 'DISCARD_DRAWN') && s.pendingPower) {
      const source = card(now.pending_power![1]);
      this.emit('POWER_TRIGGERED', {
        playerId: actor,
        power: s.pendingPower.power,
        sourceCardId: source.id,
        rank: source.rank,
      });
    }

    // A card flushed from another hand is paid for with one of the flusher's
    // own, unless they have none. Cards owed by a hand that has since emptied
    // are let go.
    let owed = prior.pendingTransfers;
    if (a.type === 'TRANSFER_CARD') {
      const paid = owed.findIndex((t) => t.fromPlayerId === actor);
      owed = owed.filter((_, i) => i !== paid);
    }
    let letGo = a.type === 'TRANSFER_CARD' || (a.type === 'FLUSH_OWN' && flushed);
    if (a.type === 'FLUSH_OTHER' && flushed) {
      if (empty(actor)) {
        this.emit('TRANSFER_SKIPPED', { fromPlayerId: actor, toPlayerId: a.targetPlayerId });
        letGo = true;
      } else {
        this.emit('TRANSFER_REQUIRED', { fromPlayerId: actor, toPlayerId: a.targetPlayerId });
      }
    }
    if (letGo) {
      for (const t of owed) {
        if (empty(t.fromPlayerId)) this.emit('TRANSFER_SKIPPED', { fromPlayerId: t.fromPlayerId, toPlayerId: t.toPlayerId });
      }
    }

    if (prior.pendingPower && !now.pending_power && a.type !== 'POWER_APPLY' && !playerOut) {
      this.emit('POWER_SKIPPED', { playerId: prior.pendingPower.playerId, power: prior.pendingPower.power });
    }
    if (now.phase === 'TurnEnd' && was.phase !== 'TurnEnd') this.emit('TURN_ENDED', { playerId: id(now.turn) });

    for (const e of delta) {
      if (typeof e === 'string') continue;
      if ('CaboCalled' in e) {
        const playerId = id(e.CaboCalled.seat);
        this.emit('CABO_CALLED', e.CaboCalled.auto ? { playerId, auto: true } : { playerId });
      } else if ('TurnStarted' in e) {
        const playerId = id(e.TurnStarted.seat);
        this.emit('TURN_STARTED', a.type === 'PEEK_STARTING' ? { playerId } : { playerId, isFinalTurn: !!now.cabo });
      }
    }

    if (ended) {
      const limit = this.rules.turnLimit;
      const reason =
        a.type === 'DRAW'
          ? 'DECK_EXHAUSTED'
          : playerOut
            ? 'PLAYER_OUT'
            : limit > 0 && now.turns_started >= limit
              ? 'TURN_LIMIT'
              : now.cabo
                ? 'CABO_COMPLETE'
                : 'NO_ELIGIBLE_PLAYER';
      this.emit('ROUND_REVEALED', {
        reason,
        hands: s.players.map((p) => ({ playerId: p.id, cards: s.hands[p.id]!.filter((c): c is Card => !!c) })),
      });
      this.emit('ROUND_SCORED', { scores: s.scores, winners: s.tiedWinnerIds });
    }
  }

  private emit(type: string, payload?: Record<string, unknown>): void {
    const s = this.getState();
    s.eventSeq += 1;
    s.events.push({
      seq: s.eventSeq,
      type,
      // The actor is also given at the top level, where the event contract has it.
      playerId: typeof payload?.playerId === 'string' ? payload.playerId : undefined,
      timestamp: new Date().toISOString(),
      payload,
    });
    s.revision += 1;
  }
}
