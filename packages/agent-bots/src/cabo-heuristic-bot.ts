/**
 * Heuristic Cabo bot — plays risk-aware golf: keep low cards, ditch high ones,
 * flush known matches, use powers against the most dangerous hand, and call
 * Cabo only when the estimated lead is worth the risk.
 *
 * This is the always-available fallback for live rooms, so it must remain
 * explainable and view-only while still making decisions from remembered
 * cards, unknown-card expectations, and each selected persona's risk profile.
 */

import type { Card } from '@game-night/shared';
import type { CaboPlayerView } from '@game-night/engine-cabo';
import {
  enumerateLegalActions,
  AgentError,
  type AgentContext,
  type AgentDecision,
  type AgentObservation,
  type GameAgent,
} from '@game-night/agent-core';

/** Average value of an unseen card (rough, includes rare black kings). */
const UNKNOWN_EXPECTATION = 5.6;

function cardValue(c: Card): number {
  if (c.rank === 13) return c.suit === 'spades' || c.suit === 'clubs' ? -1 : 13;
  return c.rank;
}

const isRealCard = (id: string): boolean => !id.startsWith('__slot__');

function ownCardIds(view: CaboPlayerView, playerId: string): string[] {
  return (view.handCardIds[playerId] ?? []).filter(isRealCard);
}

function estimatedCardValue(view: CaboPlayerView, id: string): number {
  const known = view.knownCards[id];
  return known ? cardValue(known) : UNKNOWN_EXPECTATION;
}

function estimatedHandValue(view: CaboPlayerView, playerId: string): number {
  return ownCardIds(view, playerId).reduce((sum, id) => sum + estimatedCardValue(view, id), 0);
}

function worstCard(view: CaboPlayerView, playerId: string): { id: string; index: number; value: number } | null {
  const ids = view.handCardIds[playerId] ?? [];
  let worst: { id: string; index: number; value: number } | null = null;
  ids.forEach((id, index) => {
    if (!isRealCard(id)) return;
    const value = estimatedCardValue(view, id);
    if (!worst || value > worst.value) worst = { id, index, value };
  });
  return worst;
}

function strongestOpponent(view: CaboPlayerView, selfId: string) {
  return view.players
    .filter((p) => p.id !== selfId && p.cardCount > 0)
    .sort((a, b) => estimatedHandValue(view, b.id) - estimatedHandValue(view, a.id))[0];
}

function bestTargetCard(view: CaboPlayerView, playerId: string): string | undefined {
  const ids = ownCardIds(view, playerId);
  // An unknown card is the best blind target: it gives the bot a chance to
  // improve without voluntarily taking a card it already knows is good.
  return ids.find((id) => !view.knownCards[id]) ??
    ids.sort((a, b) => estimatedCardValue(view, b) - estimatedCardValue(view, a))[0];
}

export interface CaboHeuristicOptions {
  /** Estimated hand sum below which the bot calls Cabo (TURN_END). */
  caboThreshold?: number;
  /** Probability of flushing an opponent's KNOWN matching card. */
  flushOtherAggression?: number;
  /** Fallback strategy personality used when no LLM agent is configured. */
  persona?: string;
}

export class CaboHeuristicBot implements GameAgent {
  readonly id: string;
  readonly label: string;
  private readonly caboThreshold: number;
  private readonly flushOtherAggression: number;

  constructor(opts: CaboHeuristicOptions & { idSuffix?: string } = {}) {
    this.id = `cabo-heuristic${opts.idSuffix ?? ''}`;
    this.label = 'Cabo Heuristic';
    const thresholds: Record<string, number> = {
      conservative: 9,
      scholar: 11,
      balanced: 12,
      baiter: 13,
      aggressor: 16,
    };
    const aggression: Record<string, number> = {
      conservative: 0.65,
      scholar: 0.85,
      balanced: 0.92,
      baiter: 0.78,
      aggressor: 1,
    };
    this.caboThreshold = opts.caboThreshold ?? thresholds[opts.persona ?? 'balanced'] ?? 12;
    this.flushOtherAggression = opts.flushOtherAggression ?? aggression[opts.persona ?? 'balanced'] ?? 0.92;
  }

