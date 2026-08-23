/**
 * Random bot — uniform over enumerated candidate actions. The arena's
 * calibration floor: every real agent should crush this.
 */

import {
  enumerateLegalActions,
  type AgentContext,
  type AgentDecision,
  type AgentObservation,
  type GameAgent,
  type AnyGameAction,
} from '@game-night/agent-core';

export class RandomBot implements GameAgent {
  readonly id: string;
  readonly label = 'Random';

  constructor(idSuffix = '') {
    this.id = `random${idSuffix}`;
  }

  decide(obs: AgentObservation, ctx: AgentContext): AgentDecision {
    const candidates: AnyGameAction[] = enumerateLegalActions(obs.view, obs.selfId);
    if (candidates.length === 0) {
      throw new Error(`random bot: no candidate actions in phase ${obs.view.phase}`);
    }
    return { action: ctx.rng.pick(candidates), thought: 'random' };
  }
}
