import { describe, expect, it } from 'vitest';
import type { Card, GamePlayer, Rank, Suit } from '@game-night/shared';
import { GRID_COLS, PairOneEngine, multiDeck } from '../src/index.js';

export const S = 'spades' as const;
export const H = 'hearts' as const;
export const D = 'diamonds' as const;
export const CL = 'clubs' as const;

export const c = (id: string, suit: Suit, rank: Rank): Card => ({ id, suit, rank });

function players(n: number): GamePlayer[] {
  return Array.from({ length: n }, (_, i) => ({ id: `p${i + 1}`, name: `Player ${i + 1}`, seat: i }));
}

/** A deterministic 8-card grid (2×4) for focused rules tests. */
function miniGrid(): Card[] {
  return [
    c('g0', S, 7),
    c('g1', H, 3),
    c('g2', D, 7),
    c('g3', CL, 3),
    c('g4', H, 5),
    c('g5', S, 5),
    c('g6', D, 2),
    c('g7', CL, 2),
  ];
}

function setup(opts?: { players?: number; grid?: Card[]; firstTurnSeat?: number }): PairOneEngine {
  const engine = new PairOneEngine();
  engine.createGame(players(opts?.players ?? 2), {
    forcedGrid: opts?.grid ?? miniGrid(),
    firstTurnSeat: opts?.firstTurnSeat ?? 0,
  });
  return engine;
}

function mustOk(engine: PairOneEngine, action: Parameters<PairOneEngine['handleAction']>[0]) {
  const res = engine.handleAction(action);
  if (!res.ok) throw new Error(`expected ${action.type} to succeed, got: ${res.error}`);
  return res;
}

function mustFail(engine: PairOneEngine, action: Parameters<PairOneEngine['handleAction']>[0], msg?: string) {
  const res = engine.handleAction(action);
  if (res.ok) throw new Error(`expected ${action.type} to fail${msg ? ` (${msg})` : ''}`);
  return res;
}

const flip = (playerId: string, cardId: string) => ({ type: 'FLIP_CARD' as const, playerId, cardId });

describe('Pair One — setup', () => {
  it('deals two full decks into a 104-card grid', () => {
    const engine = new PairOneEngine();
    engine.createGame(players(3), {});
    const s = engine.getState();
    expect(s.grid.length).toBe(104);
    expect(s.grid.every((card) => card !== null)).toBe(true);
    // Unique ids: two decks → 104 distinct cards.
    const ids = new Set(s.grid.map((card) => card!.id));
    expect(ids.size).toBe(104);
    expect(multiDeck(2).length).toBe(104);
    expect(engine.remainingCount()).toBe(104);
    // First player to act is seat 0.
    expect(s.players[s.currentTurn]!.id).toBe('p1');
    expect(s.phase).toBe('TURN');
  });

  it('rejects invalid table sizes', () => {
    const engine = new PairOneEngine();
    expect(() => engine.createGame(players(1))).toThrow(/2-6/);
    expect(() => engine.createGame(players(7))).toThrow(/2-6/);
  });

  it('respects firstTurnSeat', () => {
    const engine = setup({ firstTurnSeat: 1 });
    expect(engine.getState().players[engine.getState().currentTurn]!.id).toBe('p2');
  });
});