  decide(obs: AgentObservation, ctx: AgentContext): AgentDecision {
    const v = obs.view;
    if (v.gameId !== 'cabo') throw new AgentError('CaboHeuristicBot got a non-cabo view');
    const me = { playerId: obs.selfId };
    const ownIds = ownCardIds(v, obs.selfId);
    const knownOwn = () => ownIds.filter((id) => v.knownCards[id]).map((id) => ({ id, c: v.knownCards[id]! }));

    // --- Free interrupts: flushes -----------------------------------------
    if (v.discardTopRank != null && v.phase !== 'INITIAL_PEEK') {
      const matches = knownOwn().filter((k) => k.c.rank === v.discardTopRank);
      if (matches.length >= 2) {
        return {
          action: { type: 'FLUSH_OWN', ...me, cardIds: [matches[0]!.id, matches[1]!.id] },
          thought: `flushing my pair of ${matches[0]!.c.rank}s`,
        };
      }
      if (matches.length === 1) {
        return { action: { type: 'FLUSH_OWN', ...me, cardIds: [matches[0]!.id] }, thought: 'flushing my match' };
      }
      if (ctx.rng.next() < this.flushOtherAggression) {
        const targets = v.players
          .filter((p) => p.id !== obs.selfId && p.cardCount > 0)
          .map((p) => ({
            player: p,
            hit: ownCardIds(v, p.id).find((id) => v.knownCards[id]?.rank === v.discardTopRank),
          }))
          .filter((x): x is { player: (typeof v.players)[number]; hit: string } => !!x.hit)
          .sort((a, b) => estimatedHandValue(v, b.player.id) - estimatedHandValue(v, a.player.id));
        const target = targets[0];
        if (target) {
          return {
            action: { type: 'FLUSH_OTHER', ...me, targetPlayerId: target.player.id, cardId: target.hit },
            thought: `I remember ${target.player.name} has a ${v.discardTopRank}`,
          };
        }
      }
    }

    switch (v.phase) {
      case 'INITIAL_PEEK':
        return {
          action: { type: 'PEEK_STARTING', ...me, cardIndexes: [1, 3] },
          thought: 'peeking the bottom two cards I will keep track of',
        };

      case 'TURN_DRAW':
        return { action: { type: 'DRAW', ...me }, thought: 'drawing' };

      case 'DRAW_DECISION': {
        const drawn = v.drawnCard;
        if (!drawn) throw new AgentError('DRAW_DECISION without drawn card');
        const dv = cardValue(drawn);
        const worst = worstCard(v, obs.selfId);
        if (worst && dv < worst.value) {
          return {
            action: { type: 'KEEP_DRAWN', ...me, handIndex: worst.index },
            thought: `${dv} beats my estimated ${worst.value.toFixed(1)} — swapping into slot ${worst.index + 1}`,
          };
        }
        return { action: { type: 'DISCARD_DRAWN', ...me }, thought: `discarding ${dv}` };
      }

      case 'POWER_PENDING': {
        const p = v.pendingPower!;
        if (p.power === 'PEEK_OWN') {
          const unknown = ownIds.find((id) => !v.knownCards[id]);
          const fallback = worstCard(v, obs.selfId)?.id ?? ownIds[0]!;
          return {
            action: { type: 'POWER_APPLY', ...me, payload: { power: 'PEEK_OWN', cardId: unknown ?? fallback } },
            thought: unknown ? 'peeking an unknown card of mine' : 'checking my most dangerous card again',
          };
        }
        if (p.power === 'PEEK_OTHER') {
          const target = strongestOpponent(v, obs.selfId);
          if (target) {
            const targetCard = bestTargetCard(v, target.id);
            if (targetCard) {
              return {
                action: { type: 'POWER_APPLY', ...me, payload: { power: 'PEEK_OTHER', targetPlayerId: target.id, cardId: targetCard } },
                thought: `spying on the most dangerous-looking hand: ${target.name}`,
              };
            }
          }
        }
        if (p.power === 'BLIND_SWAP') {
          const give = worstCard(v, obs.selfId);
          const t = strongestOpponent(v, obs.selfId);
          const theirs = t ? bestTargetCard(v, t.id) : undefined;
          if (!give || !t || !theirs) throw new AgentError('BLIND_SWAP without two live hands');
          return {
            action: {
              type: 'POWER_APPLY',
              ...me,
              payload: { power: 'BLIND_SWAP', ownCardId: give.id, targetPlayerId: t.id, targetCardId: theirs },
            },
            thought: `blind-swapping my estimated ${give.value.toFixed(1)} into ${t.name}'s hand`,
          };
        }
        // Other pending powers have no smarter line here: the engine demands
        // a POWER_APPLY, so default to a harmless self-peek.
        return {
          action: { type: 'POWER_APPLY', ...me, payload: { power: 'PEEK_OWN', cardId: ownIds[0]! } },
          thought: 'defaulting to a self-peek',
        };
      }
      case 'TRANSFER_PENDING': {
        const worst = worstCard(v, obs.selfId);
        if (worst) return { action: { type: 'TRANSFER_CARD', ...me, cardId: worst.id }, thought: 'transferring my worst card' };
        return {
          action: { type: 'TRANSFER_CARD', ...me, cardId: ctx.rng.pick(ownIds) },
          thought: 'transferring blind',
        };
      }

      case 'TURN_END': {
        const est = estimatedHandValue(v, obs.selfId);
        const opponents = v.players
          .filter((p) => p.id !== obs.selfId && p.cardCount > 0)
          .map((p) => estimatedHandValue(v, p.id));
        const bestOpponent = opponents.length > 0 ? Math.min(...opponents) : Number.POSITIVE_INFINITY;
        const canCall = !v.cabo && enumerateLegalActions(v, obs.selfId).some((a) => a.type === 'CALL_CABO');
        if (canCall && (est <= this.caboThreshold || est + 2 <= bestOpponent)) {
          return { action: { type: 'CALL_CABO', ...me }, thought: `my hand is ~${est.toFixed(0)} — CABO!` };
        }
        return { action: { type: 'END_TURN', ...me }, thought: 'ending turn' };
      }

      default:
        break;
    }
    throw new AgentError(`CaboHeuristicBot: nothing to do in phase ${v.phase}`);
  }
}
