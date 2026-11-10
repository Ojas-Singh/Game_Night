import { describe, expect, it } from 'vitest';
import type { LabReport } from '@shared/lab.js';
import { describeChanges, distance, layOut, readReportFile, type LabSetting } from '../src/lab/format.js';

function report(change: Partial<LabReport> = {}): LabReport {
  return {
    game: 'cabo',
    rules: { startingCards: 4, rankValues: [1, 2, 3] },
    players: 2,
    rounds: 1000,
    abandoned: 0,
    seats: [
      { mean: 0.1, stderr: 0.03, won: { mean: 0.52, stderr: 0.016 }, shared: { mean: 0.02, stderr: 0.004 } },
      { mean: -0.1, stderr: 0.03, won: { mean: 0.44, stderr: 0.016 }, shared: { mean: 0.02, stderr: 0.004 } },
    ],
    spread: { mean: 0.2, stderr: 0.06, best: 0, worst: 1 },
    draws: { mean: 0.02, stderr: 0.004 },
    length: { mean: 60, stderr: 0.5, p10: 40, p50: 58, p90: 85 },
    actions: [
      { verb: 2, name: 'Draw', perRound: 12, taken: 1 },
      { verb: 11, name: 'Call Cabo', perRound: 0, taken: null },
    ],
    stats: [{ key: 'turns', label: 'Turns', mean: 12, stderr: 0.1, applies: 1 }],
    ...change,
  };
}

const settings: LabSetting[] = [
  { key: 'startingCards', label: 'Cards per player', help: '', group: 'Deal', kind: 'int' },
  { key: 'rankValues', label: 'Points per rank', help: '', group: 'Cards', kind: 'rankInts' },
];

describe('lab reports', () => {
  it('reads a single report and a comparison from the trainer tools', () => {
    const single = readReportFile(JSON.stringify(report()), 'cabo-run.json');
    expect(Object.keys(single.reports)).toEqual(['cabo-run']);
    const sweep = readReportFile(
      JSON.stringify({ game: 'cabo', baseline: 'a', reports: { a: report(), b: report({ length: { mean: 80, stderr: 0.5, p10: 50, p50: 78, p90: 110 } }) }, changes: {} }),
      'sweep.json',
    );
    expect(sweep.baseline).toBe('a');
    expect(sweep.changes.b![0]).toMatchObject({ name: 'Decisions per round', change: 20 });
    expect(() => readReportFile('{"hello": 1}', 'x.json')).toThrow(/not a lab report/);
  });

  it('says which rules a set changes', () => {
    expect(describeChanges({ startingCards: 6, rankValues: [1, 2, 9] }, report().rules, settings)).toEqual([
      'Cards per player: 4 → 6',
      'Points per rank (3: 3 → 9)',
    ]);
  });

  it('lays reports out side by side and leaves out moves nobody made', () => {
    const sections = layOut([report(), report()]);
    expect(sections.map((s) => s.title)).toEqual(['Seats', 'Length', 'The game', 'Moves']);
    expect(sections[3]!.rows.map((r) => r.label)).toEqual(['Draw']);
    expect(sections[0]!.rows[1]!.cells[0]).toMatchObject({ text: '52.0%', error: '± 1.6%' });
  });

  it('measures a difference in standard errors', () => {
    const cell = (value: number, stderr: number | null) => ({ text: '', error: '', value, stderr });
    expect(distance(cell(80, 0.3), cell(60, 0.4))).toBeCloseTo(40);
    expect(distance(cell(80, null), cell(60, 0.4))).toBeNull();
  });
});
