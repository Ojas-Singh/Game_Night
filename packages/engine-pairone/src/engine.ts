/**
 * Server-authoritative Pair One, played by the rules core.
 *
 * Rules: the deck is shuffled into one face-down grid. On your turn flip two
 * cards — everyone sees every flip. Matching numbers are collected and you
 * flip again; a miss turns both back and the turn passes. Most pairs wins.
 *
 * The core (`core/gamelab`, loaded through `@game-night/core`) holds the
 * round and decides every action. This class names players and cards, keeps
 * the state in the shape the views read, and writes the event log.
 */

import { apply, check, deal, gameInfo, load, type Round } from '@game-night/core';
import { SUITS, type Card, type GameAction, type GameEvent, type GamePlayer, type Rank } from '@game-night/shared';
import { DEFAULT_PAIRONE_RULES, GRID_COLS, type PairOneAction, type PairOneGameOptions, type PairOneRules, type PairOneState } from './types.js';
import { buildPlayerView } from './views.js';

export type { PairOneState } from './types.js';
export { GRID_COLS } from './types.js';

export class PairOneEngineError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PairOneEngineError';
  }
}

function INVALID(msg: string): never {
  throw new PairOneEngineError(msg);
}

function logWarn(msg: string, fields?: Record<string, unknown>): void {
  // eslint-disable-next-line no-console
  console.warn(JSON.stringify({ ts: new Date().toISOString(), level: 'warn', msg, ...fields }));
}

/** The round as `Round.save` writes it (the fields used here). */
interface CoreGame {
  grid: (number | null)[];
  turn: number;
  flipped: number | null;
  collections: number[][];
  last_miss: { seat: number; slots: [number, number] } | null;
  over: boolean;
}

interface CoreSave {
  rules: PairOneRules;
  game: CoreGame;
}

/** The face a card number stands for in the core. */
function faceOf(n: number): { suit: Card['suit']; rank: Rank } {
  return { suit: SUITS[Math.floor((n % 52) / 13)]!, rank: ((n % 13) + 1) as Rank };
}

/** `decks` standard 52-card decks with globally-unique ids. */
export function multiDeck(decks: number): Card[] {
  const cards: Card[] = [];
  let n = 0;
  for (let d = 0; d < decks; d++) {
    for (const suit of SUITS) {
      for (let rank = 1 as Rank; rank <= 13; rank = (rank + 1) as Rank) {
        cards.push({ id: `c-${n++}`, suit, rank });
      }
    }
  }
  return cards;
}

export class PairOneEngine {
  readonly gameId = 'pairone';
  readonly stateVersion = 2 as const;

  private state: PairOneState | null = null;
  private round: Round | null = null;
  private rules: PairOneRules = { ...DEFAULT_PAIRONE_RULES };

  getState(): PairOneState {
    if (!this.state) INVALID('game not created');
    return this.state;
  }

  getRules(): PairOneRules {
    return this.rules;
  }

  /** Restore a previously serialized state (reconnect / redis restore). The
   *  round continues from `state.core`. */
  restoreState(state: PairOneState): void {
    if (state.stateVersion !== 2) INVALID('unsupported state version');
    try {
      this.round = load('pairone', state.core);
    } catch (err) {
      INVALID(String((err as Error).message ?? err));
    }
    this.rules = (state.core as CoreSave).rules;
    this.state = state;
    this.refresh();
  }

  // -------------------------------------------------------------------
  // Game creation
  // -------------------------------------------------------------------

  createGame(players: GamePlayer[], options: PairOneGameOptions = {}): void {
    const rules: PairOneRules = { ...DEFAULT_PAIRONE_RULES, ...options.rules };
    const info = gameInfo('pairone');
    if (players.length < info.minPlayers || players.length > info.maxPlayers) {
      INVALID(`pair one requires ${info.minPlayers}-${info.maxPlayers} players`);
    }
    const seats = [...players].sort((a, b) => a.seat - b.seat);

    let round: Round;
    try {
      round = deal('pairone', rules, seats.length, options.seed);
    } catch (err) {
      INVALID(String((err as Error).message ?? err));
    }
    const saved = JSON.parse(round.save()) as CoreSave;
    const cards: Record<string, Card> = {};
    if (options.forcedGrid) {
      saved.game.grid = this.numberForced(options.forcedGrid, cards);
    } else {
      // A card's id is its place in the grid, so it says nothing about the face.
      saved.game.grid.forEach((n, i) => {
        cards[n!] = { id: `c-${i}`, ...faceOf(n!) };
      });
    }
    if (options.firstTurnSeat !== undefined) saved.game.turn = options.firstTurnSeat;
    if (options.forcedGrid || options.firstTurnSeat !== undefined) {
      try {
        round = load('pairone', saved);
      } catch (err) {
        INVALID(String((err as Error).message ?? err));
      }
    }

    this.round = round;
    this.rules = rules;
    this.state = {
      stateVersion: 2,
      gameId: 'pairone',
      core: null,
      cards,
      phase: 'TURN',
      players: seats,
      grid: [],
      currentTurn: 0,
      flippedThisTurn: [],
      collections: {},
      knowledge: Object.fromEntries(seats.map((p) => [p.id, []])),
      lastMiss: null,
      scores: null,
      roundWinnerId: null,
      tiedWinnerIds: [],
      events: [],
      revision: 1,
      eventSeq: 0,
    };
    this.refresh();
    this.emit('ROUND_STARTED', {
      playerIds: seats.map((p) => p.id),
      cardCount: this.state.grid.length,
      gridCols: GRID_COLS,
    });
    this.emit('TURN_STARTED', { playerId: this.currentPlayerId() });
  }

