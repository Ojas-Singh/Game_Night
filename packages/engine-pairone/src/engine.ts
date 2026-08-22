/**
 * Server-authoritative Pair One engine.
 *
 * Pure state-machine over JSON state: no networking, no timers, no DOM.
 * All validation happens here — clients only ever send intentions.
 */

import {
  SUITS,
  createRng,
  shuffle,
  type Card,
  type GameAction,
  type GameEvent,
  type GamePlayer,
  type Rank,
  type Rng,
} from '@game-night/shared';
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

/** Lightweight structured warn (no card values / secrets). */
function logWarn(msg: string, fields?: Record<string, unknown>): void {
  // eslint-disable-next-line no-console
  console.warn(JSON.stringify({ ts: new Date().toISOString(), level: 'warn', msg, ...fields }));
}

/**
 * `decks` standard 52-card decks combined into one array with globally
 * unique ids (c-0 .. c-52n-1).
 */
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
  readonly stateVersion = 1 as const;

  private state: PairOneState | null = null;
  private rules: PairOneRules = { ...DEFAULT_PAIRONE_RULES };
  private rng: Rng = createRng();

  getState(): PairOneState {
    if (!this.state) INVALID('game not created');
    return this.state;
  }

  getRules(): PairOneRules {
    return this.rules;
  }

  /** Restore a previously serialized state (reconnect / redis restore). */
  restoreState(state: PairOneState): void {
    if (state.stateVersion !== 1) INVALID('unsupported state version');
    this.state = state;
    this.rng = createRng();
  }

  // -------------------------------------------------------------------
  // Lifecycle
  // -------------------------------------------------------------------

  createGame(players: GamePlayer[], options: PairOneGameOptions = {}): void {
    this.rules = { ...DEFAULT_PAIRONE_RULES, ...options.rules };
    const rules = this.rules;
    if (players.length < rules.minPlayers || players.length > rules.maxPlayers) {
      INVALID(`pair one requires ${rules.minPlayers}-${rules.maxPlayers} players`);
    }
    const seats = [...players].sort((a, b) => a.seat - b.seat);
    this.rng = createRng(options.seed);

    const gridCards: Card[] = options.forcedGrid
      ? options.forcedGrid.slice()
      : shuffle(multiDeck(rules.decks), this.rng);

    const state: PairOneState = {
      stateVersion: 1,
      gameId: 'pairone',
      phase: 'TURN',
      players: seats,
      grid: gridCards.slice(),
      currentTurn: options.firstTurnSeat ?? 0,
      flippedThisTurn: [],
      collections: {},
      knowledge: {},
      lastMiss: null,
      scores: null,
      roundWinnerId: null,
      tiedWinnerIds: [],
      events: [],
      revision: 1,
      eventSeq: 0,
    };
    for (const p of seats) {
      state.collections[p.id] = [];
      state.knowledge[p.id] = [];
    }

    this.state = state;
    this.emit('ROUND_STARTED', {
      playerIds: seats.map((p) => p.id),
      cardCount: gridCards.length,
      gridCols: GRID_COLS,
    });
    this.emit('TURN_STARTED', { playerId: this.currentPlayerId() });
  }

  // -------------------------------------------------------------------
  // Queries
  // -------------------------------------------------------------------

  isGameFinished(): boolean {
    return this.getState().phase === 'ROUND_COMPLETE';
  }

  /** Score = pairs collected (higher is better). */
  calculateScore(): Record<string, number> {
    const s = this.getState();
    const out: Record<string, number> = {};
    for (const p of s.players) {
      out[p.id] = Math.floor((s.collections[p.id]?.length ?? 0) / 2);
    }
    return out;
  }

  /** Number of cards still face-down on the table. */
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
      collectedCounts: Object.fromEntries(
        s.players.map((p) => [p.id, Math.floor((s.collections[p.id]?.length ?? 0) / 2)]),
      ),
      revision: s.revision,
    };
  }

  getPlayerState(viewerId: string, opts?: { revealAll?: boolean }): import('./views.js').PairOnePlayerView {
    return buildPlayerView(this.getState(), viewerId, opts);
  }

  // -------------------------------------------------------------------
  // Actions
  // -------------------------------------------------------------------

  validateAction(action: GameAction): boolean {
    try {
      this.checkAction(action as PairOneAction);
      return true;
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

  private findInGrid(cardId: string): number {
    const s = this.getState();
    return s.grid.findIndex((c) => c?.id === cardId);
  }

  private checkAction(a: PairOneAction): void {
    const s = this.getState();
    if (a.type !== 'FLIP_CARD') INVALID(`unknown action type: ${(a as { type: string }).type}`);
    if (!s.players.some((p) => p.id === a.playerId)) INVALID('player not in this game');
    if (s.phase !== 'TURN') INVALID('the round is over');
    if (a.playerId !== this.currentPlayerId()) INVALID('not your turn');
    if (typeof a.cardId !== 'string' || !a.cardId) INVALID('cardId required');
    if (this.findInGrid(a.cardId) < 0) INVALID('card is not on the table');
    if (s.flippedThisTurn.includes(a.cardId)) INVALID('that card is already flipped');
    if (s.flippedThisTurn.length >= 2) INVALID('two cards are already up');
  }

  // -------------------------------------------------------------------
  // Mutations
  // -------------------------------------------------------------------

  private applyAction(a: PairOneAction): void {
    this.checkAction(a);
    const s = this.getState();

    const index = this.findInGrid(a.cardId);
    const card = s.grid[index]!;
    s.lastMiss = null;

    // A flip is PUBLIC: every player sees and remembers the card.
    for (const p of s.players) this.learn(p.id, card.id);
    s.flippedThisTurn.push(card.id);
    this.emit('CARD_FLIPPED', {
      playerId: a.playerId,
      cardId: card.id,
      index,
      rank: card.rank,
      suit: card.suit,
      flipNumber: s.flippedThisTurn.length,
    });

    if (s.flippedThisTurn.length < 2) return; // first flip — turn continues

    // --- Second flip: resolve -------------------------------------
    const [idA, idB] = [s.flippedThisTurn[0]!, s.flippedThisTurn[1]!];
    const idxA = this.findInGrid(idA);
    const idxB = this.findInGrid(idB);
    const cardA = s.grid[idxA]!;
    const cardB = s.grid[idxB]!;
    s.flippedThisTurn = [];

    if (cardA.rank === cardB.rank) {
      // MATCH: collect both cards into the player's pile; same player goes again.
      s.grid[idxA] = null;
      s.grid[idxB] = null;
      s.collections[a.playerId]!.push(cardA, cardB);
      this.emit('PAIR_COLLECTED', {
        playerId: a.playerId,
        cardIds: [cardA.id, cardB.id],
        ranks: [cardA.rank, cardB.rank],
        indexes: [idxA, idxB],
        pairCount: Math.floor(s.collections[a.playerId]!.length / 2),
        again: true,
      });

      if (this.remainingCount() === 0) {
        this.endRound('GRID_EMPTY');
        return;
      }
      this.emit('EXTRA_TURN', { playerId: a.playerId });
      return;
    }

    // MISS: both cards flip back where they were; turn passes left.
    s.lastMiss = { playerId: a.playerId, cardIds: [cardA.id, cardB.id] };
    this.emit('PAIR_MISSED', {
      playerId: a.playerId,
      cardIds: [cardA.id, cardB.id],
      ranks: [cardA.rank, cardB.rank],
    });
    this.advanceTurn();
  }

  // -------------------------------------------------------------------
  // Turn / round progression
  // -------------------------------------------------------------------

  private advanceTurn(): void {
    const s = this.getState();
    // Everyone is always in the game — pass the turn one seat to the left.
    const next = (s.currentTurn + 1) % s.players.length;
    s.currentTurn = next;
    this.emit('TURN_STARTED', { playerId: s.players[next]!.id });
  }

  /**
   * Finalize the round: tally scores, crown winners. Internal, but exposed
   * for persistence/test tooling that finalizes a crafted state.
   */
  finishRound(reason = 'GRID_EMPTY'): void {
    this.endRound(reason);
  }

  private endRound(reason: string): void {
    const s = this.getState();
    s.phase = 'ROUND_COMPLETE';
    s.flippedThisTurn = [];
    const scores = this.calculateScore();
    s.scores = scores;
    const best = Math.max(...Object.values(scores));
    const winners = s.players.filter((p) => scores[p.id] === best).map((p) => p.id);
    s.roundWinnerId = winners.length === 1 ? winners[0]! : null;
    s.tiedWinnerIds = winners;
    this.emit('ROUND_REVEALED', {
      reason,
      collections: Object.fromEntries(s.players.map((p) => [p.id, s.collections[p.id]!.length])),
    });
    this.emit('ROUND_SCORED', { scores, winners });
  }

  // -------------------------------------------------------------------
  // Knowledge & events
  // -------------------------------------------------------------------

  private learn(playerId: string, cardId: string): void {
    const s = this.getState();
    const k = s.knowledge[playerId]!;
    if (!k.includes(cardId)) k.push(cardId);
  }

  private emit(type: string, payload?: Record<string, unknown>, playerId?: string): void {
    const s = this.getState();
    s.eventSeq += 1;
    s.events.push({
      seq: s.eventSeq,
      type,
      playerId,
      timestamp: new Date().toISOString(),
      payload,
    });
    s.revision += 1;
  }
}
