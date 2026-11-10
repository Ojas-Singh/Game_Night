/**
 * AI seats played by the trained model: whole rounds through the same
 * authority path as people, with the tiny random-weights fixture model.
 */
import { describe, expect, it } from 'vitest';
import { fileURLToPath } from 'node:url';
import { createAgentRng, enumerateLegalActions } from '@game-night/agent-core';
import { Room } from '../src/room.js';
import { AgentLoops } from '../src/agents/loop.js';
import { ModelPlayer } from '../src/agents/model.js';
import type { AiDecisionTrace } from '../src/protocol.js';

const FIXTURE = fileURLToPath(new URL('./fixtures/model', import.meta.url));
const FAST = { minThinkMs: 2, maxThinkMs: 6 };

describe('model seats', () => {
  for (const [gameId, ais] of [['cabo', 2], ['pairone', 1], ['seep', 3]] as const) {
    it(`plays a round of ${gameId} at a table with a person`, async () => {
      const model = await ModelPlayer.load(FIXTURE, { samples: 2 });
      const room = new Room();
      const host = room.addPlayer('Host').player;
      room.gameId = gameId;
      for (let i = 0; i < ais; i += 1) room.addAiPlayer(host.id);
      room.startGame(host.id);
      room.setAiDebug(host.id, true);
      const traces = new Map<string, AiDecisionTrace>();
      const loops = new AgentLoops(
        {} as never,
        { afterChange: () => undefined, aiThought: (_room, trace) => void traces.set(trace.id, trace) },
        { ...FAST, model },
      );
      const rng = createAgentRng(5);
      const over = (): boolean => {
        const phase = (room.engine!.getState() as { phase: string }).phase;
        return room.engine!.isGameFinished() || ['ROUND_COMPLETE', 'ROUND_REVEAL', 'DEAL_COMPLETE', 'MATCH_COMPLETE'].includes(phase);
      };
      try {
        loops.notify(room);
        const deadline = Date.now() + 100_000;
        while (!over() && Date.now() < deadline) {
          // The person plays any legal move in turn (and never flushes out of turn).
          const view = room.gameView(host.id)!;
          const mine = enumerateLegalActions(view, host.id).filter(
            (a) => a.type !== 'FLUSH_OWN' && a.type !== 'FLUSH_OTHER' && room.engine!.validateAction(a),
          );
          if (mine.length > 0) {
            room.handleGameAction(host.id, rng.pick(mine));
            loops.notify(room);
          }
          await new Promise((resolve) => setTimeout(resolve, 3));
        }
        expect(over()).toBe(true);
      } finally {
        loops.dispose();
      }
      const done = [...traces.values()];
      expect(done.length).toBeGreaterThan(3);
      // Every AI decision came from the model; none fell back to a heuristic bot.
      expect(done.filter((t) => !t.source.startsWith('Model'))).toEqual([]);
      const failures = done.filter((t) => t.status === 'failed' && t.failure !== 'stale_decision');
      expect(failures.map((t) => `${t.failure}: ${t.summary}`)).toEqual([]);
      expect(done.some((t) => t.status === 'executed' && t.decisionSource === 'model')).toBe(true);
    }, 120_000);
  }
});
