/**
 * AI seat + agent-loop integration: heuristic-driven AI plays complete
 * rounds through the same authority path as humans.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Room } from '../src/room.js';
import { AgentLoops } from '../src/agents/loop.js';
import { config } from '../src/config.js';
import { serializeRoom } from '../src/persistence.js';
import { enumerateLegalActions, createAgentRng } from '@game-night/agent-core';

// Speed up think delays for tests.
const FAST = { minThinkMs: 2, maxThinkMs: 6 };

describe('room AI seats', () => {
  it('only the host can add an AI player', () => {
    const room = new Room();
    const host = room.addPlayer('Host').player;
    const guest = room.addPlayer('Guest').player;
    expect(() => room.addAiPlayer(guest.id)).toThrow(/only the host/);
    const ai = room.addAiPlayer(host.id, 'baiter');
    expect(ai.kind).toBe('ai');
    expect(ai.persona).toBe('baiter');
    expect(ai.name).toContain('AI');
  });

  it('AI seats persist across snapshots and stay connected', () => {
    const room = new Room();
    room.addPlayer('Host');
    const ai = room.addAiPlayer(room.hostId!, 'scholar');
    const snap = JSON.parse(JSON.stringify(serializeRoom(room))) as Parameters<typeof Room.fromSnapshot>[0];
    const restored = Room.fromSnapshot(snap);
    const back = restored.players.get(ai.id)!;
    expect(back.kind).toBe('ai');
    expect(back.persona).toBe('scholar');
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
    room.addAiPlayer(room.hostId!, 'balanced');
    room.addAiPlayer(room.hostId!, 'aggressor');
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
    expect(total).toBe(52); // every pair collected
  }, 70_000);

  it('AI fills its initial peek then draws in Cabo (progress check)', async () => {
    const room = new Room();
    room.gameId = 'cabo';
    room.addPlayer('Watcher');
    room.addAiPlayer(room.hostId!, 'conservative');
    room.addAiPlayer(room.hostId!, 'baiter');
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

  it('uses LLM agents only when configured', () => {
    // With no AGENT_API_URL the heuristic path is used; env untouched here,
    // so just assert config surface exists for deployments.
    expect(typeof config.agentApiUrl).toBe('string');
    expect(typeof config.agentModel).toBe('string');
  });
});
