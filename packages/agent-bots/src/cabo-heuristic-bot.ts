/**
 * Heuristic Cabo bot — plays risk-aware golf: keep low cards, ditch high ones,
 * flush known matches, use powers against the hand closest to winning, and
 * call Cabo only when the call is likely to hold up: it follows what the
 * table has shown about every hand (cabo-beliefs.ts) and plays the last round
 * out many times before calling.
 *
 * This is the always-available fallback for live rooms, so it must remain
 * explainable and view-only while still making decisions from remembered
 * cards, unknown-card expectations, and each selected persona's risk profile.
 */

import type { CaboPlayerView } from '@game-night/engine-cabo';
import {
  enumerateLegalActions,
  AgentError,
  type AgentContext,
  type AgentDecision,
  type AgentObservation,
  type GameAgent,
} from '@game-night/agent-core';
import { cardValue, chanceCallWins, readBeliefs, type Beliefs } from './cabo-beliefs.js';

const isRealCard = (id: string): boolean => !id.startsWith('__slot__');

function ownCardIds(view: CaboPlayerView, playerId: string): string[] {
  return (view.handCardIds[playerId] ?? []).filter(isRealCard);
}

function handValue(view: CaboPlayerView, b: Beliefs, playerId: string): number {
  return ownCardIds(view, playerId).reduce((sum, id) => sum + b.expected(id), 0);
}

function worstCard(view: CaboPlayerView, b: Beliefs, playerId: string): { id: string; index: number; value: number } | null {
  const ids = view.handCardIds[playerId] ?? [];
  let worst: { id: string; index: number; value: number } | null = null;
  ids.forEach((id, index) => {
    if (!isRealCard(id)) return;
    const value = b.expected(id);
    if (!worst || value > worst.value) worst = { id, index, value };
  });
  return worst;
}

type Rng = { next(): number };

/** Fisher-Yates on a copy: ties below are broken at random, not by seat or slot order (which always singled out
 *  the lowest seat and the first unknown slot). */
function shuffled<T>(xs: T[], rng?: Rng): T[] {
  const a = [...xs];
  if (!rng) return a;
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(rng.next() * (i + 1));
    [a[i], a[j]] = [a[j]!, a[i]!];
  }
  return a;
}

/** The opponent closest to winning: the lowest hand as far as this seat can tell. */
function leadingOpponent(view: CaboPlayerView, b: Beliefs, selfId: string, rng?: Rng) {
  return shuffled(view.players.filter((p) => p.id !== selfId && p.cardCount > 0), rng)
    .sort((x, y) => handValue(view, b, x.id) - handValue(view, b, y.id))[0];
}

/** The card worth most to take: the lowest any opponent holds, as far as this seat can tell. */
function bestCardToTake(view: CaboPlayerView, b: Beliefs, selfId: string, rng?: Rng) {
  const cards = view.players
    .filter((p) => p.id !== selfId)
    .flatMap((p) => ownCardIds(view, p.id).map((id) => ({ player: p, id, value: b.expected(id) })));
  return shuffled(cards, rng).sort((x, y) => x.value - y.value)[0];
}

/** Chance of winning the round at which a call is worth it, by number of players. */
const CALL_CONFIDENCE: Record<number, number> = { 2: 0.65, 3: 0.55, 4: 0.45 };

export interface CaboHeuristicOptions {
  /** Chance of winning the round at which the bot calls Cabo; the default depends on the number of players. */
  callConfidence?: number;
  /** Probability of flushing an opponent's KNOWN matching card. */
  flushOtherAggression?: number;
  /** Strategy style preset (balanced, baiter, conservative, aggressor, scholar). */
  persona?: string;
}

export class CaboHeuristicBot implements GameAgent {
  readonly id: string;
  readonly label: string;
  private readonly callConfidence: number | undefined;
  private readonly callShift: number;
  private readonly flushOtherAggression: number;

  constructor(opts: CaboHeuristicOptions & { idSuffix?: string } = {}) {
    this.id = `cabo-heuristic${opts.idSuffix ?? ''}`;
    this.label = 'Cabo Heuristic';
    // How much surer, or less sure, than the default each style wants to be before calling.
    const shifts: Record<string, number> = {
      conservative: 0.1,
      scholar: 0.05,
      balanced: 0,
      baiter: -0.05,
      aggressor: -0.1,
    };
    const aggression: Record<string, number> = {
      conservative: 0.65,
      scholar: 0.85,
      balanced: 0.92,
      baiter: 0.78,
      aggressor: 1,
    };
    this.callConfidence = opts.callConfidence;
    this.callShift = shifts[opts.persona ?? 'balanced'] ?? 0;
    this.flushOtherAggression = opts.flushOtherAggression ?? aggression[opts.persona ?? 'balanced'] ?? 0.92;
  }