describe('Pair One — flipping', () => {
  it('only the current player may flip, and only table cards', () => {
    const engine = setup();
    mustFail(engine, flip('p2', 'g0'), 'not your turn');
    mustFail(engine, flip('p1', 'nope'), 'not on the table');
    mustFail(engine, flip('p1', ''), 'cardId required');
    mustOk(engine, flip('p1', 'g0'));
    // Same card twice is rejected.
    mustFail(engine, flip('p1', 'g0'), 'already flipped');
  });

  it('first flip stays revealed mid-turn; everyone learns the card', () => {
    const engine = setup();
    mustOk(engine, flip('p1', 'g0'));
    const s = engine.getState();
    expect(s.flippedThisTurn).toEqual(['g0']);
    expect(s.phase).toBe('TURN');
    expect(s.players[s.currentTurn]!.id).toBe('p1');
    // Every player (public flip) now knows g0 = 7♠.
    for (const p of ['p1', 'p2']) {
      expect(engine.getPlayerState(p).knownCards.g0).toMatchObject({ rank: 7, suit: S });
    }
    // Unflipped cards stay hidden.
    expect(engine.getPlayerState('p1').knownCards.g1).toBeUndefined();
  });

  it('a matching pair is collected and the same player goes again', () => {
    const engine = setup();
    mustOk(engine, flip('p1', 'g0')); // 7♠
    mustOk(engine, flip('p1', 'g2')); // 7♦ — match!
    const s = engine.getState();
    expect(s.collections.p1!.map((x) => x.id)).toEqual(['g0', 'g2']);
    expect(s.grid[0]).toBeNull();
    expect(s.grid[2]).toBeNull();
    expect(s.flippedThisTurn).toEqual([]);
    // Same player continues.
    expect(s.players[s.currentTurn]!.id).toBe('p1');
    expect(engine.calculateScore().p1).toBe(1);
    // Collected cards are gone from the table.
    mustFail(engine, flip('p1', 'g0'), 'not on the table');
  });

  it('a miss flips both cards back (in place) and passes the turn', () => {
    const engine = setup();
    mustOk(engine, flip('p1', 'g0')); // 7♠
    mustOk(engine, flip('p1', 'g1')); // 3♥ — miss
    const s = engine.getState();
    // Cards remain on the table at their exact positions.
    expect(s.grid[0]?.id).toBe('g0');
    expect(s.grid[1]?.id).toBe('g1');
    expect(s.flippedThisTurn).toEqual([]);
    expect(s.lastMiss).toEqual({ playerId: 'p1', cardIds: ['g0', 'g1'] });
    // Turn passed to p2.
    expect(s.players[s.currentTurn]!.id).toBe('p2');
    // ...and the missed values are remembered by everyone (memory game).
    expect(engine.getPlayerState('p2').knownCards.g1).toMatchObject({ rank: 3 });
  });

  it('the second flip resolves immediately — no third flip in a turn', () => {
    const engine = setup();
    mustOk(engine, flip('p1', 'g0'));
    mustOk(engine, flip('p1', 'g1')); // miss → p2's turn
    mustFail(engine, flip('p1', 'g3'), 'not your turn');
    mustOk(engine, flip('p2', 'g4'));
    mustOk(engine, flip('p2', 'g5')); // 5+5 match → p2 continues
    mustOk(engine, flip('p2', 'g6'));
    mustOk(engine, flip('p2', 'g7')); // 2+2 match again
    const s = engine.getState();
    expect(s.players[s.currentTurn]!.id).toBe('p2');
    expect(engine.calculateScore().p2).toBe(2);
  });

  it('emits a readable public event trail', () => {
    const engine = setup();
    mustOk(engine, flip('p1', 'g0'));
    mustOk(engine, flip('p1', 'g2'));
    const types = engine.getState().events.map((e) => e.type);
    expect(types).toEqual(['ROUND_STARTED', 'TURN_STARTED', 'CARD_FLIPPED', 'CARD_FLIPPED', 'PAIR_COLLECTED', 'EXTRA_TURN']);
    const collected = engine.getState().events.at(-2)!.payload as { pairCount: number; again: boolean };
    expect(collected.pairCount).toBe(1);
    expect(collected.again).toBe(true);
  });
});

