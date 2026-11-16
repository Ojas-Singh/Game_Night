/**
 * Seep (Sweep) heuristic bot — Punjabi rules.
 *
 * Persona-tunable greedy policy over the public player view only. Candidate
 * moves come from the ENGINE's canonical enumerator (`enumerateSeepActions`)
 * — the bot only scores them, so it can never invent an illegal play or
 * drift from the rules the human client enforces:
 *  - announces the most valuable biddable card (spades first);
 *  - values a play in deal points: what it picks up (spades, aces, 10♦,
 *    sweeps) less what the floor it leaves offers the next player — mainly
 *    the chance of a sweep, judged from the cards it can see;
 *  - cements and builds ghars (more for personas that like building) and
 *    breaks the other team's;
 *  - otherwise throws the card that is safest to leave on the floor.
 */

import type { GameAgent, AgentContext, AgentDecision, AgentObservation } from '@game-night/agent-core';
import type { SeepAction, SeepPlayerView } from '@game-night/engine-seep';
import type { Card } from '@game-night/shared';
import {
  captureValue,
  cardPoints,
  DEFAULT_SEEP_RULES,
  enumerateSeepActions,
  partitionableInto,
  type SeepRules,
} from '@game-night/engine-seep';

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

  /**
   * Score every legal play in deal points and take the best. A play is worth
   * the points it picks up now, less what it hands the next player — who is
   * always an opponent: above all the chance of a sweep off the floor it
   * leaves, judged from the cards this seat can see.
   */
  private play(
    view: SeepPlayerView,
    selfId: string,
    rules: SeepRules,
    step: number,
    ctx: AgentContext,
  ): AgentDecision {
    type Candidate = { action: SeepAction; score: number; why: string };
    const candidates: Candidate[] = [];
    const points = (cards: Card[]): number => cards.reduce((sum, c) => sum + cardPoints(c, rules), 0);
    const hand = (view.handCardIds[selfId] ?? [])
      .map((id) => view.knownCards[id])
      .filter((c): c is Card => !!c);
    const houseCards = (ids: string[]): Card[] =>
      ids.flatMap((hid) => view.houses.find((h) => h.id === hid)?.cards ?? []);

    // The next player's chance of holding a card of each value. Cards this
    // seat cannot see are in the other hands or the stock (or already taken —
    // that is not tracked, so late in a deal the danger is overstated).
    const self = view.players.find((p) => p.id === selfId);
    const next = self ? view.players.find((p) => p.seat === (self.seat + 3) % 4) : undefined;
    const nextHand = next ? (view.dealRestPending ? 12 : (view.handCounts[next.id] ?? next.cardCount)) : 0;
    const unseen = Math.max(
      1,
      view.deckCount + view.players.filter((p) => p.id !== selfId).reduce((sum, p) => sum + (view.handCounts[p.id] ?? p.cardCount), 0),
    );
    const visible = [...hand, ...view.tableLoose, ...view.houses.flatMap((h) => h.cards)];
    const holds = (value: number): number => {
      const hidden = Math.max(0, 4 - visible.filter((c) => captureValue(c) === value).length);
      return 1 - Math.pow(1 - Math.min(1, nextHand / unseen), hidden);
    };
    // A sweep by the next player counts for nothing on the deal's last play.
    const sweepAtStake = rules.lastPlaySweepZero && view.playsMade + 1 >= 47 ? 0 : rules.sweepBonus;

    /** What the next player is expected to gain from this floor. */
    const danger = (loose: Card[], houses: Array<{ total: number; cards: Card[]; ours: boolean }>): number => {
      if (loose.length === 0 && houses.length === 0) return 0;
      let safe = 1;
      let loss = 0;
      for (let value = 1; value <= 13; value += 1) {
        const chance = holds(value);
        if (chance === 0) continue;
        const clears =
          houses.every((h) => h.total === value) && (loose.length === 0 || partitionableInto(loose, value));
        if (clears) safe *= 1 - chance;
        // Points lying open to a single card of this value.
        const open = loose.filter((c) => captureValue(c) === value);
        const house = houses.find((h) => h.total === value);
        loss += chance * (points(open) + (house ? points(house.cards) : 0)) * 0.5;
      }
      return (1 - safe) * sweepAtStake + loss;
    };

    const standing = view.houses.map((h) => ({
      id: h.id,
      total: h.total,
      cards: h.cards,
      ours: view.myTeam !== null && h.ownerByTeam[view.myTeam] !== undefined,
    }));

    for (const action of enumerateSeepActions(view, selfId)) {
      if (action.type === 'ANNOUNCE') continue;
      const card = view.knownCards[action.cardId];
      if (!card) continue;
      const v = captureValue(card);
      const intent = action.intent;

      if (intent.kind === 'CAPTURE') {
        const loose = view.tableLoose.filter((c) => !intent.tableCardIds.includes(c.id));
        const houses = standing.filter((h) => !intent.houseIds.includes(h.id));
        const taken = [card, ...view.tableLoose.filter((c) => intent.tableCardIds.includes(c.id)), ...houseCards(intent.houseIds)];
        const sweep = loose.length === 0 && houses.length === 0;
        const bonus = !sweep
          ? 0
          : view.playsMade === 0
            ? rules.firstPlaySweepBonus
            : rules.lastPlaySweepZero && view.playsMade >= 47
              ? 0
              : rules.sweepBonus;
        candidates.push({
          action,
          score: 4 + points(taken) + 0.4 * taken.length + bonus - danger(loose, houses),
          why: `take ${taken.length} card${taken.length === 1 ? '' : 's'}${sweep ? ' — SEEP!' : ''}`,
        });
      } else if (intent.kind === 'ADD_TO_HOUSE') {
        const house = standing.find((h) => h.id === intent.houseId);
        if (!house) continue;
        const added = [card, ...view.tableLoose.filter((c) => intent.tableCardIds.includes(c.id))];
        const loose = view.tableLoose.filter((c) => !intent.tableCardIds.includes(c.id));
        const houses = standing.map((h) => (h.id === house.id ? { ...h, cards: [...h.cards, ...added] } : h));
        const pakkaNow = !view.houses.find((h) => h.id === house.id)?.pakka;
        candidates.push({
          action,
          score: 3 + (pakkaNow ? 3 : 1) + this.weights.buildiness * 3 + 0.3 * points(added) - danger(loose, houses),
          why: pakkaNow ? 'make the ghar pakka' : 'strengthen the ghar',
        });
      } else if (intent.kind === 'BUILD') {
        const used = [card, ...view.tableLoose.filter((c) => intent.tableCardIds.includes(c.id))];
        const loose = view.tableLoose.filter((c) => !intent.tableCardIds.includes(c.id));
        const merged = standing.some((h) => h.total === intent.total);
        const houses = merged
          ? standing.map((h) => (h.total === intent.total ? { ...h, cards: [...h.cards, ...used], ours: true } : h))
          : [...standing, { id: 'new', total: intent.total, cards: used, ours: true }];
        candidates.push({
          action,
          score: 2 + this.weights.buildiness * 4 + 0.4 * points(used) + (merged ? 2 : 0) - danger(loose, houses),
          why: `build ghar ${intent.total}`,
        });
      } else if (intent.kind === 'BREAK_HOUSE') {
        const house = standing.find((h) => h.id === intent.houseId);
        if (!house) continue;
        const total = house.total + v;
        const houses = standing.map((h) => (h.id === house.id ? { ...h, total, cards: [...h.cards, card], ours: true } : h));
        // Breaking a partner's ghar only moves it out of the team's reach.
        const theirs = !house.ours;
        candidates.push({
          action,
          score: (theirs ? 5 + 0.5 * points(house.cards) : -4) + this.weights.buildiness - danger(view.tableLoose, houses),
          why: `break ${theirs ? 'their' : 'the'} ghar ${house.total} up to ${total}`,
        });
      } else {
        const bait = this.weights.bait > 0 && ctx.rng.next() < this.weights.bait ? 1.5 : 0;
        // A second card of the value in hand can take this one back later.
        const pair = hand.filter((c) => captureValue(c) === v).length > 1 ? 1 : 0;
        candidates.push({
          action,
          score: pair + bait - 0.5 * cardPoints(card, rules) - danger([...view.tableLoose, card], standing),
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
