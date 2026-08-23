/**
 * Episode trajectory recorder — the data plane for self-play training.
 *
 * One episode = one JSONL record: setup (game, seed, seats, agent ids),
 * per-step observations + chosen actions (+ reasoning when present), and the
 * final result. Training pipelines filter these by outcome to build SFT
 * datasets; arena runs without recording skip step capture entirely.
 */

import type { AgentDecision, AnyGameView, AnyGameAction, GameId } from './types.js';
import { serializeView } from './serialize.js';

export interface EpisodeSetup {
  gameId: GameId;
  seed: number;
  /** Seat-ordered participants. */
  players: Array<{ id: string; name: string; agentId: string }>;
}

export interface RecordedStep {
  step: number;
  /** Player deciding this step. */
  selfId: string;
  agentId: string;
  action: AnyGameAction;
  thought?: string;
  /** Serialized view AT decision time — what the agent actually saw. */
  observation?: string;
  /** Full raw view (large!) — only when explicitly requested. */
  rawView?: unknown;
}

export interface EpisodeResult {
  scores: Record<string, number>;
  /** Higher-is-better normalized score per player (1 winner, 0 losers). */
  normalized: Record<string, number>;
  winnerIds: string[];
  steps: number;
}

export interface EpisodeRecord extends EpisodeSetup {
  startedAt: string;
  result: EpisodeResult | null;
  steps: RecordedStep[];
}

export class EpisodeRecorder {
  private readonly rec: EpisodeRecord;
  private readonly recordSteps: boolean;
  private readonly recordRawViews: boolean;

  constructor(setup: EpisodeSetup, opts?: { recordSteps?: boolean; recordRawViews?: boolean }) {
    this.rec = { ...setup, startedAt: new Date().toISOString(), result: null, steps: [] };
    this.recordSteps = opts?.recordSteps ?? true;
    this.recordRawViews = opts?.recordRawViews ?? false;
  }

  step(view: AnyGameView, selfId: string, agentId: string, decision: AgentDecision): void {
    if (!this.recordSteps) return;
    this.rec.steps.push({
      step: this.rec.steps.length,
      selfId,
      agentId,
      action: decision.action,
      thought: decision.thought,
      observation: serializeView(view, selfId),
      ...(this.recordRawViews ? { rawView: view } : {}),
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
    // Normalized outcome: winners 1, others 0. Ties share credit.
    const normalized: Record<string, number> = {};
    for (const id of ids) normalized[id] = winnerIds.includes(id) ? 1 : 0;
    this.rec.result = { scores, normalized, winnerIds, steps: this.rec.steps.length };
    return this.rec;
  }
}
