/**
 * Heuristic Cabo bot — plays sensible golf: keep low cards, ditch high ones,
 * flush known matches, use powers to reveal, call Cabo on a good estimate.
 *
 * Deliberately simple and readable: it's the skill floor LLM agents must
 * clear, and the bulk-data generator for early self-play generations.
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

export interface CaboHeuristicOptions {
  /** Estimated hand sum below which the bot calls Cabo (TURN_END). */
  caboThreshold?: number;
  /** Probability of flushing an opponent's KNOWN matching card. */
  flushOtherAggression?: number;
}

export class CaboHeuristicBot implements GameAgent {
  readonly id: string;
  readonly label: string;
  private readonly caboThreshold: number;
  private readonly flushOtherAggression: number;

  constructor(opts: CaboHeuristicOptions & { idSuffix?: string } = {}) {
    this.id = `cabo-heuristic${opts.idSuffix ?? ''}`;
    this.label = 'Cabo Heuristic';
    this.caboThreshold = opts.caboThreshold ?? 12;
    this.flushOtherAggression = opts.flushOtherAggression ?? 0.9;
  }

  decide(obs: AgentObservation, ctx: AgentContext): AgentDecision {
    const v = obs.view;
    if (v.gameId !== 'cabo') throw new AgentError('CaboHeuristicBot got a non-cabo view');
    const me = { playerId: obs.selfId };
    const ownIds = (v.handCardIds[obs.selfId] ?? []).filter((id) => !id.startsWith('__slot__'));
    const knownOwn = () => ownIds.filter((id) => v.knownCards[id]).map((id) => ({ id, c: v.knownCards[id]! }));

    // --- Free interrupts: flushes -----------------------------------------
    if (v.discardTopRank != null && !v.pendingTransfer && v.phase !== 'INITIAL_PEEK') {
      const matches = knownOwn().filter((k) => k.c.rank === v.discardTopRank);
      if (matches.length >= 2) {
        return {
          action: { type: 'FLUSH_OWN', ...me, cardIds: [matches[0]!.id, matches[1]!.id] },
          thought: `flushing my pair of ${matches[0]!.c.rank}s`,
        };
      }
      if (matches.length === 1 && matches[0]!.c.rank >= 5) {
        return { action: { type: 'FLUSH_OWN', ...me, cardIds: [matches[0]!.id] }, thought: 'flushing my match' };
      }
      if (ctx.rng.next() < this.flushOtherAggression) {
        for (const p of v.players) {
          if (p.id === obs.selfId) continue;
          const hit = (v.handCardIds[p.id] ?? []).find(
            (id) => !id.startsWith('__slot__') && v.knownCards[id]?.rank === v.discardTopRank,
          );
          if (hit) {
            return {
              action: { type: 'FLUSH_OTHER', ...me, targetPlayerId: p.id, cardId: hit },
              thought: `I remember ${p.name} has a ${v.discardTopRank}`,
            };
          }
        }
      }
    }

    switch (v.phase) {
      case 'INITIAL_PEEK':
        return {
          action: { type: 'PEEK_STARTING', ...me, cardIndexes: [0, 1] },
          thought: 'peeking my first two cards',
        };

      case 'TURN_DRAW':
        return { action: { type: 'DRAW', ...me }, thought: 'drawing' };

      case 'DRAW_DECISION': {
        const drawn = v.drawnCard;
        if (!drawn) throw new AgentError('DRAW_DECISION without drawn card');
        const dv = cardValue(drawn);
        const known = knownOwn();
        if (known.length > 0) {
          const worst = known.reduce((a, b) => (cardValue(b.c) > cardValue(a.c) ? b : a));
          if (dv < cardValue(worst.c)) {
            const idx = (v.handCardIds[obs.selfId] ?? []).indexOf(worst.id);
            return {
              action: { type: 'KEEP_DRAWN', ...me, handIndex: idx },
              thought: `${dv} beats my ${cardValue(worst.c)} — swapping in`,
            };
          }
        } else if (dv <= 5) {
          return { action: { type: 'KEEP_DRAWN', ...me, handIndex: 0 }, thought: 'no info; keeping a low card' };
        }
        return { action: { type: 'DISCARD_DRAWN', ...me }, thought: `discarding ${dv}` };
      }

      case 'POWER_PENDING': {
        const p = v.pendingPower!;
        if (p.power === 'PEEK_OWN') {
          const unknown = ownIds.find((id) => !v.knownCards[id]);
          return {
            action: { type: 'POWER_APPLY', ...me, payload: { power: 'PEEK_OWN', cardId: unknown ?? ownIds[0]! } },
            thought: 'peeking an unknown card of mine',
          };
        }
        if (p.power === 'PEEK_OTHER') {
          for (const o of v.players) {
            if (o.id === obs.selfId || o.cardCount === 0) continue;
            const unknown = (v.handCardIds[o.id] ?? []).find(
              (id) => !id.startsWith('__slot__') && !v.knownCards[id],
            );
            if (unknown) {
              return {
                action: { type: 'POWER_APPLY', ...me, payload: { power: 'PEEK_OTHER', targetPlayerId: o.id, cardId: unknown } },
                thought: `spying on ${o.name}`,
              };
            }
          }
        }
        if (p.power === 'BLIND_SWAP') {
          const known = knownOwn();
          let giveId = ownIds[0]!;
          let giveVal = -99;
          for (const k of known) {
            if (cardValue(k.c) > giveVal) {
              giveVal = cardValue(k.c);
              giveId = k.id;
            }
          }
          if (giveVal < 7) {
            // Not worth losing information — peek-equivalent choice: swap our
            // single most-likely-bad unknown (slot order heuristic).
            giveId = ownIds.find((id) => !v.knownCards[id]) ?? giveId;
          }
          const targets = v.players.filter((o) => o.id !== obs.selfId && o.cardCount > 0);
          const t = ctx.rng.pick(targets.length > 0 ? targets : v.players.filter((o) => o.id !== obs.selfId));
          const theirs = (v.handCardIds[t.id] ?? []).filter((id) => !id.startsWith('__slot__'));
          return {
            action: {
              type: 'POWER_APPLY',
              ...me,
              payload: { power: 'BLIND_SWAP', ownCardId: giveId, targetPlayerId: t.id, targetCardId: ctx.rng.pick(theirs) },
            },
            thought: `blind-swapping my ${giveVal >= 0 ? giveVal : 'K'} into ${t.name}'s hand`,
          };
        }
        // SWAP_OTHERS: shuffle the two juiciest known opponent cards apart.
        const knownOpp: Array<{ id: string; owner: string; val: number }> = [];
        for (const o of v.players) {
          if (o.id === obs.selfId) continue;
          for (const id of v.handCardIds[o.id] ?? []) {
            if (!id.startsWith('__slot__') && v.knownCards[id]) {
              knownOpp.push({ id, owner: o.id, val: cardValue(v.knownCards[id]!) });
            }
          }
        }
        knownOpp.sort((a, b) => b.val - a.val);
        const top = knownOpp.filter((k) => k.val >= 8);
        if (top.length >= 2 && top[0]!.owner !== top[1]!.owner) {
          return {
            action: {
              type: 'POWER_APPLY',
              ...me,
              payload: { power: 'SWAP_OTHERS', cardIdA: top[0]!.id, cardIdB: top[1]!.id },
            },
            thought: 'swapping their high cards around',
          };
        }
        const poolA = v.players.filter((o) => o.id !== obs.selfId && (v.handCardIds[o.id] ?? []).some((i) => !i.startsWith('__slot__')));
        const a = ctx.rng.pick(poolA);
        const b = ctx.rng.pick(v.players.filter((o) => o.id !== obs.selfId && o.id !== a.id));
        const idA = (v.handCardIds[a.id] ?? []).find((i) => !i.startsWith('__slot__'))!;
        const idB = (v.handCardIds[b.id] ?? []).find((i) => !i.startsWith('__slot__'))!;
        return {
          action: { type: 'POWER_APPLY', ...me, payload: { power: 'SWAP_OTHERS', cardIdA: idA, cardIdB: idB } },
          thought: 'randomizing opponents',
        };
      }

      case 'TRANSFER_PENDING': {
        // Give away my worst known card, else an unknown one.
        const known = knownOwn();
        if (known.length > 0) {
          const worst = known.reduce((x, y) => (cardValue(y.c) > cardValue(x.c) ? y : x));
          return { action: { type: 'TRANSFER_CARD', ...me, cardId: worst.id }, thought: 'transferring my worst' };
        }
        return {
          action: { type: 'TRANSFER_CARD', ...me, cardId: ctx.rng.pick(ownIds) },
          thought: 'transferring blind',
        };
      }

      case 'TURN_END': {
        const known = knownOwn();
        const unknownCount = ownIds.length - known.length;
        const est = known.reduce((sum, k) => sum + cardValue(k.c), 0) + unknownCount * UNKNOWN_EXPECTATION;
        const canCall = !v.cabo && enumerateLegalActions(v, obs.selfId).some((a) => a.type === 'CALL_CABO');
        if (canCall && est <= this.caboThreshold) {
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
