/**
 * Episode trajectory recorder — SCHEMA v2, the data plane for research.
 *
 * Design rules (RuleZero week 1):
 *  - proposed vs executed actions are DISTINCT fields; a fallback must never
 *    be recorded as if the model chose it;
 *  - every record carries full provenance: schema version, engine/rules
 *    hashes, seed, seat permutation, agent configurations;
 *  - observations are hashed so datasets can dedupe on decision CONTENT;
 *  - raw trajectories are immutable once written.
 */

import { createHash } from 'node:crypto';
import type { AgentDecision, AnyGameView, AnyGameAction, GameId } from './types.js';
import { serializeView, RULES_TEXT } from './serialize.js';

export const TRAJECTORY_SCHEMA_VERSION = 2;

/** Where an executed action came from when the proposal did not fly. */
export type FallbackReason = 'agent_error' | 'illegal_proposal';

export interface EpisodeSetup {
  gameId: GameId;
  seed: number;
  /** Seat-ordered participants (index === seat). */
  players: Array<{ id: string; name: string; agentId: string }>;
}

export interface RecordedStep {
  /** Stable id unique inside the episode. */
  decisionId: string;
  step: number;
  /** Player deciding this step. */
  selfId: string;
  agentId: string;
  decisionKind: 'agent' | 'fallback';
  /** What the agent proposed (null if it errored before proposing). */
  proposedAction: AnyGameAction | null;
  /** What actually entered the engine. */
  executedAction: AnyGameAction;
  proposalWasLegal: boolean;
  fallbackUsed: boolean;
  fallbackReason?: FallbackReason;
  rationale?: string;
  /** Serialized view AT decision time — what the agent actually saw. */
  observation?: string;
  observationHash?: string;
  /** Full raw view (large!) — only when explicitly requested. */
  rawView?: unknown;
  latencyMs?: number;
}

export interface EpisodeResult {
  scores: Record<string, number>;
  /** Higher-is-better normalized return per player (1 winner, ties split). */
  returns: Record<string, number>;
  winnerIds: string[];
  steps: number;
}

export interface EpisodeRecord extends EpisodeSetup {
  schemaVersion: number;
  episodeId: string;
  gameVersion: string;
  engineVersion: string;
  /** Hash of the canonical rules text conditioned into prompts. */
  rulesHash: string;
  /** Explicit seat order (identity by default; recorded for benchmarking). */
  seatPermutation: string[];
  agentConfigurations: Record<string, Record<string, unknown>>;
  startedAt: string;
  finishedAt: string | null;
  result: EpisodeResult | null;
  steps: RecordedStep[];
}

let EPISODE_SEQ = 0;

function sha1(v: unknown): string {
  return createHash('sha1').update(JSON.stringify(v)).digest('hex');
}

export interface StepEntry {
  decision: AgentDecision;
  proposedAction: AnyGameAction | null;
  proposalWasLegal: boolean;
  fallbackUsed: boolean;
  fallbackReason?: FallbackReason;
  latencyMs?: number;
}

export class EpisodeRecorder {
  private readonly rec: EpisodeRecord;
  private readonly recordSteps: boolean;
  private readonly recordRawViews: boolean;

  constructor(
    setup: EpisodeSetup,
    opts?: {
      recordSteps?: boolean;
      recordRawViews?: boolean;
      gameVersion?: string;
      engineVersion?: string;
      agentConfigurations?: Record<string, Record<string, unknown>>;
    },
  ) {
    EPISODE_SEQ += 1;
    const startedAt = new Date().toISOString();
    const rulesHash = sha1(RULES_TEXT[setup.gameId]);
    // Content-derived core (reproducible) + process-unique suffix.
    const core = sha1([setup.gameId, setup.seed, setup.players.map((p) => p.agentId), rulesHash]);
    const episodeId = `${setup.gameId}-s${setup.seed}-${core.slice(0, 10)}-${EPISODE_SEQ.toString(36)}`;
    this.rec = {
      ...setup,
      schemaVersion: TRAJECTORY_SCHEMA_VERSION,
      episodeId,
      gameVersion: opts?.gameVersion ?? '0.1.0',
      engineVersion: opts?.engineVersion ?? '0.1.0',
      rulesHash,
      seatPermutation: setup.players.map((p) => p.id),
      agentConfigurations: opts?.agentConfigurations ?? {},
      startedAt,
      finishedAt: null,
      result: null,
      steps: [],
    };
    this.recordSteps = opts?.recordSteps ?? true;
    this.recordRawViews = opts?.recordRawViews ?? false;
  }

  get episodeId(): string {
    return this.rec.episodeId;
  }

  step(view: AnyGameView, selfId: string, agentId: string, entry: StepEntry): void {
    if (!this.recordSteps) return;
    const n = this.rec.steps.length;
    const observation = serializeView(view, selfId);
    this.rec.steps.push({
      decisionId: `${this.rec.episodeId}-d${n}`,
      step: n,
      selfId,
      agentId,
      decisionKind: entry.fallbackUsed ? 'fallback' : 'agent',
      proposedAction: entry.proposedAction,
      executedAction: entry.decision.action,
      proposalWasLegal: entry.proposalWasLegal,
      fallbackUsed: entry.fallbackUsed,
      ...(entry.fallbackReason ? { fallbackReason: entry.fallbackReason } : {}),
      ...(entry.decision.thought !== undefined ? { rationale: entry.decision.thought } : {}),
      observation,
      observationHash: sha1(observation),
      ...(this.recordRawViews ? { rawView: view } : {}),
      ...(entry.latencyMs !== undefined ? { latencyMs: entry.latencyMs } : {}),
    });
  }

  finish(scores: Record<string, number>, higherIsBetter: boolean): EpisodeRecord {
    const ids = Object.keys(scores);
    let winnerIds: string[];
    if (higherIsBetter) {
      const best = Math.max(...ids.map((id) => scores[id] ?? 0));
      winnerIds = ids.filter((id) => scores[id] === best);
    } else {
      const best = Math.min(...ids.map((id) => scores[id] ?? Infinity));
      winnerIds = ids.filter((id) => scores[id] === best);
    }
    const returns: Record<string, number> = {};
    for (const id of ids) returns[id] = winnerIds.includes(id) ? 1 : 0;
    this.rec.result = { scores, returns, winnerIds, steps: this.rec.steps.length };
    this.rec.finishedAt = new Date().toISOString();
    return this.rec;
  }
}