  decide(obs: AgentObservation, ctx: AgentContext): AgentDecision {
    const v = obs.view;
    if (v.gameId !== 'cabo') throw new AgentError('CaboHeuristicBot got a non-cabo view');
    const me = { playerId: obs.selfId };
    const b = readBeliefs(v, obs.selfId);
    const ownIds = ownCardIds(v, obs.selfId);
    const knownOwn = () => ownIds.filter((id) => v.knownCards[id]).map((id) => ({ id, c: v.knownCards[id]! }));

    // A flush is a true Cabo interrupt: it may be submitted while another
    // player owns the normal turn. The loop supplies only validated flush
    // candidates in this mode, so never fall through to DRAW or END_TURN.
    if (ctx.interruptOnly) {
      const interrupts = (ctx.allowedActions ?? []).filter((action) => action.type === 'FLUSH_OWN' || action.type === 'FLUSH_OTHER');
      if (interrupts.length === 0) throw new AgentError('no Cabo flush interrupt available');
      const ownPair = interrupts.find((action) => action.type === 'FLUSH_OWN' && action.cardIds.length > 1);
      const chosen = ownPair ?? interrupts.find((action) => action.type === 'FLUSH_OWN') ?? interrupts[0]!;
      return { action: chosen, thought: 'flushing a known matching card immediately' };
    }

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
          .sort((x, y) => handValue(v, b, x.player.id) - handValue(v, b, y.player.id));
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
        const worst = worstCard(v, b, obs.selfId);
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
          const fallback = worstCard(v, b, obs.selfId)?.id ?? ownIds[0]!;
          return {
            action: { type: 'POWER_APPLY', ...me, payload: { power: 'PEEK_OWN', cardId: unknown ?? fallback } },
            thought: unknown ? 'peeking an unknown card of mine' : 'checking my most dangerous card again',
          };
        }
        if (p.power === 'PEEK_OTHER') {
          // Look where it matters: the hand closest to winning, at a card not yet seen.
          const unseen = (id: string): boolean => !v.knownCards[id];
          const target =
            shuffled(v.players.filter((x) => x.id !== obs.selfId && ownCardIds(v, x.id).some(unseen)), ctx.rng)
              .sort((x, y) => handValue(v, b, x.id) - handValue(v, b, y.id))[0] ?? leadingOpponent(v, b, obs.selfId, ctx.rng);
          if (target) {
            const ids = shuffled(ownCardIds(v, target.id), ctx.rng);
            const targetCard = ids.find(unseen) ?? ids[0];
            if (targetCard) {
              return {
                action: { type: 'POWER_APPLY', ...me, payload: { power: 'PEEK_OTHER', targetPlayerId: target.id, cardId: targetCard } },
                thought: `looking at the lowest hand I can see: ${target.name}`,
              };
            }
          }
        }
        if (p.power === 'BLIND_SWAP') {
          const give = worstCard(v, b, obs.selfId);
          const take = bestCardToTake(v, b, obs.selfId, ctx.rng);
          if (!give || !take) throw new AgentError('BLIND_SWAP without two live hands');
          return {
            action: {
              type: 'POWER_APPLY',
              ...me,
              payload: { power: 'BLIND_SWAP', ownCardId: give.id, targetPlayerId: take.player.id, targetCardId: take.id },
            },
            thought: `swapping my ${give.value.toFixed(0)} for what should be about a ${take.value.toFixed(0)} from ${take.player.name}`,
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
        const worst = worstCard(v, b, obs.selfId);
        if (worst) return { action: { type: 'TRANSFER_CARD', ...me, cardId: worst.id }, thought: 'transferring my worst card' };
        return {
          action: { type: 'TRANSFER_CARD', ...me, cardId: ctx.rng.pick(ownIds) },
          thought: 'transferring blind',
        };
      }

      case 'TURN_END': {
        const canCall = !v.cabo && enumerateLegalActions(v, obs.selfId).some((a) => a.type === 'CALL_CABO');
        if (canCall) {
          const seats = v.players.filter((x) => x.cardCount > 0 || x.id === obs.selfId).length;
          const needed = (this.callConfidence ?? CALL_CONFIDENCE[seats] ?? 0.45) + this.callShift;
          const chance = chanceCallWins(v, obs.selfId, b, ctx.rng);
          if (chance >= needed) {
            return {
              action: { type: 'CALL_CABO', ...me },
              thought: `my hand is about ${handValue(v, b, obs.selfId).toFixed(0)} and should hold up ${Math.round(chance * 100)} times in 100: Cabo!`,
            };
          }
        }
        return { action: { type: 'END_TURN', ...me }, thought: 'ending turn' };
      }

      default:
        break;
    }
    throw new AgentError(`CaboHeuristicBot: nothing to do in phase ${v.phase}`);
  }
}
