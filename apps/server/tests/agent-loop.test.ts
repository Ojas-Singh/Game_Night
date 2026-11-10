/**
 * AI seat + agent-loop integration: heuristic-driven AI plays complete
 * rounds through the same authority path as humans.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Room } from '../src/room.js';
import { AgentLoops } from '../src/agents/loop.js';
import { serializeRoom } from '../src/persistence.js';
import { enumerateLegalActions, createAgentRng } from '@game-night/agent-core';
import { CaboEngine } from '@game-night/engine-cabo';
import type { Card } from '@game-night/shared';

// Speed up think delays for tests.
const FAST = { minThinkMs: 2, maxThinkMs: 6 };

describe('room AI seats', () => {
  it('only the host can add an AI player', () => {
    const room = new Room();
    const host = room.addPlayer('Host').player;
    const guest = room.addPlayer('Guest').player;
    expect(() => room.addAiPlayer(guest.id)).toThrow(/only the host/);
    const ai = room.addAiPlayer(host.id);
    expect(ai.kind).toBe('ai');
    expect(ai.name).toBe('AI');
    expect(room.addAiPlayer(host.id).name).toBe('AI Ada');
  });

  it('AI seats persist across snapshots and stay connected', () => {
    const room = new Room();
    room.addPlayer('Host');
    const ai = room.addAiPlayer(room.hostId!);
    const snap = JSON.parse(JSON.stringify(serializeRoom(room))) as Parameters<typeof Room.fromSnapshot>[0];
    const restored = Room.fromSnapshot(snap);
    const back = restored.players.get(ai.id)!;
    expect(back.kind).toBe('ai');
    expect(back.connected).toBe(true);
  });

});

describe('AgentLoops', () => {
  let loops: AgentLoops;
  beforeAll(() => {
    loops = new AgentLoops({} as never, { afterChange: () => undefined }, FAST);
  });
  afterAll(() => loops.dispose());

  it('drives a full Pair One round between two AIs', async () => {
    const room = new Room();
    room.addPlayer('Watcher'); // host watches two machines play
    room.gameId = 'pairone';
    room.addAiPlayer(room.hostId!);
    room.addAiPlayer(room.hostId!);
    room.startGame(room.hostId!);
    expect(room.engine).not.toBeNull();

    // Drive BOTH sides: the agent loop plays AI seats; we play the human.
    const rng = createAgentRng(99);
    loops.notify(room);
    const deadline = Date.now() + 60_000;
    while (!room.engine!.isGameFinished() && Date.now() < deadline) {
      const s = room.engine!.getState();
      if (s.phase !== 'ROUND_COMPLETE') {
        const who =
          s.phase === 'INITIAL_PEEK' && 'initialPeeksRemaining' in s
            ? s.initialPeeksRemaining[0]
            : s.players[s.currentTurn]?.id;
        const seat = who ? room.players.get(who) : undefined;
        if (who && seat?.kind === 'human') {
          const view = room.gameView(who)!;
          const candidates = enumerateLegalActions(view, who).filter((a) => room.engine!.validateAction(a));
          if (candidates.length > 0) {
            room.handleGameAction(who, rng.pick(candidates));
            loops.notify(room);
          }
        }
      }
      await new Promise((r) => setTimeout(r, 10));
    }
    expect(room.engine!.isGameFinished()).toBe(true);
    const scores = room.engine!.calculateScore();
    const total = Object.values(scores).reduce((a, b) => a + b, 0);
    expect(total).toBe(26); // every pair collected (single 52-card deck)
  }, 70_000);

  it('AI fills its initial peek then draws in Cabo (progress check)', async () => {
    const room = new Room();
    room.gameId = 'cabo';
    room.addPlayer('Watcher');
    room.addAiPlayer(room.hostId!);
    room.addAiPlayer(room.hostId!);
    room.startGame(room.hostId!);
    const rng2 = createAgentRng(7);
    loops.notify(room);
    const deadline = Date.now() + 20_000;
    while (Date.now() < deadline) {
      const st = room.engine!.getState();
      if (st.phase === 'INITIAL_PEEK' && 'initialPeeksRemaining' in st) {
        const who = st.initialPeeksRemaining[0];
        const seat = who ? room.players.get(who) : undefined;
        if (who && seat?.kind === 'human') {
          const view = room.gameView(who)!;
          const cands = enumerateLegalActions(view, who).filter((a) => room.engine!.validateAction(a));
          if (cands.length > 0) {
            room.handleGameAction(who, rng2.pick(cands));
            loops.notify(room);
          }
        }
      } else break;
      await new Promise((r) => setTimeout(r, 10));
    }
    const s = room.engine!.getState() as { phase: string };
    expect(s.phase).not.toBe('INITIAL_PEEK');
    loops.dispose(); // stop this suite's timers before next test re-creates
  }, 25_000);

  /**
   * A two-seat Cabo table (host, then the AI) dealt from a known deck: the
   * host holds 4♠ 4♥ 4♦ 7♠, the AI 9♠ 4♣ 9♥ 2♠ and the first card drawn is
   * the 4 of `drawn`. Both have seen their bottom row (cards 1 and 3).
   */
  function fixedCabo(room: Room, firstTurnSeat: number): CaboEngine {
    const card = (id: string, suit: Card['suit'], rank: Card['rank']): Card => ({ id, suit, rank });
    const order = [
      card('h0', 'spades', 4), card('a0', 'spades', 9),
      card('h1', 'hearts', 4), card('a1', 'clubs', 4),
      card('h2', 'diamonds', 4), card('a2', 'hearts', 9),
      card('h3', 'spades', 7), card('a3', 'spades', 2),
      card('drawn', 'clubs', 4),
      ...Array.from({ length: 20 }, (_, i) => card(`f${i}`, i % 2 ? 'hearts' : 'spades', (5 + (i % 2)) as Card['rank'])),
    ];
    const cabo = new CaboEngine();
    const seats = [...room.players.values()].map((p, i) => ({ id: p.id, name: p.name, seat: i }));
    cabo.createGame(seats, { forcedDeck: order.reverse(), firstTurnSeat });
    for (const p of seats) {
      expect(cabo.handleAction({ type: 'PEEK_STARTING', playerId: p.id, cardIndexes: [1, 3] }).ok).toBe(true);
    }
    room.engine = cabo;
    return cabo;
  }

  it('wakes an AI flusher to complete a pending card transfer', async () => {
    const room = new Room();
    const host = room.addPlayer('Watcher').player;
    const ai = room.addAiPlayer(room.hostId!);
    room.startGame(room.hostId!);
    const cabo = fixedCabo(room, 0);
    // The host throws a 4; the AI flushes one of the host's 4s onto it.
    expect(cabo.handleAction({ type: 'DRAW', playerId: host.id }).ok).toBe(true);
    expect(cabo.handleAction({ type: 'DISCARD_DRAWN', playerId: host.id }).ok).toBe(true);
    expect(cabo.handleAction({
      type: 'FLUSH_OTHER',
      playerId: ai.id,
      targetPlayerId: host.id,
      cardId: 'h0',
    }).ok).toBe(true);
    expect(cabo.getState().phase).toBe('TRANSFER_PENDING');

    const transferLoops = new AgentLoops({} as never, { afterChange: () => undefined }, FAST);
    try {
      transferLoops.notify(room);
      const deadline = Date.now() + 1_000;
      while (cabo.getState().pendingTransfer && Date.now() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      expect(cabo.getState().pendingTransfer).toBeNull();
    } finally {
      transferLoops.dispose();
    }
  }, 5_000);

  it('lets an AI flush a known card during a human player turn', async () => {
    const room = new Room();
    const host = room.addPlayer('Human turn').player;
    const ai = room.addAiPlayer(host.id);
    room.startGame(host.id);
    const cabo = fixedCabo(room, 1);
    // The AI throws the 4 it drew and passes the turn: the host is to draw,
    // a 4 is on top, and the AI has seen the 4 in its own hand.
    expect(cabo.handleAction({ type: 'DRAW', playerId: ai.id }).ok).toBe(true);
    expect(cabo.handleAction({ type: 'DISCARD_DRAWN', playerId: ai.id }).ok).toBe(true);
    expect(cabo.handleAction({ type: 'END_TURN', playerId: ai.id }).ok).toBe(true);
    const hostSeat = cabo.getState().players.findIndex((player) => player.id === host.id);
    expect(cabo.getState().currentTurn).toBe(hostSeat);
    expect(cabo.getState().phase).toBe('TURN_DRAW');
    const holdsKnown = (): boolean => cabo.getState().hands[ai.id]!.some((held) => held?.id === 'a1');

    room.setAiDebug(host.id, true);
    const updates: Array<{ id: string; status: string; version: number }> = [];
    const interruptLoops = new AgentLoops({} as never, {
      afterChange: () => undefined,
      aiThought: (_room, trace) => { updates.push({ id: trace.id, status: trace.status, version: trace.version }); },
    }, FAST);
    try {
      interruptLoops.notify(room);
      const deadline = Date.now() + 1_000;
      while (holdsKnown() && Date.now() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      expect(holdsKnown()).toBe(false);
      expect(cabo.getState().currentTurn).toBe(hostSeat);
      expect(new Set(updates.map((update) => update.id)).size).toBe(1);
      expect(updates.at(-1)?.status).toBe('executed');
      expect(updates.at(-1)?.version).toBeGreaterThan(1);
    } finally {
      interruptLoops.dispose();
    }
  }, 5_000);

  it('keeps Test Mode private from an AI seat', () => {
    const room = new Room();
    const host = room.addPlayer('Watcher').player;
    const ai = room.addAiPlayer(host.id);
    room.startGame(host.id);
    room.setTestMode(host.id, true);
    const humanView = room.gameView(host.id)!;
    const aiView = room.gameView(ai.id, { forAi: true })!;
    expect(Object.keys(humanView.knownCards).length).toBeGreaterThan(Object.keys(aiView.knownCards).length);
    expect(Object.keys(aiView.knownCards)).not.toEqual(Object.keys(humanView.knownCards));
  });
});
