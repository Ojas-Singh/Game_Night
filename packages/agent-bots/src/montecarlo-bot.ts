/**
 * Flat Monte-Carlo search bot.
 *
 * The bot itself is pure (view -> action); SIMULATION lives behind the
 * `SearchWorld` port, which the host (arena, server AgentLoop) implements
 * over a cloned engine. This keeps agents engine-agnostic while letting the
 * search see true dynamics — including hidden information as it would be
 * dealt (determinization happens implicitly through random rollouts).
 *
 * Candidate actions are grouped into equivalence classes first (e.g. every
 * unknown Pair One slot behaves identically), which cuts the branching cost
 * dramatically without changing decision quality much.
 */

import {
  enumerateLegalActions,
  AgentError,
  type AnyGameView,
  type AgentContext,
  type AgentDecision,
  type AgentObservation,
  type GameAgent,
  type AnyGameAction,
} from '@game-night/agent-core';

/** Host-provided simulation port over the TRUE game state. */
export interface SearchWorld {
  clone(): SearchWorld;
  /** Apply an action; returns false when the engine rejects it. */
  apply(action: AnyGameAction): boolean;
  /** Player id expected to act now, or null when the round is over. */
  selfToAct(): string | null;
  viewFor(selfId: string): AnyGameView;
  /**
   * Advance the world one step with a CHEAP uniform-random legal action,
   * bypassing view construction/enumeration (state-level shortcut).
   * Returns false when the round is over or no move was possible.
   */
  advanceRandom(): boolean;
  /** Terminal payoff from one player's perspective (1 win / 0 loss; ties split). */
  outcomeFor(selfId: string): number;
}

export interface MonteCarloBotOptions {
  idSuffix?: string;
  labelPrefix?: string;
  /** Total rollouts per decision, spread across candidate classes. */
  totalSims?: number;
  /** Minimum rollouts per candidate class. */
  minSimsPerCandidate?: number;
  /** Max candidates searched (sampled beyond this). */
  maxCandidates?: number;
  /** Rollout step cap. */
  rolloutCap?: number;
}

function classKey(action: AnyGameAction, view: AnyGameView): string {
  if (action.type === 'FLIP_CARD' && view.gameId === 'pairone') {
    const rank = view.knownCards[action.cardId]?.rank;
    return `flip:${rank ?? 'u'}`;
  }
  // Cabo: dedupe PEEK targets of identical knowledge value (unknown cards).
  if (action.type === 'POWER_APPLY' && view.gameId === 'cabo') {
    const p = action.payload;
    if (p.power === 'PEEK_OWN') return `peekown:${view.knownCards[p.cardId] ? 'k' : 'u'}`;
    if (p.power === 'PEEK_OTHER') return `peekother:${view.knownCards[p.cardId] ? 'k' : 'u'}`;
    if (p.power === 'BLIND_SWAP') {
      return `blind:${view.knownCards[p.ownCardId] ? view.knownCards[p.ownCardId]!.rank : 'u'}`;
    }
  }
  if (action.type === 'KEEP_DRAWN' && view.gameId === 'cabo') return 'keep';
  return JSON.stringify(action);
}

export class MonteCarloBot implements GameAgent {
  readonly id: string;
  readonly label: string;
  private readonly worldFactory: () => SearchWorld;
  private readonly totalSims: number;
  private readonly minSims: number;
  private readonly maxCandidates: number;
  private readonly rolloutCap: number;

  constructor(worldFactory: () => SearchWorld, opts: MonteCarloBotOptions = {}) {
    this.id = `montecarlo${opts.idSuffix ?? ''}`;
    this.label = `${opts.labelPrefix ?? ''}MC(s${opts.totalSims ?? 96})`.trim();
    this.worldFactory = worldFactory;
    this.totalSims = opts.totalSims ?? 96;
    this.minSims = opts.minSimsPerCandidate ?? 6;
    this.maxCandidates = opts.maxCandidates ?? 24;
    this.rolloutCap = opts.rolloutCap ?? 400;
  }

  decide(obs: AgentObservation, ctx: AgentContext): AgentDecision {
    const candidates = enumerateLegalActions(obs.view, obs.selfId);
    if (candidates.length === 0) throw new AgentError('MC bot: no candidates');

    // Group into equivalence classes; keep one representative each.
    const classes = new Map<string, { rep: AnyGameAction; members: AnyGameAction[] }>();
    for (const a of candidates) {
      const key = classKey(a, obs.view);
      const entry = classes.get(key);
      if (entry) entry.members.push(a);
      else classes.set(key, { rep: a, members: [a] });
    }
    let reps = [...classes.values()];
    if (reps.length > this.maxCandidates) {
      reps = ctx.rng.shuffle(reps).slice(0, this.maxCandidates);
    }

    // Spread the budget: min per candidate, remainder by weight.
    const budget = Math.max(this.totalSims, reps.length * this.minSims);
    const simsFor = (i: number): number =>
      Math.floor(budget / reps.length) + (i < budget % reps.length ? 1 : 0);

    const scored: Array<{ rep: AnyGameAction; members: AnyGameAction[]; score: number }> = [];
    for (let i = 0; i < reps.length; i++) {
      const { rep, members } = reps[i]!;
      const n = Math.max(this.minSims, simsFor(i));
      let total = 0;
      for (let s = 0; s < n; s++) {
        // A random member per rollout spreads within-class choice too.
        const action = members.length > 1 ? ctx.rng.pick(members) : rep;
        total += this.rollout(action, obs.selfId);
      }
      scored.push({ rep, members, score: total / n });
    }
    // Argmax with RANDOM tie-break: symmetric classes (e.g. every unknown
    // Pair One slot) must not collapse onto the same representative forever,
    // or the bot degenerately repeats one failing line.
    let best = scored[0]!;
    for (const c of scored.slice(1)) {
      if (c.score > best.score * 1.02 || (Math.abs(c.score - best.score) <= 0.02 && ctx.rng.next() < 0.5)) {
        best = c;
      }
    }
    const finalPick =
      best.members.length > 1 && Math.abs(best.score - (scored.find((x) => x.rep === best.rep)?.score ?? 0)) <= 0.02
        ? ctx.rng.pick(best.members)
        : best.rep;
    return {
      action: finalPick,
      thought: `${this.totalSims} sims → win ${(best.score * 100).toFixed(0)}%`,
    };
  }

  /** Clone → apply → random rollout to terminal; return outcome for selfId. */
  private rollout(firstAction: AnyGameAction, selfId: string): number {
    const w = this.worldFactory().clone();
    if (!w.apply(firstAction)) return 0; // rejected: score as loss for this branch
    for (let steps = 0; steps < this.rolloutCap; steps++) {
      if (!w.advanceRandom()) break;
    }
    return w.outcomeFor(selfId);
  }
}
