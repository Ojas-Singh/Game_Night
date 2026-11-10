/** Reading and laying out lab reports (see `@shared/lab`). */
import { labCompare, type LabComparison, type LabMean, type LabReport } from '@shared/lab.js';

/** One rule of a game, as the rules core describes it. */
export interface LabSetting {
  key: string;
  label: string;
  help: string;
  group: string;
  kind: 'int' | 'bool' | 'choice' | 'rankInts' | 'rankChoices' | string;
  min?: number;
  max?: number;
  options?: Array<{ value: string | number; label: string }>;
}

export interface LabGame {
  id: string;
  minPlayers: number;
  maxPlayers: number;
  settings: LabSetting[];
  presets: Array<[string, Record<string, unknown>]>;
}

export type Rules = Record<string, unknown>;

/**
 * A comparison from a file: one written by the lab page, or by
 * `python -m gamelab_train.lab --json` (a single report or a sweep).
 */
export function readReportFile(text: string, fileName: string): LabComparison {
  const data = JSON.parse(text) as Partial<LabComparison> & Partial<LabReport>;
  if (data.reports && typeof data.reports === 'object' && Object.keys(data.reports).length > 0) {
    return labCompare(String(data.game), data.reports);
  }
  if (Array.isArray(data.seats) && data.length && data.rules) {
    return labCompare(String(data.game), { [fileName.replace(/\.json$/i, '')]: data as LabReport });
  }
  throw new Error('this file is not a lab report');
}

/** The settings of `rules` that differ from `base`. */
export function changedKeys(rules: Rules, base: Rules): string[] {
  return Object.keys(rules).filter((key) => JSON.stringify(rules[key]) !== JSON.stringify(base[key]));
}

const RANKS = ['A', '2', '3', '4', '5', '6', '7', '8', '9', '10', 'J', 'Q', 'K'];

export function rankLabel(index: number): string {
  return RANKS[index] ?? String(index + 1);
}

/** A setting's value in words. */
export function showValue(setting: LabSetting | undefined, value: unknown): string {
  if (typeof value === 'boolean') return value ? 'yes' : 'no';
  const option = (v: unknown): string => setting?.options?.find((o) => o.value === v)?.label ?? String(v);
  if (Array.isArray(value)) return value.map((v, i) => `${rankLabel(i)}: ${option(v)}`).join(', ');
  return option(value);
}

/** What a rule set changes from another, as "Cards per player: 4 → 6" lines. */
export function describeChanges(rules: Rules, base: Rules, settings: LabSetting[]): string[] {
  return changedKeys(rules, base).map((key) => {
    const setting = settings.find((s) => s.key === key);
    const a = base[key];
    const b = rules[key];
    if (Array.isArray(a) && Array.isArray(b) && a.length === b.length) {
      const parts = b.flatMap((v, i) =>
        v === a[i] ? [] : [`${rankLabel(i)}: ${showValue(setting, a[i])} → ${showValue(setting, v)}`]);
      return `${setting?.label ?? key} (${parts.join(', ')})`;
    }
    return `${setting?.label ?? key}: ${showValue(setting, a)} → ${showValue(setting, b)}`;
  });
}

export function number(value: number | null | undefined, digits = 2): string {
  if (value === null || value === undefined || Number.isNaN(value)) return '–';
  return value.toFixed(digits);
}

export function percent(value: number | null | undefined): string {
  if (value === null || value === undefined || Number.isNaN(value)) return '–';
  return `${(value * 100).toFixed(1)}%`;
}

/** One number of a report in a table row. */
export interface Cell {
  text: string;
  /** The standard error, as text; empty when unknown. */
  error: string;
  value: number | null;
  stderr: number | null;
}

export interface Row {
  label: string;
  note?: string;
  cells: Cell[];
}

export interface Section {
  title: string;
  rows: Row[];
}

function cell(m: LabMean | undefined, kind: 'number' | 'percent' = 'number', digits = 2): Cell {
  const value = m?.mean ?? null;
  const stderr = m?.stderr ?? null;
  const show = kind === 'percent' ? percent : (v: number | null) => number(v, digits);
  return { text: show(value), error: stderr === null || value === null ? '' : `± ${show(stderr)}`, value, stderr };
}

/**
 * How far `cell` is from `base`, in standard errors; null when either has
 * none. Above about 3 the difference is not chance.
 */
export function distance(cell: Cell, base: Cell): number | null {
  if (cell.value === null || base.value === null || cell.stderr === null || base.stderr === null) return null;
  const error = Math.hypot(cell.stderr, base.stderr);
  return error > 0 ? (cell.value - base.value) / error : null;
}

/** The reports side by side: one column per report, in the order given. */
export function layOut(reports: LabReport[]): Section[] {
  const first = reports[0]!;
  const each = (f: (r: LabReport) => Cell): Cell[] => reports.map(f);
  const seats = Math.max(...reports.map((r) => r.players));
  const seatRows: Row[] = [];
  for (let s = 0; s < seats; s += 1) {
    seatRows.push({ label: `Seat ${s + 1}: result`, cells: each((r) => cell(r.seats[s])) });
    seatRows.push({ label: `Seat ${s + 1}: won outright`, cells: each((r) => cell(r.seats[s]?.won, 'percent')) });
  }
  const plain = (text: string, value: number | null): Cell => ({ text, error: '', value, stderr: null });
  const sections: Section[] = [
    {
      title: 'Seats',
      rows: [
        ...seatRows,
        { label: 'Best seat over worst', note: 'mean result', cells: each((r) => cell(r.spread)) },
        { label: 'Rounds nobody won', cells: each((r) => cell(r.draws, 'percent')) },
      ],
    },
    {
      title: 'Length',
      rows: [
        { label: 'Decisions per round', cells: each((r) => cell(r.length, 'number', 1)) },
        {
          label: 'Shortest and longest tenth',
          note: 'decisions',
          cells: each((r) => plain(`under ${number(r.length.p10, 0)} · over ${number(r.length.p90, 0)}`, null)),
        },
        { label: 'Rounds cut off at the step limit', cells: each((r) => plain(percent(r.abandoned), r.abandoned)) },
      ],
    },
  ];
  if (first.stats.length > 0) {
    sections.push({
      title: 'The game',
      rows: first.stats.map((stat) => {
        const share = Math.min(...reports.map((r) => r.stats.find((s) => s.key === stat.key)?.applies ?? 0));
        return {
          label: stat.label,
          note: share < 0.999 ? `where it applies (${percent(share)} of rounds)` : undefined,
          cells: each((r) => cell(r.stats.find((s) => s.key === stat.key))),
        };
      }),
    });
  }
  const used = first.actions.filter((a) => reports.some((r) => (r.actions.find((x) => x.verb === a.verb)?.perRound ?? 0) > 0));
  sections.push({
    title: 'Moves',
    rows: used.map((a) => ({
      label: a.name,
      note: 'per round · taken when possible',
      cells: each((r) => {
        const mine = r.actions.find((x) => x.verb === a.verb);
        return plain(`${number(mine?.perRound)} · ${percent(mine?.taken)}`, mine?.perRound ?? null);
      }),
    })),
  });
  return sections;
}
