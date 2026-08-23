/**
 * Episode runner — plays one full round headlessly: no sockets, no server,
 * engines driven directly. This is the self-play workhorse: thousands of
 * these run in parallel during training generations.
 */

import type { GameId } from '@game-night/agent-core';
import { enumerateLegalActions, EpisodeRecorder, createAgentRng, AgentError, type GameAgent } from '@game-night/agent-core';
import { RandomBot } from '@game-night/agent-bots';
import { EngineWorld } from './world.js';

export interface EpisodeOptions {
  gameId: GameId;
  seed: number;
  /** Seat-ordered agents. */
  agents: GameAgent[];
  recordSteps?: boolean;
  recordRawViews?: boolean;
  /** Hard step cap so a buggy agent can't hang the arena. */
  maxSteps?: number;
  /**
   * Called once the episode's EngineWorld exists — lets search bots (MC)
   * bind their worldFactory to THIS episode before deciding.
   */
  bindWorld?: (world: EngineWorld) => void;
}

export interface EpisodeOutcome {
  record: ReturnType<EpisodeRecorder['finish']> | null;
  scores: Record<string, number>;
  winnerIds: string[];
  steps: number;
  aborted: boolean;
}

const STEP_CAPS: Record<GameId, number> = { cabo: 3000, pairone: 3000 };

export async function runEpisode(opts: EpisodeOptions): Promise<EpisodeOutcome> {
  const players = opts.agents.map((a, i) => ({ id: `p${i}`, name: a.label, seat: i }));
  const world = EngineWorld.create(opts.gameId, players, opts.seed);
  opts.bindWorld?.(world);
  const rng = createAgentRng(opts.seed ^ 0x5f3759df);
  const recorder = new EpisodeRecorder(
    {
      gameId: opts.gameId,
      seed: opts.seed,
      players: players.map((p, i) => ({ id: p.id, name: p.name, agentId: opts.agents[i]!.id })),
    },
    { recordSteps: opts.recordSteps ?? false, recordRawViews: opts.recordRawViews ?? false },
  );

  const cap = opts.maxSteps ?? STEP_CAPS[opts.gameId] ?? 3000;
  let step = 0;
  for (; step < cap; step++) {
    if (world.isTerminal()) break;
    const who = world.selfToAct();
    if (who == null) break;
    const seatIdx = players.findIndex((p) => p.id === who);
    const agent = opts.agents[seatIdx];
    if (!agent) break;
    const view = world.viewFor(who);
    let decision;
    try {
      decision = await agent.decide({ gameId: opts.gameId, selfId: who, view, step }, { rng });
    } catch (err) {
      // Agent blew up: fall back to random so the episode still completes.
      if (!(err instanceof AgentError)) throw err;
      const candidates = enumerateLegalActions(view, who);
      if (candidates.length === 0) break;
      decision = { action: rng.pick(candidates), thought: `fallback after ${String(err)}` };
    }
    recorder.step(view, who, agent.id, decision);
    if (!world.apply(decision.action)) {
      // Illegal proposal: one random retry, then random until something lands.
      const candidates = enumerateLegalActions(view, who).filter((a) => world.validate(a));
      let applied = false;
      for (let t = 0; t < 3 && !applied && candidates.length > 0; t++) {
        applied = world.apply(rng.pick(candidates));
      }
      if (!applied) {
        // Give the seat a random legal action or abort the episode.
        const legal = enumerateLegalActions(view, who);
        if (legal.length === 0 || !world.apply(legal[0]!)) {
          return finish(world, recorder, opts, step, true);
        }
      }
    }
  }
  return finish(world, recorder, opts, step, false);
}

function finish(
  world: EngineWorld,
  recorder: EpisodeRecorder,
  opts: EpisodeOptions,
  steps: number,
  aborted: boolean,
): EpisodeOutcome {
  const scores = world.finalScores();
  const ids = Object.keys(scores);
  const higher = opts.gameId === 'pairone';
  const best = higher
    ? Math.max(...ids.map((id) => scores[id] ?? 0))
    : Math.min(...ids.map((id) => scores[id] ?? Infinity));
  const winnerIds = ids.filter((id) => scores[id] === best);
  const record = recorder.finish(scores, higher);
  return { record, scores, winnerIds, steps, aborted };
}

/** Convenience for tests: did every agent stay legal for a whole episode? */
export async function assertLegalEpisode(opts: EpisodeOptions): Promise<void> {
  const outcome = await runEpisode(opts);
  if (outcome.aborted) throw new Error(`episode aborted (illegal actions) seed=${opts.seed}`);
}
