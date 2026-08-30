/**
 * Heuristic Seep bot — greedy-but-polite fishing: take the richest capture,
 * sweep whenever the table allows it, steal opponent houses, build only with
 * solid backing (persona-gated), and lay the least valuable card when forced.
 *
 * View-only and deterministic given ctx.rng — the always-available fallback
 * for live rooms and the calibration floor for the arena ladder.
 */

import {
  DEFAULT_SEEP_RULES,
  captureValue,
  cardPoints,
  type SeepPlayerView,
  type SeepAction,
} from '@game-night/engine-seep';
import {
  enumerateLegalActions,
  AgentError,
  type AgentContext,
  type AgentDecision,
  type AgentObservation,
  type GameAgent,
} from '@game-night/agent-core';

export interface SeepHeuristicOptions {
  /** Strategy personality (balanced / scholar / baiter / conservative / aggressor). */
  persona?: string;
  /** Legacy id suffix (unused, kept for parity with the other bots). */
  idSuffix?: string;
}

type PlayAction = Extract<SeepAction, { type: 'PLAY_CARD' }>;

const pointsOf = (c: NonNullable<SeepPlayerView['knownCards'][string]>) =>
  cardPoints(c, DEFAULT_SEEP_RULES);
const SWEEP = DEFAULT_SEEP_RULES.sweepBonus;

export class SeepHeuristicBot implements GameAgent {
  readonly id: string;
  readonly label: string;
  private readonly persona: string;

  constructor(opts: SeepHeuristicOptions = {}) {
    this.persona = opts.persona ?? 'balanced';
    this.id = `seep-heuristic:${this.persona}`;
    this.label = `Seep Bot (${this.persona})`;
  }

  decide(obs: AgentObservation, ctx: AgentContext): AgentDecision {
    if (obs.view.gameId !== 'seep') throw new AgentError('SeepHeuristicBot given a non-seep view');
    const view = obs.view as SeepPlayerView;
    const candidates = enumerateLegalActions(view, obs.selfId).filter(
      (a): a is PlayAction => a.type === 'PLAY_CARD',
    );
    if (candidates.length === 0) throw new AgentError('no legal seep actions');

    // Respect must-capture up front: when a capture exists, laying/building
    // with a capturing card would be rejected — prefer captures outright.
    const captures = candidates.filter(
      (a) => a.intent.kind === 'CAPTURE' || a.intent.kind === 'CAPTURE_HOUSE',
    );
    const pool = captures.length > 0 ? captures : candidates;

    let best: PlayAction = pool[0]!;
    let bestScore = -Infinity;
    for (const action of pool) {
      const score = this.score(action, view, obs.selfId, ctx);
      if (score > bestScore) {
        bestScore = score;
        best = action;
      }
    }
    return { action: best, thought: describe(best, this.persona) };
  }

  /** Higher is better. Deterministic given the view (rng only gates baiting). */
  private score(
    action: PlayAction,
    view: SeepPlayerView,
    selfId: string,
    ctx: AgentContext,
  ): number {
    const intent = action.intent;
    const played = view.knownCards[action.cardId];
    const playedPoints = played ? pointsOf(played) : 0;

    switch (intent.kind) {
      case 'CAPTURE': {
        const cards = intent.tableCardIds
          .map((id) => view.knownCards[id])
          .filter((c): c is NonNullable<typeof c> => !!c);
        const points = cards.reduce((sum, c) => sum + pointsOf(c), 0);
        const clearsTable =
          view.tableLoose.length - intent.tableCardIds.length === 0 && view.houses.length === 0;
        return 100 + points * 3 + cards.length + (clearsTable ? SWEEP * 3 : 0);
      }
      case 'CAPTURE_HOUSE': {
        const house = view.houses.find((h) => h.id === intent.houseId);
        const points = house ? house.cards.reduce((sum, c) => sum + pointsOf(c), 0) : 0;
        const stealing = house ? house.ownerTeam !== view.myTeam : false;
        const clearsTable = view.tableLoose.length === 0 && view.houses.length === 1;
        const stealBonus = stealing ? (this.persona === 'aggressor' ? 120 : 60) : 0;
        return 90 + points * 3 + stealBonus + (clearsTable ? SWEEP * 3 : 0);
      }
      case 'BUILD': {
        if (!this.wantsToBuild(intent.total)) return -50;
        const backing = countValueInHand(view, selfId, action.cardId, intent.total);
        if (backing < 1) return -50; // engine would reject anyway
        return 20 + intent.total + backing * 4;
      }
      case 'RAISE_HOUSE': {
        if (this.persona === 'conservative') return -50;
        const held = played ? countValueInHand(view, selfId, action.cardId, captureValue(played)) : 0;
        return 25 + playedPoints * 2 + held * 3;
      }
      case 'LAY_DOWN': {
        // Lay the least valuable card; baiter occasionally floats mid bait.
        const bait = this.persona === 'baiter' && ctx.rng.next() < 0.35 && playedPoints >= 4;
        return (bait ? 12 : 0) - playedPoints * 2 - (played && played.suit === 'spades' ? 6 : 0);
      }
    }
  }

  private wantsToBuild(total: number): boolean {
    switch (this.persona) {
      case 'conservative':
        return false;
      case 'scholar':
      case 'baiter':
        return true;
      case 'aggressor':
        return total >= 9;
      default:
        return total >= 7;
    }
  }
}

/** Cards of `value` still in the actor's hand (the played card excluded). */
function countValueInHand(
  view: SeepPlayerView,
  selfId: string,
  exceptCardId: string,
  value: number,
): number {
  let count = 0;
  for (const id of view.handCardIds[selfId] ?? []) {
    if (id === exceptCardId) continue;
    const card = view.knownCards[id];
    if (card && card.rank === value) count += 1;
  }
  return count;
}

function describe(action: PlayAction, persona: string): string {
  switch (action.intent.kind) {
    case 'CAPTURE':
      return `Capture the set (${persona}).`;
    case 'CAPTURE_HOUSE':
      return 'Take the whole house.';
    case 'BUILD':
      return `Build a house of ${action.intent.total}.`;
    case 'RAISE_HOUSE':
      return 'Raise our house.';
    default:
      return 'Nothing worth taking — lay it down.';
  }
}
