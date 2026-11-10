/**
 * The lab's runs: one comparison of rule sets at a time, measured in this
 * process between other requests. Long runs with the trained player looking
 * ahead belong on a cluster (`python -m gamelab_train.lab`); the page opens
 * their reports too.
 */
import { randomUUID } from 'node:crypto';
import { Round, gameInfo, preset } from '@game-night/core';
import { labCompare, type LabReport, type LabRunRequest, type LabRunStatus } from '@game-night/shared';
import type { ModelPlayer } from '../agents/model.js';
import { log } from '../log.js';
import { measure } from './measure.js';

export const LAB_LIMITS = { rounds: 20_000, variants: 8 };
/** Finished runs kept for the page to fetch. */
const KEPT = 20;

interface Run extends LabRunStatus {
  cancel: boolean;
}

/** Thrown for a request the lab will not run; the message goes to the page. */
export class LabRefusal extends Error {
  constructor(message: string, readonly status = 400) {
    super(message);
  }
}

export class LabRuns {
  private runs = new Map<string, Run>();
  private model: ModelPlayer | null = null;

  setModel(model: ModelPlayer | null): void {
    this.model = model;
  }

  /** The games the trained player plays; empty when none is loaded. */
  modelGames(games: string[]): string[] {
    return this.model ? games.filter((g) => this.model!.plays(g)) : [];
  }

  get modelSamples(): number {
    return this.model?.settings.samples ?? 0;
  }

  status(id: string): LabRunStatus | null {
    const run = this.runs.get(id);
    if (!run) return null;
    const { cancel: _cancel, ...status } = run;
    return status;
  }

  cancel(id: string): boolean {
    const run = this.runs.get(id);
    if (run?.state === 'running') run.cancel = true;
    return !!run;
  }

  /** Check a request and start measuring; returns the run's id. */
  start(request: LabRunRequest): string {
    const check = this.checked(request);
    if ([...this.runs.values()].some((r) => r.state === 'running')) {
      throw new LabRefusal('the lab is busy with another run', 409);
    }
    const run: Run = { id: randomUUID(), state: 'running', done: 0, total: check.rounds * check.variants.length, cancel: false };
    this.runs.set(run.id, run);
    for (const id of [...this.runs.keys()].slice(0, -KEPT)) this.runs.delete(id);
    void this.work(run, check);
    return run.id;
  }

  private checked(request: LabRunRequest): LabRunRequest {
    const info = (() => {
      try {
        return gameInfo(String(request?.game));
      } catch {
        throw new LabRefusal('unknown game');
      }
    })();
    const players = Number(request.players);
    if (!Number.isInteger(players) || players < info.minPlayers || players > info.maxPlayers) {
      throw new LabRefusal(`${info.id} takes ${info.minPlayers} to ${info.maxPlayers} players`);
    }
    const rounds = Number(request.rounds);
    if (!Number.isInteger(rounds) || rounds < 10 || rounds > LAB_LIMITS.rounds) {
      throw new LabRefusal(`rounds must be between 10 and ${LAB_LIMITS.rounds}`);
    }
    if (!['random', 'model', 'search'].includes(request.player)) throw new LabRefusal('unknown player');
    if (request.player !== 'random' && !this.model?.plays(info.id)) {
      throw new LabRefusal(`no trained player for ${info.id} is loaded`);
    }
    if (!Array.isArray(request.variants) || request.variants.length < 1 || request.variants.length > LAB_LIMITS.variants) {
      throw new LabRefusal(`give 1 to ${LAB_LIMITS.variants} rule sets`);
    }
    const names = new Set<string>();
    const variants = request.variants.map((v) => {
      const name = String(v?.name ?? '').trim().slice(0, 60);
      if (!name || names.has(name)) throw new LabRefusal('every rule set needs its own name');
      names.add(name);
      const rules = { ...preset(info.id), ...(v.rules && typeof v.rules === 'object' ? v.rules : {}) };
      // The core checks every setting when it deals.
      try {
        new Round(info.id, JSON.stringify(rules), players, 0, 0, false, false).free();
      } catch (err) {
        throw new LabRefusal(`${name}: ${err instanceof Error ? err.message : String(err)}`);
      }
      return { name, rules };
    });
    return { game: info.id, players, rounds, player: request.player, seed: Number(request.seed) >>> 0, variants };
  }

  private async work(run: Run, request: LabRunRequest): Promise<void> {
    const started = Date.now();
    try {
      const reports: Record<string, LabReport> = {};
      for (const variant of request.variants) {
        reports[variant.name] = await measure({
          ...request,
          rules: variant.rules,
          model: this.model,
          onRound: () => { run.done += 1; },
          cancelled: () => run.cancel,
        });
      }
      run.result = labCompare(request.game, reports);
      run.state = 'done';
      log.info('lab_run_done', { game: request.game, player: request.player, rounds: run.total, ms: Date.now() - started });
    } catch (err) {
      run.state = run.cancel ? 'cancelled' : 'failed';
      if (!run.cancel) {
        run.error = err instanceof Error ? err.message : String(err);
        log.warn('lab_run_failed', { game: request.game, error: run.error.slice(0, 200) });
      }
    }
  }
}
