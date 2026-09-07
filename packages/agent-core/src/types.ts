/**
 * Agent-core types — the contract every card-playing agent implements.
 *
 * An agent is a pure decision function: it sees a per-viewer filtered view
 * (identical to what a human client receives) plus its own id, and returns
 * one concrete game action. Agents never touch engine internals; hidden
 * information stays hidden by construction.
 */

import type { Card } from '@game-night/shared';
import type { CaboPlayerView, CaboAction } from '@game-night/engine-cabo';
import type { PairOnePlayerView, PairOneAction } from '@game-night/engine-pairone';
import type { SeepPlayerView, SeepAction } from '@game-night/engine-seep';

/** Any per-player filtered view this platform currently ships. */
export type AnyGameView = CaboPlayerView | PairOnePlayerView | SeepPlayerView;

export type GameId = 'cabo' | 'pairone' | 'seep';

/** Concrete actions across games (the currency agents think in). */
export type AnyGameAction = CaboAction | PairOneAction | SeepAction;
/** A card as agents see it once revealed. */
export type KnownCard = Card;

/** Everything an agent may look at when deciding. */
export interface AgentObservation {
  gameId: GameId;
  /** The player the agent is deciding for. */
  selfId: string;
  /** Per-viewer filtered view (no hidden information). */
  view: AnyGameView;
  /**
   * Monotonic decision index within the episode — useful for logging and for
   * stateful agents that want to key memory.
   */
  step: number;
}

/** What an agent returns: the action, plus optional human-readable reasoning. */
export type AgentFailureKind =
  | 'none'
  | 'empty_response'
  | 'malformed_response'
  | 'illegal_action'
  | 'timeout'
  | 'http_error'
  | 'provider_error'
  | 'candidate_budget'
  | 'unknown';

export interface AgentAttempt {
  attempt: number;
  status: 'accepted' | 'failed';
  latencyMs: number;
  httpStatus?: number;
  finishReason?: string;
  promptTokens?: number;
  completionTokens?: number;
  failure?: AgentFailureKind;
}

export interface AgentDecisionMeta {
  source: 'model' | 'fallback' | 'heuristic' | 'solver';
  provider?: string;
  model?: string;
  attempts?: AgentAttempt[];
  failure?: AgentFailureKind;
  latencyMs?: number;
  promptTokens?: number;
 completionTokens?: number;
  /** Whether the provider returned a separate reasoning field; its text is never surfaced. */
  providerReasoningAvailable?: boolean;
 candidateCount?: number;
}

export interface AgentDecision {
  action: AnyGameAction;
  /** Short model-provided rationale, never hidden chain-of-thought. */
  thought?: string;
  /** Optional visible decision breakdown grounded in the filtered observation. */
  rationale?: string[];
  /** Auditable execution metadata. Never contains provider credentials or hidden state. */
  meta?: AgentDecisionMeta;
}

/**
 * A card-playing agent. Implementations MUST be deterministic given
 * `ctx.rng` if they want reproducible episodes; the arena seeds it.
 */
export interface GameAgent {
  readonly id: string;
  /** Human-facing label for ladders/UI. */
  readonly label: string;
  decide(obs: AgentObservation, ctx: AgentContext): Promise<AgentDecision> | AgentDecision;
  /**
   * Configuration provenance for trajectory records (model id, persona,
   * temperature, search budget...). Optional; recorded verbatim.
   */
  describe?(): Record<string, unknown>;
}

/** Deterministic RNG handle handed to agents (mulberry32-style). */
export interface Rng {
  next(): number;
  int(maxExclusive: number): number;
  pick<T>(items: readonly T[]): T;
  shuffle<T>(items: T[]): T[];
}

export interface AgentContext {
  rng: Rng;
}

/** Simple error type so hosts can distinguish agent failures. */
export class AgentError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'AgentError';
  }
}
