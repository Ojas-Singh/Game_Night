/**
 * Episode runner — plays one full round headlessly: no sockets, no server,
 * engines driven directly. This is the self-play workhorse: thousands of
 * these run in parallel during training generations.
 */

import type { GameId } from '@game-night/agent-core';
import {
  enumerateLegalActions,
  EpisodeRecorder,
  createAgentRng,
  AgentError,
  type GameAgent,
  type AnyGameAction,
  type FallbackReason,
  type StepEntry,
} from '@game-night/agent-core';
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

const STEP_CAPS: Record<GameId, number> = { cabo: 3000, pairone: 3000, seep: 3000 };

export async function runEpisode(opts: EpisodeOptions): Promise<EpisodeOutcome> {
  const players = opts.agents.map((a, i) => ({ id: `p${i}`, name: a.label, seat: i }));
  const world = EngineWorld.create(opts.gameId, players, opts.seed);
  opts.bindWorld?.(world);
  const rng = createAgentRng(opts.seed ^ 0x5f3759df);
  const recorder = new EpisodeRecorder(
    {
      gameId: opts.gameId,
      seed: opts.seed,
      players: players.map((p, i) => ({ id: p.id, name: p.name, seat: i, agentId: opts.agents[i]!.id })),
    },
    {
      recordSteps: opts.recordSteps ?? false,
      recordRawViews: opts.recordRawViews ?? false,
      agentConfigurations: Object.fromEntries(
        opts.agents.map((a) => [a.id, typeof a.describe === 'function' ? a.describe() : {}]),
      ),
    },
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
    // --- decision phase: preserve proposal vs execution separately ----------
    let entry: StepEntry;
    try {
      const t0 = Date.now();
      const decision = await agent.decide({ gameId: opts.gameId, selfId: who, view, step }, { rng });
      const latencyMs = Date.now() - t0;
      const proposed = decision.action as AnyGameAction | null;
      const proposalWasLegal = proposed != null && world.validate(proposed);
      if (proposalWasLegal) {
        entry = { decision, proposedAction: proposed, proposalWasLegal, fallbackUsed: false, latencyMs };
      } else {
        const candidates = enumerateLegalActions(view, who).filter((a) => world.validate(a));
        if (candidates.length === 0) break;
        entry = {
          decision: { action: rng.pick(candidates), thought: decision.thought },
          proposedAction: proposed,
          proposalWasLegal,
          fallbackUsed: true,
          fallbackReason: 'illegal_proposal' as FallbackReason,
          latencyMs,
        };
      }
    } catch (err) {
      // Agent blew up: substitute a neutral random legal move, but RECORD the
      // failure — never credit the model with a move it did not make.
      if (!(err instanceof AgentError)) throw err;
      const candidates = enumerateLegalActions(view, who).filter((a) => world.validate(a));
      if (candidates.length === 0) break;
      entry = {
        decision: { action: rng.pick(candidates) },
        proposedAction: null,
        proposalWasLegal: false,
        fallbackUsed: true,
        fallbackReason: 'agent_error' as FallbackReason,
      };
    }
    recorder.step(view, who, agent.id, entry);
    if (!world.apply(entry.decision.action)) {
      // Last-resort engine rejection (validate raced state): random retries.
      const candidates = enumerateLegalActions(view, who).filter((a) => world.validate(a));
      let applied = false;
      for (let t = 0; t < 3 && !applied && candidates.length > 0; t++) {
        applied = world.apply(rng.pick(candidates));
      }
      if (!applied) {
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
