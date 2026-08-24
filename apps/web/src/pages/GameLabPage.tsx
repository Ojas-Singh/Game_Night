/**
 * Game Lab (Phase 3A §2/§12): gallery of GameSpec games + Simulation Lab.
 * All game logic lives in the RuleZero service — this page is pure UI.
 */
import { useCallback, useEffect, useState } from 'react';
import { Link } from 'react-router-dom';

interface GalleryCard {
  id: string;
  title: string;
  blurb: string;
  tags: string[];
  specHash: string;
  mutations: string[];
}

interface SimStats {
  episodes: number;
  unfinished: number;
  wins: Record<string, number>;
  tiesPct: number;
  avgReturns: Record<string, number>;
  meanGameLength: number;
  decisionsPerGame: number;
  wallSeconds: number;
}

export default function GameLabPage() {
  const [games, setGames] = useState<GalleryCard[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [selected, setSelected] = useState<GalleryCard | null>(null);
  const [sim, setSim] = useState<SimStats | null>(null);
  const [simming, setSimming] = useState(false);
  const [episodes, setEpisodes] = useState(500);

  useEffect(() => {
    fetch('/api/lab/games')
      .then((r) => r.json())
      .then((d) => (d.games ? setGames(d.games) : setError(d.error)))
      .catch((e) => setError(String(e)));
  }, []);

  const runSim = useCallback(async () => {
    if (!selected) return;
    setSimming(true);
    setSim(null);
    try {
      const r = await fetch('/api/lab/simulate', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          id: selected.id,
          agents: [{ agent: 'random' }, { agent: 'first' }],
          episodes,
          seed: 42,
        }),
      });
      const d = await r.json();
      if (d.error) setError(d.error);
      else setSim(d);
    } catch (e) {
      setError(String(e));
    } finally {
      setSimming(false);
    }
  }, [selected, episodes]);

  return (
    <div className="gamelab">
      <header className="gamelab-header">
        <h1>Game Lab</h1>
        <p className="muted">
          Rule-defined games compiled to GameSpec — played, simulated and
          analysed by the RuleZero engine. No two games share a runtime.
        </p>
        <Link to="/" className="rz-backlink">← Back to lobby</Link>
      </header>

      {error && <div className="gamelab-error">{error}</div>}

      <section className="gamelab-grid">
        {games.map((g) => (
          <article
            key={g.id}
            className={`gamelab-card ${selected?.id === g.id ? 'selected' : ''}`}
            onClick={() => { setSelected(g); setSim(null); }}
          >
            <h3>{g.title}</h3>
            <p>{g.blurb}</p>
            <div className="gamelab-tags">
              {g.tags.map((t) => (
                <span key={t} className="gamelab-tag">{t}</span>
              ))}
            </div>
            <div className="muted gamelab-hash">spec {g.specHash.slice(0, 12)}</div>
          </article>
        ))}
        {!games.length && !error && (
          <p className="muted">Loading gallery…</p>
        )}
      </section>

      {selected && (
        <section className="gamelab-sim">
          <h2>Simulation Lab — {selected.title}</h2>
          <div className="gamelab-controls">
            <label>
              Episodes{' '}
              <input
                type="number"
                min={10}
                max={20000}
                step={100}
                value={episodes}
                onChange={(e) => setEpisodes(Number(e.target.value))}
              />
            </label>
            <span className="muted">P1 random vs P2 first-always</span>
            <button disabled={simming} onClick={() => void runSim()}>
              {simming ? 'Running…' : 'Run simulation'}
            </button>
          </div>

          {sim && (
            <div className="gamelab-results">
              <div className="gamelab-statrow">
                <div><strong>P0</strong> {sim.wins.p0 ?? 0}%</div>
                <div><strong>P1</strong> {sim.wins.p1 ?? 0}%</div>
                <div><strong>Ties</strong> {sim.tiesPct}%</div>
              </div>
              <table>
                <tbody>
                  <tr><td>Avg return P0</td><td>{sim.avgReturns.p0}</td></tr>
                  <tr><td>Avg return P1</td><td>{sim.avgReturns.p1}</td></tr>
                  <tr><td>Mean game length</td><td>{sim.meanGameLength} steps</td></tr>
                  <tr><td>Decisions per game</td><td>{sim.decisionsPerGame}</td></tr>
                  <tr><td>Episodes</td><td>{sim.episodes}</td></tr>
                  <tr><td>Wall time</td><td>{sim.wallSeconds}s</td></tr>
                </tbody>
              </table>
            </div>
          )}
        </section>
      )}
    </div>
  );
}
