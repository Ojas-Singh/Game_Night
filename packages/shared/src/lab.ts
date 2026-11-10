/**
 * The game lab's data: what a set of rules does to a game.
 *
 * The same shapes are written by `python -m gamelab_train.lab --json` (runs
 * with the trained player on a cluster) and by the server's own lab runs, so
 * the lab page shows either.
 */

/** A mean with its standard error (null when it cannot be estimated). */
export interface LabMean {
  mean: number | null;
  stderr: number | null;
}

export interface LabSeat extends LabMean {
  /** Share of rounds the seat won alone. */
  won: LabMean;
  /** Share of rounds the seat shared the best result. */
  shared: LabMean;
}

export interface LabReport {
  game: string;
  rules: Record<string, unknown>;
  players: number;
  rounds: number;
  /** Share of rounds cut off at the step limit (left out of every number). */
  abandoned: number;
  seats: LabSeat[];
  /** The best seat's mean result minus the worst's. */
  spread: { mean: number; stderr: number | null; best: number; worst: number };
  draws: LabMean;
  /** Decisions per round. */
  length: LabMean & { p10: number; p50: number; p90: number };
  actions: Array<{ verb: number; name: string; perRound: number; taken: number | null }>;
  /** The game's own measurements; `applies` is the share of rounds they exist for. */
  stats: Array<{ key: string; label: string; mean: number | null; stderr: number | null; applies: number }>;
  /** Who played: absent in reports written by the trainer's tools. */
  playedBy?: LabPlayerKind;
}

export interface LabChange {
  name: string;
  base: number;
  value: number;
  change: number;
  /** The change in standard errors; above about 3 it is not chance. */
  z: number | null;
}

/** Several rule sets measured the same way; the first is the baseline. */
export interface LabComparison {
  game: string;
  baseline: string;
  reports: Record<string, LabReport>;
  changes: Record<string, LabChange[]>;
}

/** `random`: random legal moves; `model`: the trained player; `search`: the trained player looking ahead. */
export type LabPlayerKind = 'random' | 'model' | 'search';

export interface LabRunRequest {
  game: string;
  players: number;
  /** Rule sets by name; each gives every setting. The first is the baseline. */
  variants: Array<{ name: string; rules: Record<string, unknown> }>;
  rounds: number;
  player: LabPlayerKind;
  seed: number;
}

export interface LabRunStatus {
  id: string;
  state: 'running' | 'done' | 'failed' | 'cancelled';
  /** Rounds played and to play, over every rule set. */
  done: number;
  total: number;
  error?: string;
  result?: LabComparison;
}

/** Every number of a report with its standard error, by name. */
export function labNumbers(report: LabReport): Map<string, [number | null, number | null]> {
  const out = new Map<string, [number | null, number | null]>();
  report.seats.forEach((seat, s) => {
    out.set(`Seat ${s + 1}: result`, [seat.mean, seat.stderr]);
    out.set(`Seat ${s + 1}: won outright`, [seat.won.mean, seat.won.stderr]);
  });
  out.set('Best seat over worst', [report.spread.mean, report.spread.stderr]);
  out.set('Draws', [report.draws.mean, report.draws.stderr]);
  out.set('Decisions per round', [report.length.mean, report.length.stderr]);
  for (const stat of report.stats) out.set(stat.label, [stat.mean, stat.stderr]);
  for (const a of report.actions) out.set(`${a.name}: per round`, [a.perRound, null]);
  return out;
}

/** What differs between the first report and each of the others, largest first. */
export function labCompare(game: string, reports: Record<string, LabReport>): LabComparison {
  const names = Object.keys(reports);
  const first = labNumbers(reports[names[0]!]!);
  const changes: Record<string, LabChange[]> = {};
  for (const name of names.slice(1)) {
    const theirs = labNumbers(reports[name]!);
    const rows: LabChange[] = [];
    for (const [key, [b, eb]] of first) {
      const [v, ev] = theirs.get(key) ?? [null, null];
      if (b === null || v === null) continue;
      const z = eb !== null && ev !== null && eb + ev > 0 ? (v - b) / Math.hypot(eb, ev) : null;
      rows.push({ name: key, base: b, value: v, change: v - b, z });
    }
    rows.sort((a, b) => Math.abs(b.z ?? 0) - Math.abs(a.z ?? 0));
    changes[name] = rows;
  }
  return { game, baseline: names[0]!, reports, changes };
}
