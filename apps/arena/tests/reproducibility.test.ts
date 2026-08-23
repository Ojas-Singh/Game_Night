/**
 * Research data-plane guarantees (RuleZero week 1):
 *  - identical config → bit-identical canonical trajectory;
 *  - different seed → different trajectory;
 *  - proposed vs executed actions are recorded distinctly, including
 *    fallbacks (a heuristic substitution must never masquerade as a choice).
 */

import { describe, expect, it } from 'vitest';
import { runEpisode } from '../src/index.js';
import type { EpisodeRecord } from '@game-night/agent-core';
import { PairOneHeuristicBot } from '@game-night/agent-bots';
import type { GameAgent, AgentDecision } from '@game-night/agent-core';

/** Strip wall-clock noise so two runs of one experiment compare equal. */
function canonical(rec: EpisodeRecord): unknown {
  const { startedAt: _s, finishedAt: _f, episodeId: _e, ...rest } = rec;
  return {
    ...rest,
    steps: rest.steps.map(({ latencyMs: _l, decisionId: _d, ...s }) => s),
  };
}

class AlwaysIllegalAgent implements GameAgent {
  readonly id = 'always-illegal';
  readonly label = 'Always Illegal';
  constructor(private readonly inner: GameAgent) {}
  decide(obs: Parameters<GameAgent['decide']>[0], ctx: Parameters<GameAgent['decide']>[1]): Promise<AgentDecision> | AgentDecision {
    // Propose a structurally-plausible but ILLEGAL move: flip an occupied card.
    const grid = (obs.view as { gridCardIds?: string[] }).gridCardIds ?? [];
    const faceUp = new Set((obs.view as { faceUpCardIds?: string[] }).faceUpCardIds ?? []);
    const dead = grid.find((id) => id && !id.startsWith('__empty__') && !faceUp.has(id));
    if (!dead) return this.inner.decide(obs, ctx);
    return {
      action: { type: 'FLIP_CARD', playerId: obs.selfId, cardId: `bogus-${dead}` } as AgentDecision['action'],
      thought: 'deliberately illegal proposal',
    };
  }
}

describe('research reproducibility', () => {
  it('same seed and agents produce identical canonical trajectories', async () => {
    const mk = () => [new PairOneHeuristicBot('-a'), new PairOneHeuristicBot('-b')] as const;
    const a = await runEpisode({ gameId: 'pairone', seed: 777, agents: [...mk()], recordSteps: true });
    const b = await runEpisode({ gameId: 'pairone', seed: 777, agents: [...mk()], recordSteps: true });
    expect(a.aborted).toBe(false);
    expect(JSON.stringify(canonical(a.record!))).toBe(JSON.stringify(canonical(b.record!)));
  });

  it('a different seed yields a different trajectory', async () => {
    const a = await runEpisode({ gameId: 'pairone', seed: 1, agents: [new PairOneHeuristicBot('-a'), new PairOneHeuristicBot('-b')], recordSteps: true });
    const b = await runEpisode({ gameId: 'pairone', seed: 2, agents: [new PairOneHeuristicBot('-a'), new PairOneHeuristicBot('-b')], recordSteps: true });
    expect(canonical(a.record!)).not.toEqual(canonical(b.record!));
  });

  it('records carry full provenance', async () => {
    const out = await runEpisode({ gameId: 'pairone', seed: 5, agents: [new PairOneHeuristicBot('-a'), new PairOneHeuristicBot('-b')], recordSteps: true });
    const rec = out.record!;
    expect(rec.schemaVersion).toBe(2);
    expect(rec.rulesHash).toMatch(/^[0-9a-f]{40}$/);
    expect(rec.seatPermutation).toEqual(['p0', 'p1']);
    expect(Object.keys(rec.agentConfigurations)).toContain('pairone-heuristic-a');
    expect(rec.result!.returns.p0).toBeTypeOf('number');
    for (const st of rec.steps) {
      expect(st.decisionId).toMatch(/-d\d+$/);
      expect(st.observationHash).toMatch(/^[0-9a-f]{40}$/);
      expect(typeof st.executedAction.type).toBe('string');
    }
  }, 60_000);

  it('illegal proposals are preserved as proposals, not credited as choices', async () => {
    const inner = new PairOneHeuristicBot('-x');
    const out = await runEpisode({
      gameId: 'pairone',
      seed: 31,
      agents: [new AlwaysIllegalAgent(inner), new PairOneHeuristicBot('-y')],
      recordSteps: true,
      maxSteps: 400,
    });
    expect(out.aborted).toBe(false);
    const bad = out.record!.steps.filter((st) => st.agentId === 'always-illegal');
    expect(bad.length).toBeGreaterThan(0);
    for (const st of bad) {
      expect(st.proposalWasLegal).toBe(false);
      expect(st.fallbackUsed).toBe(true);
      expect(st.fallbackReason ?? 'illegal_proposal').toBe('illegal_proposal');
      expect(String((st.proposedAction as { cardId?: string })?.cardId ?? '')).not.toBe(
        String((st.executedAction as { cardId?: string }).cardId),
      );
      expect(st.decisionKind).toBe('fallback');
    }
  }, 60_000);

  it('clean agents record proposal === execution with no fallback', async () => {
    const out = await runEpisode({ gameId: 'pairone', seed: 12, agents: [new PairOneHeuristicBot('-a'), new PairOneHeuristicBot('-b')], recordSteps: true });
    for (const st of out.record!.steps) {
      expect(st.fallbackUsed).toBe(false);
      expect(st.proposalWasLegal).toBe(true);
      expect(JSON.stringify(st.proposedAction)).toBe(JSON.stringify(st.executedAction));
      expect(st.decisionKind).toBe('agent');
    }
  }, 60_000);
});