describe('Pair One — end of round', () => {
  it('finishes when the grid is empty; most pairs wins', () => {
    const engine = setup();
    // Two probing misses: everyone learns 7s and 3s.
    mustOk(engine, flip('p1', 'g0'));
    mustOk(engine, flip('p1', 'g1'));
    mustOk(engine, flip('p2', 'g2'));
    mustOk(engine, flip('p2', 'g3'));
    // p1 takes the remembered 7s…
    mustOk(engine, flip('p1', 'g0'));
    mustOk(engine, flip('p1', 'g2'));
    // …then gambles and misses (3♣ + unknown), passing left.
    mustOk(engine, flip('p1', 'g3'));
    mustOk(engine, flip('p1', 'g4'));
    expect(engine.getState().players[engine.getState().currentTurn]!.id).toBe('p2');
    // p2 sweeps the 5s, the 2s and finally the remembered 3s — the grid
    // empties on that last match: round over.
    mustOk(engine, flip('p2', 'g4'));
    mustOk(engine, flip('p2', 'g5'));
    mustOk(engine, flip('p2', 'g6'));
    mustOk(engine, flip('p2', 'g7'));
    mustOk(engine, flip('p2', 'g1'));
    const res = mustOk(engine, flip('p2', 'g3'));
    expect(res.events.map((e) => e.type)).toEqual([
      'CARD_FLIPPED',
      'PAIR_COLLECTED',
      'ROUND_REVEALED',
      'ROUND_SCORED',
    ]);
    const s = engine.getState();
    expect(s.phase).toBe('ROUND_COMPLETE');
    expect(engine.isGameFinished()).toBe(true);
    expect(s.scores).toEqual({ p1: 1, p2: 3 });
    expect(s.roundWinnerId).toBe('p2');
    expect(s.tiedWinnerIds).toEqual(['p2']);
    // No further flips accepted.
    mustFail(engine, flip('p1', 'g0'), 'round is over');
  });

  it('round-end math crowns a single winner or records a tie', () => {
    // Craft a finished-table snapshot: p1 has one pair, p2 none.
    const engine = setup({ grid: [c('a', S, 4), c('b', H, 4), c('e', S, 9), c('f', H, 9)] });
    mustOk(engine, flip('p1', 'a'));
    mustOk(engine, flip('p1', 'b')); // p1 collects the 4s
    const snap = JSON.parse(JSON.stringify(engine.getState())) as ReturnType<PairOneEngine['getState']>;
    snap.grid = []; // pretend the rest of the table was cleared

    const solo = new PairOneEngine();
    solo.restoreState(snap);
    solo.finishRound();
    expect(solo.getState().scores).toEqual({ p1: 1, p2: 0 });
    expect(solo.getState().roundWinnerId).toBe('p1');

    // Give p2 a pair too → dead heat.
    const tieSnap = JSON.parse(JSON.stringify(snap));
    const nineS = { id: 'e', suit: 'spades', rank: 9 };
    const nineH = { id: 'f', suit: 'hearts', rank: 9 };
    tieSnap.collections.p2 = [nineS, nineH];
    const tied = new PairOneEngine();
    tied.restoreState(tieSnap);
    tied.finishRound();
    const t = tied.getState();
    expect(t.scores).toEqual({ p1: 1, p2: 1 });
    expect(t.roundWinnerId).toBeNull();
    expect(t.tiedWinnerIds).toEqual(['p1', 'p2']);
  });

  it('a final MATCH on the last two cards ends the round immediately', () => {
    const grid = [c('a', S, 4), c('b', H, 4)];
    const engine = setup({ grid });
    mustOk(engine, flip('p1', 'a'));
    mustOk(engine, flip('p1', 'b'));
    const s = engine.getState();
    expect(s.phase).toBe('ROUND_COMPLETE');
    expect(s.scores).toEqual({ p1: 1, p2: 0 });
    expect(s.roundWinnerId).toBe('p1');
  });

  it('a miss never ends the round by itself — cards flip back for next time', () => {
    // Synthetic odd leftovers (impossible with full double decks, which keep
    // every rank count even): documents that only collection empties the grid.
    const grid = [c('a', S, 4), c('b', H, 8)];
    const engine = setup({ grid });
    mustOk(engine, flip('p1', 'a'));
    mustOk(engine, flip('p1', 'b'));
    expect(engine.getState().phase).toBe('TURN');
    expect(engine.remainingCount()).toBe(2);
    expect(engine.isGameFinished()).toBe(false);
  });
});

describe('Pair One — views', () => {
  it('surfaces the grid with placeholders for collected slots', () => {
    const engine = setup();
    mustOk(engine, flip('p1', 'g0'));
    mustOk(engine, flip('p1', 'g2')); // collect the 7s
    const v = engine.getPlayerState('p2');
    expect(v.gameId).toBe('pairone');
    expect(v.gridCols).toBe(GRID_COLS);
    expect(v.gridCardIds[0]).toBe('__empty__0');
    expect(v.gridCardIds[1]).toBe('g1');
    expect(v.gridCardIds[2]).toBe('__empty__2');
    expect(v.remainingCount).toBe(6);
    expect(v.faceUpCardIds).toEqual([]);
    expect(v.collections.p1!.map((x) => x.id)).toEqual(['g0', 'g2']);
    expect(v.players.find((p) => p.id === 'p1')!.cardCount).toBe(1);
  });

  it('faceUpCardIds exposes the mid-turn flip', () => {
    const engine = setup();
    mustOk(engine, flip('p1', 'g0'));
    const v = engine.getPlayerState('p2');
    expect(v.faceUpCardIds).toEqual(['g0']);
    expect(v.knownCards.g0).toBeDefined();
  });

  it('hides unflipped values but revealAll exposes the table', () => {
    const engine = setup();
    const v = engine.getPlayerState('p1');
    expect(Object.keys(v.knownCards)).toEqual([]);
    const t = engine.getPlayerState('p1', { revealAll: true });
    expect(Object.keys(t.knownCards).length).toBe(8);
  });

  it('state round-trips through restoreState', () => {
    const engine = setup();
    mustOk(engine, flip('p1', 'g0'));
    const snapshot = JSON.parse(JSON.stringify(engine.getState()));
    // restoreState adopts the handed-over object, so remember the pre-restore
    // sequence before continuing on the restored engine.
    const seqBeforeRestore = snapshot.eventSeq;
    const restored = new PairOneEngine();
    restored.restoreState(snapshot);
    mustOk(restored, flip('p1', 'g2'));
    expect(restored.calculateScore().p1).toBe(1);
    expect(restored.getState().eventSeq).toBe(seqBeforeRestore + 3);
  });
});
