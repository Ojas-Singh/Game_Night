/**
 * Seep (Sweep) heuristic bot — Punjabi rules.
 *
 * Persona-tunable greedy policy over the public player view only. Candidate
 * moves come from the ENGINE's canonical enumerator (`enumerateSeepActions`)
 * — the bot only scores them, so it can never invent an illegal play or
 * drift from the rules the human client enforces:
 *  - announces the most valuable biddable card (spades first);
 *  - captures whenever possible, valuing spades/aces/10♦ and sweeps;
 *  - steals/cements/breaks ghars and builds its own for personas that like
 *    building;
 *  - otherwise lays the least valuable card (baiters gamble a little).
 */

import type { GameAgent, AgentContext, AgentDecision, AgentObservation } from '@game-night/agent-core';
import type { SeepAction, SeepPlayerView } from '@game-night/engine-seep';
import { captureValue, cardPoints, DEFAULT_SEEP_RULES, enumerateSeepActions, type SeepRules } from '@game-night/engine-seep';

export interface SeepHeuristicOptions {
  persona?: string;
  id?: string;
  label?: string;
}

interface Weights {
  buildiness: number; // 0..1 — appetite for making/adding houses
  bait: number; // 0..1 — chance to lay a mid-value card instead of the lowest
}

function personaWeights(persona?: string): Weights {
  switch (persona) {
    case 'scholar':
      return { buildiness: 1, bait: 0 };
    case 'baiter':
      return { buildiness: 0.55, bait: 0.4 };
    case 'aggressor':
      return { buildiness: 0.7, bait: 0.1 };
    case 'conservative':
      return { buildiness: 0, bait: 0 };
    default:
      return { buildiness: 0.6, bait: 0.08 };
  }
}

/** Points-ish weight of a card: spades and aces first, 10♦ next. */
function cardWeight(cardId: string, view: SeepPlayerView, rules: SeepRules): number {
  const card = view.knownCards[cardId];
  if (!card) return 0;
  return cardPoints(card, rules) * 3 + (card.suit === 'spades' ? 4 : 0);
}

export class SeepHeuristicBot implements GameAgent {
  readonly id: string;
  readonly label: string;
  private readonly persona?: string;
  private readonly weights: Weights;

  constructor(opts: SeepHeuristicOptions = {}) {
    this.persona = opts.persona;
    this.weights = personaWeights(opts.persona);
    this.id = opts.id ?? `seep-heuristic-${Math.random().toString(36).slice(2, 8)}`;
    this.label = opts.label ?? `Seep Bot${opts.persona ? ` (${opts.persona})` : ''}`;
  }

  describe(): Record<string, unknown> {
    return { kind: 'seep-heuristic', persona: this.persona ?? 'balanced', ...this.weights };
  }

  async decide(obs: AgentObservation, ctx: AgentContext): Promise<AgentDecision> {
    const view = obs.view as SeepPlayerView;
    const rules = DEFAULT_SEEP_RULES;

    if (view.phase === 'ANNOUNCE') {
      return this.announce(view, obs.selfId);
    }
    if (view.phase !== 'TURN_PLAY') {
      return { action: null as unknown as SeepAction, thought: 'the deal is over' };
    }
    return this.play(view, obs.selfId, rules, obs.step, ctx);
  }

  /** Announce the strongest biddable card: spades first, then face value. */
  private announce(view: SeepPlayerView, selfId: string): AgentDecision {
    const hand = (view.handCardIds[selfId] ?? [])
      .map((id) => view.knownCards[id])
      .filter((x): x is NonNullable<typeof x> => !!x && x.rank >= 9)
      .sort((a, b) => (b.suit === 'spades' ? 100 : 0) + b.rank - ((a.suit === 'spades' ? 100 : 0) + a.rank));
    if (hand.length === 0) return { action: null as unknown as SeepAction, thought: 'no biddable card (should have been redealt)' };
    const best = hand[0]!;
    return {
      action: { type: 'ANNOUNCE', playerId: selfId, value: best.rank } satisfies SeepAction,
      thought: `announcing ${best.rank}${best.suit === 'spades' ? '♠' : ''} — my strongest suit for the opening`,
    };
  }

