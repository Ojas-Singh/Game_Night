/**
 * What a set of rules does to a game: many rounds played on the rules core,
 * and what happened in them. The report has the shape `gamelab_train.lab`
 * writes (`measure` there), so the lab page shows both alike.
 *
 * A report says how the *given player* plays the rules. With random moves it
 * shows little more than the mechanics.
 */
import { Round, gameInfo, layout } from '@game-night/core';
import type { LabMean, LabPlayerKind, LabReport } from '@game-night/shared';
import type { ModelPlayer } from '../agents/model.js';

/** Decisions after which a round is given up. */
const STEP_LIMIT = 2000;
/** Rounds in play at once when the model chooses (its calls overlap). */
const TOGETHER = 4;
/** Longest stretch of work, in ms, before other requests get a turn. */
const SLICE_MS = 8;

export interface MeasureOptions {
  game: string;
  rules: Record<string, unknown>;
  players: number;
  rounds: number;
  player: LabPlayerKind;
  seed: number;
  model?: ModelPlayer | null;
  /** Called after every round. */
  onRound?: () => void;
  cancelled?: () => boolean;
}

/** A small seeded generator (mulberry32) of numbers in [0, 1). */
function generator(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Mean and standard error of the values that apply, and the share that do. */
function mean(values: ArrayLike<number>): LabMean & { applies: number } {
  let n = 0;
  let sum = 0;
  for (let i = 0; i < values.length; i += 1) {
    if (!Number.isNaN(values[i]!)) {
      n += 1;
      sum += values[i]!;
    }
  }
  if (n === 0) return { mean: null, stderr: null, applies: 0 };
  const m = sum / n;
  let squares = 0;
  for (let i = 0; i < values.length; i += 1) if (!Number.isNaN(values[i]!)) squares += (values[i]! - m) ** 2;
  return { mean: m, stderr: n > 1 ? Math.sqrt(squares / (n - 1) / n) : null, applies: n / values.length };
}

function percentile(sorted: number[], q: number): number {
  const at = ((sorted.length - 1) * q) / 100;
  const low = Math.floor(at);
  const high = Math.min(sorted.length - 1, low + 1);
  return sorted[low]! + (sorted[high]! - sorted[low]!) * (at - low);
}

interface Played {
  returns: Float32Array;
  stats: Float32Array;
  steps: number;
  taken: Uint32Array;
  offered: Uint32Array;
}

export async function measure(options: MeasureOptions): Promise<LabReport> {
  const { game, rules, players, rounds, player, seed } = options;
  const info = gameInfo(game);
  const model = player === 'random' ? null : options.model;
  if (player !== 'random' && !model?.plays(game)) throw new Error(`no trained player for ${game} is loaded`);
  const settings = model ? { ...model.settings, samples: player === 'search' ? model.settings.samples : 0 } : null;
  const [fields, actionFields, , block] = layout() as unknown as [number, number, number, number];
  const rulesJson = JSON.stringify(rules);

  let sliceStart = Date.now();
  const breathe = async (): Promise<void> => {
    if (Date.now() - sliceStart < SLICE_MS) return;
    await new Promise<void>((resolve) => setImmediate(resolve));
    sliceStart = Date.now();
  };

  /** One round; nothing when it ran into the step limit. */
  const play = async (index: number): Promise<Played | null> => {
    // The same deals under every rule set: differences are the rules', not the cards'.
    const round = new Round(game, rulesJson, players, seed >>> 0, index, false, false);
    const random = generator(Math.imul(seed ^ 0x9e3779b9, 2654435761) + index);
    const taken = new Uint32Array(block);
    const offered = new Uint32Array(block);
    try {
      let steps = 0;
      while (round.toAct >= 0) {
        if (steps >= STEP_LIMIT || options.cancelled?.()) return null;
        const seen = round.observe(round.toAct, false);
        const rows = seen.subarray(1 + seen[0]! * fields);
        const count = rows.length / actionFields;
        const choice = model
          ? (await model.choose(round, Math.floor(random() * 2 ** 32), random, settings!)).index
          : Math.floor(random() * count);
        const here = new Set<number>();
        for (let i = 0; i < count; i += 1) here.add(rows[i * actionFields]! % block);
        for (const verb of here) offered[verb]! += 1;
        taken[rows[choice * actionFields]! % block]! += 1;
        round.step(choice);
        steps += 1;
        await breathe();
      }
      return { returns: round.returns(), stats: round.stats(), steps, taken, offered };
    } finally {
      round.free();
    }
  };

  const played: Played[] = [];
  let cut = 0;
  let next = 0;
  const table = async (): Promise<void> => {
    while (next < rounds && !options.cancelled?.()) {
      const result = await play(next++);
      if (options.cancelled?.()) return;
      if (result) played.push(result);
      else cut += 1;
      options.onRound?.();
    }
  };
  await Promise.all(Array.from({ length: model ? TOGETHER : 1 }, table));
  if (options.cancelled?.()) throw new Error('cancelled');

  const n = played.length;
  if (n < 2) throw new Error('too few rounds finished to report on (they ran into the step limit)');
  const column = (f: (p: Played) => number): Float64Array => Float64Array.from(played, f);
  const best = played.map((p) => Math.max(...p.returns.subarray(0, players)));
  const top = (p: Played, i: number, s: number): boolean => best[i]! > 1e-9 && Math.abs(p.returns[s]! - best[i]!) < 1e-6;
  const tops = played.map((p, i) => Array.from({ length: players }, (_, s) => top(p, i, s)));
  const alone = (i: number, s: number): boolean => tops[i]![s]! && tops[i]!.filter(Boolean).length === 1;
  const entry = (values: ArrayLike<number>): LabMean => {
    const { mean: m, stderr } = mean(values);
    return { mean: m, stderr };
  };

  const seats = Array.from({ length: players }, (_, s) => ({
    ...entry(column((p) => p.returns[s]!)),
    won: entry(played.map((_, i) => Number(alone(i, s)))),
    shared: entry(played.map((_, i) => Number(tops[i]![s]! && !alone(i, s)))),
  }));
  const means = seats.map((s) => s.mean ?? 0);
  const hi = means.indexOf(Math.max(...means));
  const lo = means.indexOf(Math.min(...means));
  const spread = entry(column((p) => p.returns[hi]! - p.returns[lo]!));
  const steps = played.map((p) => p.steps).sort((a, b) => a - b);
  const used = new Float64Array(block);
  const seen = new Float64Array(block);
  for (const p of played) {
    for (let v = 0; v < block; v += 1) {
      used[v]! += p.taken[v]!;
      seen[v]! += p.offered[v]!;
    }
  }
  return {
    game,
    rules,
    players,
    rounds: n,
    abandoned: cut / (n + cut),
    seats,
    spread: { mean: spread.mean ?? 0, stderr: spread.stderr, best: hi, worst: lo },
    draws: entry(tops.map((t) => Number(!t.some(Boolean)))),
    length: { ...entry(steps), p10: percentile(steps, 10), p50: percentile(steps, 50), p90: percentile(steps, 90) },
    actions: info.verbs.map(([verb, name]) => ({
      verb,
      name,
      perRound: used[verb]! / n,
      taken: seen[verb]! ? used[verb]! / seen[verb]! : null,
    })),
    stats: info.stats.map((stat, i) => ({ ...stat, ...mean(column((p) => p.stats[i]!)) })),
    playedBy: player,
  };
}
