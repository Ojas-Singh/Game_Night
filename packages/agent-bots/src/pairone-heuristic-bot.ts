/**
 * Heuristic Pair One bot — a clean memory strategy:
 *   1. If a known pair sits on the table, collect it.
 *   2. Mid-turn: flip the matching partner of the face-up card.
 *   3. Otherwise flip an unknown slot (new information).
 * Falls back to any legal flip when memory is exhausted.
 */

import type { PairOnePlayerView } from '@game-night/engine-pairone';
import { AgentError, type AgentContext, type AgentDecision, type AgentObservation, type GameAgent } from '@game-night/agent-core';

const real = (id: string): boolean => !id.startsWith('__empty__');

export class PairOneHeuristicBot implements GameAgent {
  readonly id: string;
  readonly label = 'PairOne Heuristic';

  constructor(idSuffix = '') {
    this.id = `pairone-heuristic${idSuffix}`;
  }

  decide(obs: AgentObservation, ctx: AgentContext): AgentDecision {
    const v = obs.view;
    if (v.gameId !== 'pairone') throw new AgentError('PairOneHeuristicBot got a non-pairone view');
    const pv: PairOnePlayerView = v;
    const onTable = pv.gridCardIds.filter(real);
    const faceUp = pv.faceUpCardIds;

    const knownRankOf = (id: string): number | null => pv.knownCards[id]?.rank ?? null;

    // 1. Complete a known pair.
    const byRank = new Map<number, string[]>();
    for (const id of onTable) {
      const r = knownRankOf(id);
      if (r == null) continue;
      const arr = byRank.get(r) ?? [];
      arr.push(id);
      byRank.set(r, arr);
    }

    if (faceUp.length === 1) {
      const upRank = knownRankOf(faceUp[0]!);
      if (upRank != null) {
        const partner = onTable.find((id) => id !== faceUp[0] && knownRankOf(id) === upRank);
        if (partner) {
          return { action: { type: 'FLIP_CARD', playerId: obs.selfId, cardId: partner }, thought: 'partner is right there' };
        }
      }
      const unknown = onTable.filter((id) => knownRankOf(id) == null && !faceUp.includes(id));
      const pick = unknown.length > 0 ? ctx.rng.pick(unknown) : ctx.rng.pick(onTable.filter((id) => !faceUp.includes(id)));
      return { action: { type: 'FLIP_CARD', playerId: obs.selfId, cardId: pick }, thought: 'fishing for the partner' };
    }

    // 2. Open a known pair.
    for (const [, ids] of byRank) {
      if (ids.length >= 2) {
        return { action: { type: 'FLIP_CARD', playerId: obs.selfId, cardId: ids[0]! }, thought: 'I know this pair' };
      }
    }

    // 3. Explore.
    const unknown = onTable.filter((id) => knownRankOf(id) == null);
    if (unknown.length > 0) {
      return { action: { type: 'FLIP_CARD', playerId: obs.selfId, cardId: ctx.rng.pick(unknown) }, thought: 'exploring' };
    }
    return {
      action: { type: 'FLIP_CARD', playerId: obs.selfId, cardId: ctx.rng.pick(onTable) },
      thought: 'all known — best guess',
    };
  }
}
