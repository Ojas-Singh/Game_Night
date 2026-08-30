/**
 * Seep (Sweep) heuristic bot — Punjabi rules.
 *
 * Persona-tunable greedy policy over the public player view only:
 *  - announces the most valuable biddable card (spades first);
 *  - on the opening play, relates everything to the announced number;
 *  - captures whenever allowed (must-capture), valuing spades/aces/10♦;
 *  - steals opponent kachcha ghars when the new total is held;
 *  - pakka-fies own ghars for personas that like building;
 *  - otherwise lays the least valuable card (baiters gamble a little).
 */

import type { GameAgent, AgentContext, AgentDecision, AgentObservation } from '@game-night/agent-core';
import type { SeepAction, SeepPlayerView } from '@game-night/engine-seep';
import { captureValue, cardPoints, DEFAULT_SEEP_RULES, type SeepRules } from '@game-night/engine-seep';

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
    const handIds = (view.handCardIds[selfId] ?? []).filter((id) => view.knownCards[id]);
    if (handIds.length === 0) return { action: null as unknown as SeepAction, thought: 'no cards' };
    const opening = view.playsMade === 0;
    const bid = view.bid;
    type Candidate = { action: SeepAction; score: number; why: string };
    const candidates: Candidate[] = [];

    for (const cardId of handIds) {
      const card = view.knownCards[cardId]!;
      const v = captureValue(card);
      // On the opening play every move must involve the announced number.
      if (opening && bid !== null && v !== bid) continue;
      const myTurn = view.players.find((p) => p.isCurrentTurn)?.id === selfId;
      if (!myTurn) break;

      // 1) Captures of loose sets (greedy: any valid grouping).
      const looseSets = this.looseSetsFor(view, v);
      for (const set of looseSets.slice(0, 6)) {
        const gain = set.reduce((sum, id) => sum + cardWeight(id, view, rules), 0) + cardWeight(cardId, view, rules);
        const sweep = this.wouldSweep(view, set, []);
        candidates.push({
          action: { type: 'PLAY_CARD', playerId: selfId, cardId, intent: { kind: 'CAPTURE', tableCardIds: set, houseIds: [] } },
          score: 100 + gain * 2 + (sweep ? (opening ? 25 : 50) : 0),
          why: `capture ${set.length + 1} card${set.length ? 's' : ''}${sweep ? ' — SEEP!' : ''}`,
        });
      }

      // 2) House interactions.
      for (const house of view.houses) {
        if (house.total === v) {
          const steal = house.ownerTeam !== view.myTeam;
          const sweep = this.wouldSweep(view, [], [house.id]);
          candidates.push({
            action: { type: 'PLAY_CARD', playerId: selfId, cardId, intent: { kind: 'CAPTURE', tableCardIds: [], houseIds: [house.id] } },
            score: 110 + house.cards.length * 6 + (steal ? 40 : 0) + (sweep ? 60 : 0),
            why: `${steal ? 'steal' : 'take'} the ghar of ${house.total}`,
          });
        }
        if (house.ownerTeam === view.myTeam) {
          // Add a complete set (card alone or with loose cards).
          const need = house.total - v;
          if (need === 0 && this.countInHand(view, selfId, v, cardId) >= 1) {
            const pakkaNow = house.sets === 1;
            candidates.push({
              action: { type: 'PLAY_CARD', playerId: selfId, cardId, intent: { kind: 'ADD_TO_HOUSE', houseId: house.id, tableCardIds: [] } },
              score: 55 + (pakkaNow ? 30 : 10),
              why: pakkaNow ? 'make our ghar pakka' : 'strengthen our ghar',
            });
          } else if (need > 0) {
            for (const set of this.looseSetsFor(view, need)) {
              candidates.push({
                action: { type: 'PLAY_CARD', playerId: selfId, cardId, intent: { kind: 'ADD_TO_HOUSE', houseId: house.id, tableCardIds: set } },
                score: 50 + this.weights.buildiness * 30,
                why: `add ${set.length + 1} cards to our ghar ${house.total}`,
              });
            }
          }
        } else if (!house.pakka && house.total + v <= 13 && this.countInHand(view, selfId, house.total + v, cardId) >= 1) {
          candidates.push({
            action: { type: 'PLAY_CARD', playerId: selfId, cardId, intent: { kind: 'BREAK_HOUSE', houseId: house.id } },
            score: 90 + (13 - house.total - v) * -1 + 20,
            why: `break their ghar ${house.total} up to ${house.total + v}`,
          });
        }
      }

      // 3) Builds (9–13, backed by another held card).
      const restValues = handIds.filter((id) => id !== cardId).map((id) => captureValue(view.knownCards[id]!));
      for (const set of this.looseSetsBetween(view, Math.max(9 - v, 1), 13 - v)) {
        const total = set.sum + v;
        if (opening && bid !== null && total !== bid) continue;
        if (!restValues.includes(total)) continue;
        candidates.push({
          action: { type: 'PLAY_CARD', playerId: selfId, cardId, intent: { kind: 'BUILD', tableCardIds: set.ids, total } },
          score: 45 + this.weights.buildiness * 45 + total * 0.5,
          why: `build ghar ${total}`,
        });
      }

      // 4) Lay down.
      const layScore = 10 - cardWeight(cardId, view, rules) * 0.5 + (this.weights.bait > 0 && ctx.rng.next() < this.weights.bait ? 8 : 0);
      candidates.push({
        action: { type: 'PLAY_CARD', playerId: selfId, cardId, intent: { kind: 'LAY_DOWN' } },
        score: layScore,
        why: 'throw a card',
      });
    }

    if (candidates.length === 0) {
      // Opening play fallback: throw the announced card itself.
      if (opening && bid !== null) {
        const bidCard = handIds.find((id) => captureValue(view.knownCards[id]!) === bid);
        if (bidCard) {
          return {
            action: { type: 'PLAY_CARD', playerId: selfId, cardId: bidCard, intent: { kind: 'LAY_DOWN' } } satisfies SeepAction,
            thought: `nothing to do with the ${bid} — laying it`,
          };
        }
      }
      return { action: null as unknown as SeepAction, thought: 'no legal candidates' };
    }

    candidates.sort((a, b) => b.score - a.score);
    const best = candidates[0]!;
    return { action: best.action, thought: best.why };
  }

  /** Loose-card sets summing exactly to `v` (bounded enumeration). */
  private looseSetsFor(view: SeepPlayerView, v: number): string[][] {
    const ids = view.tableLoose.map((c) => c.id);
    const values = new Map(ids.map((id) => [id, captureValue(view.knownCards[id] ?? view.tableLoose.find((x) => x.id === id)!)]));
    const out: string[][] = [];
    const walk = (start: number, cur: string[], sum: number): void => {
      if (sum === v && cur.length > 0) {
        out.push([...cur]);
        return;
      }
      if (start >= ids.length || cur.length >= 5 || out.length >= 12 || sum >= v) return;
      for (let j = start; j < ids.length; j++) {
        walk(j + 1, [...cur, ids[j]!], sum + (values.get(ids[j]!) ?? 0));
      }
    };
    walk(0, [], 0);
    return out;
  }

  /** Loose-card sets whose sum lies in [min, max] (bounded enumeration). */
  private looseSetsBetween(view: SeepPlayerView, min: number, max: number): Array<{ ids: string[]; sum: number }> {
    const ids = view.tableLoose.map((c) => c.id);
    const values = new Map(ids.map((id) => [id, captureValue(view.knownCards[id] ?? view.tableLoose.find((x) => x.id === id)!)]));
    const out: Array<{ ids: string[]; sum: number }> = [];
    const walk = (start: number, cur: string[], sum: number): void => {
      if (cur.length > 0 && sum >= min && sum <= max) {
        out.push({ ids: [...cur], sum });
        return; // supersets only grow the sum — stop here
      }
      if (start >= ids.length || cur.length >= 5 || out.length >= 12 || sum > max) return;
      for (let j = start; j < ids.length; j++) {
        walk(j + 1, [...cur, ids[j]!], sum + (values.get(ids[j]!) ?? 0));
      }
    };
    walk(0, [], 0);
    return out;
  }

  private countInHand(view: SeepPlayerView, selfId: string, value: number, exceptCardId: string): number {
    return (view.handCardIds[selfId] ?? []).filter(
      (id) => id !== exceptCardId && view.knownCards[id] && captureValue(view.knownCards[id]!) === value,
    ).length;
  }

  private wouldSweep(view: SeepPlayerView, extraLoose: string[], houseIds: string[]): boolean {
    const remainingLoose = view.tableLoose.filter((c) => !extraLoose.includes(c.id));
    const remainingHouses = view.houses.filter((h) => !houseIds.includes(h.id));
    return remainingLoose.length === 0 && remainingHouses.length === 0;
  }
}
