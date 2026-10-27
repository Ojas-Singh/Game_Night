/**
 * Cabo agent backed by a Laya decision service (POST {url}/decide with
 * {state, questions} -> {answers: {qid: label}}). Any failure — service down,
 * timeout, an answer that maps to no legal move — falls back to the heuristic
 * bot, so a game never stalls on the model.
 */
import {
  AgentError,
  type AgentContext,
  type AgentDecision,
  type AgentObservation,
  type GameAgent,
} from '@game-night/agent-core';
import type { CaboPlayerView } from '@game-night/engine-cabo';
import { CaboHeuristicBot } from './cabo-heuristic-bot.js';
import { buildDecision, candidateMoves, relabelView, stateText } from './laya-cabo.js';

export interface LayaBotOptions {
  url: string;
  timeoutMs?: number;
  idSuffix?: string;
}

export class LayaCaboBot implements GameAgent {
  readonly id: string;
  readonly label = 'Laya';
  private readonly url: string;
  private readonly timeoutMs: number;
  private readonly fallback: CaboHeuristicBot;

  constructor(opts: LayaBotOptions) {
    this.id = `laya-cabo${opts.idSuffix ?? ''}`;
    this.url = opts.url.replace(/\/+$/, '');
    this.timeoutMs = opts.timeoutMs ?? 8_000;
    this.fallback = new CaboHeuristicBot({ persona: 'balanced', idSuffix: opts.idSuffix });
  }

  describe(): Record<string, unknown> {
    return { kind: 'laya', url: this.url };
  }

  async decide(obs: AgentObservation, ctx: AgentContext): Promise<AgentDecision> {
    if (obs.gameId !== 'cabo') throw new AgentError('Laya only plays Cabo');
    const view = obs.view as CaboPlayerView;
    const fallback = (why: string): AgentDecision => {
      const d = this.fallback.decide(obs, ctx);
      return { ...d, meta: { ...(d.meta ?? {}), source: 'fallback', provider: 'laya', failure: 'agent_error' }, thought: `laya ${why}` };
    };
    // Interrupts (out-of-turn flushes) and the starting peek stay heuristic.
    if (ctx.interruptOnly || view.phase === 'INITIAL_PEEK') return this.fallback.decide(obs, ctx);
    const moves = candidateMoves(view, obs.selfId, ctx.rng);
    const allowed = ctx.allowedActions;
    if (moves.length === 0) return fallback('no moves');
    if (moves.length === 1) return { action: moves[0]!, meta: { source: 'heuristic' } };
    const named = relabelView(view, obs.selfId);
    const { questions, decode } = buildDecision(moves, named, obs.selfId);
    const t0 = Date.now();
    try {
      const res = await fetch(`${this.url}/decide`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ state: stateText(named, obs.selfId), questions }),
        signal: AbortSignal.timeout(this.timeoutMs),
      });
      if (!res.ok) return fallback(`http ${res.status}`);
      const body = (await res.json()) as { answers?: Record<string, string> };
      const action = body.answers ? decode(body.answers) : null;
      if (!action) return fallback('undecodable answer');
      if (allowed && !allowed.some((a) => JSON.stringify(a) === JSON.stringify(action))) return fallback('not allowed');
      return { action, meta: { source: 'model', provider: 'laya', latencyMs: Date.now() - t0, candidateCount: moves.length } };
    } catch (err) {
      return fallback(err instanceof Error && err.name === 'TimeoutError' ? 'timeout' : 'unreachable');
    }
  }
}
