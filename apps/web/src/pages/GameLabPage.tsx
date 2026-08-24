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

interface StrategySample {
  infoState: string;
  candidates: { label: string; prob: number }[];
}

interface StrategyProfile {
  nashConv: number | null;
  states: number;
  iterations: number;
  samples: StrategySample[];
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
  const [agents, setAgents] = useState<{ p0: string; p1: string }>({
    p0: 'cfr', p1: 'random',
  });
  const [strategy, setStrategy] = useState<StrategyProfile | null>(null);
  const [strategyLoading, setStrategyLoading] = useState(false);

  const loadStrategy = useCallback(async (id: string) => {
    setStrategyLoading(true);
    setStrategy(null);
    try {
      const r = await fetch(`/api/lab/games/${id}/strategy`);
      const d = await r.json();
      if (!d.error) setStrategy(d);
    } finally {
      setStrategyLoading(false);
    }
  }, []);

  useEffect(() => {
    if (selected) void loadStrategy(selected.id);
  }, [selected, loadStrategy]);

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
          agents: [{ agent: agents.p0 }, { agent: agents.p1 }],
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
  }, [selected, episodes, agents]);

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
            <label>
              P0{' '}
              <select
                value={agents.p0}
                onChange={(e) => setAgents((a) => ({ ...a, p0: e.target.value }))}
              >
                <option value="cfr">CFR Solver</option>
                <option value="random">Random</option>
                <option value="first">First-always</option>
              </select>
            </label>
            <label>
              P1{' '}
              <select
                value={agents.p1}
                onChange={(e) => setAgents((a) => ({ ...a, p1: e.target.value }))}
              >
                <option value="cfr">CFR Solver</option>
                <option value="random">Random</option>
                <option value="first">First-always</option>
              </select>
            </label>
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

          {strategyLoading && (
            <p className="muted">Solving with CFR…</p>
          )}

          {strategy && (
            <div className="gamelab-strategy">
              <h3>Solver analysis — CFR</h3>
              <div className="muted">
                {strategy.states} decision points solved ·{' '}
                {strategy.iterations} iterations · exploitability{' '}
                {strategy.nashConv != null
                  ? `NashConv ${strategy.nashConv.toFixed(4)}`
                  : 'n/a'}
              </div>
              {strategy.samples.slice(0, 3).map((sm) => (
                <div key={sm.infoState} className="gamelab-situation">
                  <code>{sm.infoState.split('vars')[0]}</code>
                  {sm.candidates.map((c) => (
                    <div key={c.label} className="gamelab-bar-row">
                      <span className="gamelab-bar-label">{c.label}</span>
                      <span className="gamelab-bar">
                        <span
                          style={{ width: `${Math.round(c.prob * 100)}%` }}
                        />
                      </span>
                      <span>{Math.round(c.prob * 100)}%</span>
                    </div>
                  ))}
                </div>
              ))}
              <p className="muted gamelab-safe">
                Distributions are computed from each seat's own information
                state — hidden cards are never revealed.
              </p>
            </div>
          )}
        </section>
      )}
    </div>
  );
}