  /** Core numbers for a forced grid: each card gets a free number of its own
   *  rank (the core holds numbers below 128), its own suit when that is free. */
  private numberForced(grid: Card[], cards: Record<string, Card>): number[] {
    return grid.map((card) => {
      const own = SUITS.indexOf(card.suit);
      const suits = [own, ...[0, 1, 2, 3].filter((s) => s !== own)];
      for (let copy = 0; copy < 3; copy++) {
        for (const suit of suits) {
          const n = copy * 52 + suit * 13 + card.rank - 1;
          if (n < 128 && !(n in cards)) {
            cards[n] = card;
            return n;
          }
        }
      }
      INVALID('too many copies of one rank in the forced grid');
    });
  }

  // -------------------------------------------------------------------
  // Queries
  // -------------------------------------------------------------------

  isGameFinished(): boolean {
    return this.getState().phase === 'ROUND_COMPLETE';
  }

  /** Score = pairs collected. */
  calculateScore(): Record<string, number> {
    const s = this.getState();
    const out: Record<string, number> = {};
    for (const p of s.players) {
      out[p.id] = Math.floor((s.collections[p.id]?.length ?? 0) / 2);
    }
    return out;
  }

  /** Cards still on the table. */
  remainingCount(): number {
    const s = this.getState();
    return s.grid.reduce((n, c) => (c ? n + 1 : n), 0);
  }

  getPublicState(): unknown {
    const s = this.getState();
    return {
      phase: s.phase,
      currentTurnPlayerId: s.players[s.currentTurn]?.id ?? null,
      remainingCount: this.remainingCount(),
      collectedCounts: this.calculateScore(),
      revision: s.revision,
    };
  }

  getSpectatorView(): ReturnType<typeof buildPlayerView> {
    return buildPlayerView(this.getState(), '__spectator__');
  }

  getPlayerState(viewerId: string, opts?: { revealAll?: boolean }): import('./views.js').PairOnePlayerView {
    return buildPlayerView(this.getState(), viewerId, opts);
  }

  // -------------------------------------------------------------------
  // Action entry points
  // -------------------------------------------------------------------

  validateAction(action: GameAction): boolean {
    try {
      const { seat, slot } = this.translate(action as PairOneAction);
      return check(this.round!, seat, { type: 'FLIP', slot }) === null;
    } catch {
      return false;
    }
  }