  private play(
    view: SeepPlayerView,
    selfId: string,
    rules: SeepRules,
    step: number,
    ctx: AgentContext,
  ): AgentDecision {
    type Candidate = { action: SeepAction; score: number; why: string };
    const candidates: Candidate[] = [];
    const handValue = (cardId: string): number => {
      const card = view.knownCards[cardId];
      return card ? cardPoints(card, rules) * 3 + (card.suit === 'spades' ? 4 : 0) : 0;
    };

    for (const action of enumerateSeepActions(view, selfId)) {
      if (action.type === 'ANNOUNCE') continue;
      const card = view.knownCards[action.cardId];
      if (!card) continue;
      const v = captureValue(card);
      const dumpPenalty = handValue(action.cardId) * 0.5;

      const intent = action.intent;
      if (intent.kind === 'CAPTURE') {
        const taken = [
          action.cardId,
          ...intent.tableCardIds,
          ...intent.houseIds.flatMap((hid) => view.houses.find((h) => h.id === hid)?.cards.map((c) => c.id) ?? []),
        ];
        const gain = taken.reduce((sum, id) => sum + handValue(id), 0);
        const steal = intent.houseIds.some((hid) => {
          const h = view.houses.find((x) => x.id === hid);
          return h !== undefined && view.myTeam !== null && h.ownerByTeam[view.myTeam === 0 ? 1 : 0] !== undefined;
        });
        const sweep = view.tableLoose.length === intent.tableCardIds.length + 0 &&
          view.tableLoose.every((c) => intent.tableCardIds.includes(c.id)) &&
          view.houses.every((h) => intent.houseIds.includes(h.id));
        candidates.push({
          action,
          score: 100 + gain * 2 + (steal ? 40 : 0) + (sweep ? (view.playsMade === 0 ? 25 : view.playsMade >= 47 ? 0 : 50) : 0),
          why: `take ${taken.length} card${taken.length === 1 ? '' : 's'}${sweep ? ' — SEEP!' : ''}`,
        });
      } else if (intent.kind === 'ADD_TO_HOUSE') {
        const house = view.houses.find((h) => h.id === intent.houseId);
        const pakkaNow = house !== undefined && !house.pakka;
        candidates.push({
          action,
          score: 55 + (pakkaNow ? 30 : 10) + this.weights.buildiness * 20,
          why: pakkaNow ? 'make our ghar pakka' : 'strengthen the ghar',
        });
      } else if (intent.kind === 'BUILD') {
        candidates.push({
          action,
          score: 45 + this.weights.buildiness * 45 + intent.total * 0.5 - dumpPenalty * 0.2,
          why: `build ghar ${intent.total}`,
        });
      } else if (intent.kind === 'BREAK_HOUSE') {
        const house = view.houses.find((h) => h.id === intent.houseId);
        const newTotal = (house?.total ?? 0) + v;
        candidates.push({
          action,
          score: 70 + (13 - newTotal) + this.weights.buildiness * 10,
          why: `break their ghar ${house?.total} up to ${newTotal}`,
        });
      } else {
        const bait =
          this.weights.bait > 0 && ctx.rng.next() < this.weights.bait
            ? 8
            : 0;
        candidates.push({
          action,
          score: 10 - handValue(action.cardId) * 0.5 + bait,
          why: 'throw a card',
        });
      }
    }

    if (candidates.length === 0) {
      return { action: null as unknown as SeepAction, thought: 'no legal candidates' };
    }
    void step;
    candidates.sort((a, b) => b.score - a.score);
    const best = candidates[0]!;
    return { action: best.action, thought: best.why };
  }
}

