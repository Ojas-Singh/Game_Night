/**
 * The trained player — one network for every game — for AI seats.
 *
 * A directory written by `python -m gamelab_train.export` holds `player.onnx`
 * (what a seat sees -> a score for each legal move), `judge.onnx` (the open
 * position -> its value to each seat) and `model.json`. A move is chosen as
 * training-time search does (`gamelab_train/search.py`): every legal move is
 * tried in several deals of the cards the seat cannot see, the judge values
 * where each leads, and the player's own choice is shifted towards the moves
 * that came out ahead:
 *
 *     probability  ~  player's probability * exp(value / temperature)
 */
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { InferenceSession, Tensor } from 'onnxruntime-node';
import { Lookahead, layout, type Round } from '@game-night/core';

export interface ModelSettings {
  /** Deals of the hidden cards tried for each move; 0 plays the bare network. */
  samples: number;
  temperature: number;
  /** Take the most probable move instead of drawing one. Bluffing games punish it. */
  greedy: boolean;
}

export const DEFAULT_MODEL_SETTINGS: ModelSettings = { samples: 16, temperature: 0.25, greedy: false };

export interface ModelChoice {
  /** Index into `round.legal()`. */
  index: number;
  /** Probability of each legal move after looking ahead. */
  policy: number[];
  /** Probability of each legal move from the bare network. */
  prior: number[];
  /** Value of each legal move found by looking ahead (empty when it did not). */
  values: number[];
}

/** Positions judged in one call of the network. */
const CHUNK = 256;

type Ort = typeof import('onnxruntime-node');

export class ModelPlayer {
  private constructor(
    private ort: Ort,
    private player: InferenceSession,
    private judge: InferenceSession,
    private scale: Record<string, number>,
    readonly settings: ModelSettings,
  ) {}

  static async load(dir: string, settings: Partial<ModelSettings> = {}): Promise<ModelPlayer> {
    const info = JSON.parse(await readFile(join(dir, 'model.json'), 'utf8')) as {
      fields: number;
      actionFields: number;
      maxSeats: number;
      scale: Record<string, number>;
    };
    const [fields, actionFields, maxSeats] = layout();
    if (info.fields !== fields || info.actionFields !== actionFields || info.maxSeats !== maxSeats) {
      throw new Error(`the model in ${dir} was trained on a different version of the rules core`);
    }
    // This build of ONNX Runtime reports usage to Microsoft unless told not to;
    // the variable is read when the library is first loaded.
    process.env.ORT_DISABLE_TELEMETRY ??= '1';
    const ort = await import('onnxruntime-node');
    const options = { intraOpNumThreads: 2, interOpNumThreads: 1 };
    const player = await ort.InferenceSession.create(join(dir, 'player.onnx'), options);
    const judge = await ort.InferenceSession.create(join(dir, 'judge.onnx'), options);
    return new ModelPlayer(ort, player, judge, info.scale, { ...DEFAULT_MODEL_SETTINGS, ...settings });
  }

  /** Whether the model was trained on this game. */
  plays(gameId: string): boolean {
    return this.scale[gameId] !== undefined;
  }

  private ints(data: ArrayLike<number>, dims: number[]): Tensor {
    return new this.ort.Tensor('int32', Int32Array.from(data), dims);
  }

  /** Log-probability the bare network gives each legal move of the seat to move. */
  private async prior(round: Round): Promise<Float32Array> {
    const [fields, actionFields] = layout() as unknown as [number, number];
    const seen = round.observe(round.toAct, false);
    const tokens = seen[0]!;
    const body = seen.subarray(1, 1 + tokens * fields);
    const rows = seen.subarray(1 + tokens * fields);
    const actions = rows.length / actionFields;
    const out = await this.player.run({
      tokens: this.ints(body, [1, tokens, fields]),
      token_count: this.ints([tokens], [1]),
      actions: this.ints(rows, [1, actions, actionFields]),
      action_count: this.ints([actions], [1]),
    });
    return out.scores!.data as Float32Array;
  }

  /** Value of each legal move, from `samples` deals of the hidden cards. */
  private async lookAhead(round: Round, seed: number, samples: number): Promise<Float32Array> {
    const [fields, , maxSeats] = layout() as unknown as [number, number, number];
    const ahead = new Lookahead(round, samples, seed >>> 0);
    try {
      const rows = ahead.rows;
      const values = new Float32Array(rows * maxSeats);
      if (rows > 0) {
        ahead.observe(true);
        const width = ahead.maxTokens * fields;
        const tokens = ahead.tokens();
        const counts = ahead.tokenCount();
        for (let from = 0; from < rows; from += CHUNK) {
          const to = Math.min(rows, from + CHUNK);
          const out = await this.judge.run({
            tokens: this.ints(tokens.subarray(from * width, to * width), [to - from, ahead.maxTokens, fields]),
            token_count: this.ints(counts.subarray(from, to), [to - from]),
          });
          values.set(out.values!.data as Float32Array, from * maxSeats);
        }
      }
      return ahead.finish(values, this.scale[round.id] ?? 1);
    } finally {
      ahead.free();
    }
  }

  /**
   * A move for the seat to move in `round` (a round in the form the model
   * plays: see `Round.forSeat`). `random` gives numbers in [0, 1); `settings`
   * replaces the player's own for this move.
   */
  async choose(
    round: Round,
    seed: number,
    random: () => number = Math.random,
    settings: ModelSettings = this.settings,
  ): Promise<ModelChoice> {
    const prior = await this.prior(round);
    const n = prior.length;
    if (n === 0) throw new Error('no legal move to choose from');
    const values = n > 1 && settings.samples > 0 ? await this.lookAhead(round, seed, settings.samples) : new Float32Array(0);
    const scores = Array.from(prior, (p, i) => p + (values[i] ?? 0) / settings.temperature);
    const top = Math.max(...scores);
    const weights = scores.map((s) => Math.exp(s - top));
    const total = weights.reduce((a, b) => a + b, 0);
    const policy = weights.map((w) => w / total);
    let index = policy.indexOf(Math.max(...policy));
    if (!settings.greedy) {
      let left = random();
      for (index = 0; index < n - 1; index += 1) {
        left -= policy[index]!;
        if (left < 0) break;
      }
    }
    return { index, policy, prior: Array.from(prior, Math.exp), values: Array.from(values) };
  }
}