  handleAction(action: GameAction): { ok: boolean; error?: string; events: GameEvent[] } {
    const before = this.getState().eventSeq;
    try {
      this.applyAction(action as PairOneAction);
    } catch (err) {
      if (err instanceof PairOneEngineError) {
        return { ok: false, error: err.message, events: [] };
      }
      logWarn('invalid_action_shape', { type: (action as { type?: string }).type, error: String(err) });
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

  /** The action in the core's terms: a seat and a place in the grid. A card
   *  that is not on the table becomes a place outside the grid, so the core
   *  still gives its refusals in order. */
/** The round in the rules core, as it stands (for the model seat; do not change it). */
  get table(): Round {
    return this.round ?? INVALID('game not started');
  }

  /** An action of the rules core, by `seat`, as the action the table takes. */
  fromCore(seat: number, move: unknown): PairOneAction {
    const s = this.getState();
    const m = move as { type: string; slot: number };
    const playerId = s.players[seat]?.id ?? INVALID('player not in this game');
    if (m.type !== 'FLIP') INVALID(`unknown action type: ${m.type}`);
    return { type: 'FLIP_CARD', playerId, cardId: s.grid[m.slot]?.id ?? INVALID('card is not on the table') };
  }

    private translate(a: PairOneAction): { seat: number; slot: number } {
    const s = this.getState();
    if (a.type !== 'FLIP_CARD') INVALID(`unknown action type: ${(a as { type: string }).type}`);
    const seat = s.players.findIndex((p) => p.id === a.playerId);
    if (seat < 0) INVALID('player not in this game');
    const slot = s.grid.findIndex((c) => c?.id === a.cardId);
    return { seat, slot: slot < 0 ? 255 : slot };
  }

  private applyAction(a: PairOneAction): void {
    const { seat, slot } = this.translate(a);
    const s = this.getState();
    const refused = apply(this.round!, seat, { type: 'FLIP', slot });
    if (refused !== null) {
      const noId = typeof a.cardId !== 'string' || !a.cardId;
      INVALID(noId && refused === 'card is not on the table' ? 'cardId required' : refused);
    }

    const first = s.flippedThisTurn[0];
    const firstIndex = s.grid.findIndex((c) => c?.id === first);
    const card = s.grid[slot]!;
    const firstCard = s.grid[firstIndex];
    const was = s.currentTurn;
    this.refresh();

    for (const p of s.players) {
      const k = s.knowledge[p.id]!;
      if (!k.includes(card.id)) k.push(card.id);
    }
    this.emit('CARD_FLIPPED', {
      playerId: a.playerId,
      cardId: card.id,
      index: slot,
      rank: card.rank,
      suit: card.suit,
      flipNumber: firstCard ? 2 : 1,
    });
    if (!firstCard) return; // first flip — turn continues

    if (firstCard.rank === card.rank) {
      const again = s.phase === 'ROUND_COMPLETE' || s.currentTurn === was;
      this.emit('PAIR_COLLECTED', {
        playerId: a.playerId,
        cardIds: [firstCard.id, card.id],
        ranks: [firstCard.rank, card.rank],
        indexes: [firstIndex, slot],
        pairCount: Math.floor(s.collections[a.playerId]!.length / 2),
        again,
      });
      if (s.phase === 'ROUND_COMPLETE') {
        this.emit('ROUND_REVEALED', {
          reason: 'GRID_EMPTY',
          collections: Object.fromEntries(s.players.map((p) => [p.id, s.collections[p.id]!.length])),
        });
        this.emit('ROUND_SCORED', { scores: s.scores!, winners: s.tiedWinnerIds });
      } else if (again) {
        this.emit('EXTRA_TURN', { playerId: a.playerId });
      } else {
        this.emit('TURN_STARTED', { playerId: this.currentPlayerId() });
      }
      return;
    }

    this.emit('PAIR_MISSED', {
      playerId: a.playerId,
      cardIds: [firstCard.id, card.id],
      ranks: [firstCard.rank, card.rank],
    });
    this.emit('TURN_STARTED', { playerId: this.currentPlayerId() });
  }

  /** Rewrite the table's view of the round from the core's. */
  private refresh(): void {
    const s = this.getState();
    const saved = JSON.parse(this.round!.save()) as CoreSave;
    const g = saved.game;
    const card = (n: number): Card => s.cards[n] ?? INVALID('the saved round holds an unknown card');
    s.core = saved;
    s.phase = g.over ? 'ROUND_COMPLETE' : 'TURN';
    s.grid = g.grid.map((n) => (n === null ? null : card(n)));
    s.currentTurn = g.turn;
    s.flippedThisTurn = g.flipped === null ? [] : [s.grid[g.flipped]!.id];
    s.collections = Object.fromEntries(s.players.map((p, i) => [p.id, g.collections[i]!.map(card)]));
    s.lastMiss = g.last_miss
      ? { playerId: s.players[g.last_miss.seat]!.id, cardIds: g.last_miss.slots.map((i) => s.grid[i]!.id) }
      : null;
    if (g.over) {
      const scores = this.calculateScore();
      const best = Math.max(...Object.values(scores));
      const winners = s.players.filter((p) => scores[p.id] === best).map((p) => p.id);
      s.scores = scores;
      s.roundWinnerId = winners.length === 1 ? winners[0]! : null;
      s.tiedWinnerIds = winners;
    }
  }

  private emit(type: string, payload?: Record<string, unknown>): void {
    const s = this.getState();
    s.eventSeq += 1;
    s.events.push({
      seq: s.eventSeq,
      type,
      playerId: undefined,
      timestamp: new Date().toISOString(),
      payload,
    });
    s.revision += 1;
  }
}
