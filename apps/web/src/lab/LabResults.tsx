import type { LabComparison } from '@shared/lab.js';
import { describeChanges, distance, layOut, type LabGame } from './format.js';

/** Differences of this many standard errors are marked as real. */
const REAL = 3;

const PLAYED_BY = {
  random: 'random moves',
  model: 'the trained player',
  search: 'the trained player, looking ahead',
} as const;

/** Rule sets side by side; numbers that moved from the first by more than chance are marked. */
export default function LabResults({ result, game }: { result: LabComparison; game?: LabGame }) {
  const names = Object.keys(result.reports);
  const reports = names.map((name) => result.reports[name]!);
  const base = reports[0]!;
  const sections = layOut(reports);
  const players = [...new Set(reports.map((r) => r.playedBy))];
  const save = () => {
    const url = URL.createObjectURL(new Blob([JSON.stringify(result, null, 1)], { type: 'application/json' }));
    const a = document.createElement('a');
    a.href = url;
    a.download = `lab-${result.game}.json`;
    a.click();
    URL.revokeObjectURL(url);
  };

  return (
    <section className="lab-results" aria-label="Results">
      <header className="lab-results-head">
        <h2>
          {result.game} · {base.players} players · {base.rounds.toLocaleString()} rounds
          {names.length > 1 ? ' per rule set' : ''}
        </h2>
        <button type="button" className="ghost" onClick={save}>Save as a file</button>
      </header>
      {players.length === 1 && players[0] && <p className="lab-note">Played by {PLAYED_BY[players[0]]}.</p>}
      {players.includes('random') && (
        <p className="lab-warning">
          Random moves show how the rules run, not how the game plays between good players. Balance needs the trained player.
        </p>
      )}
      <div className="lab-table-wrap">
        <table className="lab-table">
          <thead>
            <tr>
              <th />
              {names.map((name, i) => (
                <th key={name} scope="col">
                  {name}
                  {i > 0 && (
                    <small>
                      {describeChanges(reports[i]!.rules, base.rules, game?.settings ?? []).join(' · ') || 'same rules'}
                    </small>
                  )}
                  {i === 0 && names.length > 1 && <small>baseline</small>}
                </th>
              ))}
            </tr>
          </thead>
          {sections.map((section) => (
            <tbody key={section.title}>
              <tr className="lab-section">
                <th colSpan={names.length + 1} scope="rowgroup">{section.title}</th>
              </tr>
              {section.rows.map((row) => (
                <tr key={row.label}>
                  <th scope="row">
                    {row.label}
                    {row.note && <small>{row.note}</small>}
                  </th>
                  {row.cells.map((cell, i) => {
                    const z = i > 0 ? distance(cell, row.cells[0]!) : null;
                    const real = z !== null && Math.abs(z) >= REAL;
                    return (
                      <td key={names[i]} className={real ? (z! > 0 ? 'up' : 'down') : undefined}>
                        {real && <span className="lab-arrow" title={`${Math.abs(z!).toFixed(1)} standard errors from the baseline`}>{z! > 0 ? '▲' : '▼'}</span>}
                        {cell.text}
                        {cell.error && <small>{cell.error}</small>}
                      </td>
                    );
                  })}
                </tr>
              ))}
            </tbody>
          ))}
        </table>
      </div>
      {names.length > 1 && (
        <p className="lab-note">
          ▲ ▼ mark numbers at least {REAL} standard errors from the baseline; the rest could be chance at this number of rounds.
        </p>
      )}
    </section>
  );
}
