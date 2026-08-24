/**
 * Game Lab (Phase 3A §2/§12): gallery of GameSpec games + Simulation Lab.
 * All game logic lives in the RuleZero service — this page is pure UI.
 */
import { useCallback, useEffect, useState } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';

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

async function shareGame(galleryId: string): Promise<string | null> {
  try {
    const r = await fetch('/api/lab/shared', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ galleryId, params: {} }),
    });
    return ((await r.json()) as { shareId?: string }).shareId ?? null;
  } catch {
    return null;
  }
}

export default function GameLabPage() {
  const navigate = useNavigate();
  const [launching, setLaunching] = useState<string | null>(null);
  const [games, setGames] = useState<GalleryCard[]>([]);
  const [shareId, setShareId] = useState<string | null>(null);
  const [searchParams, setSearchParams] = useSearchParams();
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

  // Launch a live RuleZero room with this game's spec: stage the spec
  // server-side, then let the home page's normal create-room flow consume it.
  const playLive = useCallback(async (id: string, vsAi: boolean) => {
    setLaunching(id);
    try {
      const r = await fetch(`/api/lab/games/${id}/room`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ params: {} }),
      });
      const d = await r.json();
      if (d.token) {
        sessionStorage.setItem(
          'rulezeroLaunch',
          JSON.stringify({ token: d.token, autoAi: vsAi }),
        );
        navigate('/');
      }
    } finally {
      setLaunching(null);
    }
  }, [navigate]);

  // ---- Create a new game (rules -> compile -> validate -> play) ----------
  const [rulesText, setRulesText] = useState('');
  const [compiling, setCompiling] = useState(false);
  interface CompileReport {
    ok: boolean;
    spec?: Record<string, unknown>;
    stage?: string;
    diagnostics?: string[];
    specHash?: string;
    report?: {
      assumptions: string[]; ambiguities: string[]; unsupported: string[];
      smoke: { episodes: number; reached_terminal: number };
      players: number; phases: string[];
    };
  }
  const [report, setReport] = useState<CompileReport | null>(null);

  const compileGame = useCallback(async () => {
    setCompiling(true);
    setReport(null);
    try {
      const r = await fetch('/api/lab/compile', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ text: rulesText }),
      });
      setReport((await r.json()) as CompileReport);
    } catch (e) {
      setReport({ ok: false, stage: 'network', diagnostics: [String(e)] });
    } finally {
      setCompiling(false);
    }
  }, [rulesText]);

  const playCompiled = useCallback(async (vsAi: boolean) => {
    if (!report?.ok || !report.spec) return;
    setLaunching('custom');
    try {
      const sh = await fetch('/api/lab/shared', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ spec: report.spec }),
      });
      const d = (await sh.json()) as { shareId?: string };
      if (!d.shareId) return;
      const rr = await fetch(`/api/lab/shared/${d.shareId}/room`, { method: 'POST' });
      const rd = (await rr.json()) as { token?: string };
      if (rd.token) {
        sessionStorage.setItem(
          'rulezeroLaunch',
          JSON.stringify({ token: rd.token, autoAi: vsAi }),
        );
        navigate('/');
      }
    } finally {
      setLaunching(null);
    }
  }, [report, navigate]);

  useEffect(() => {
    fetch('/api/lab/games')
      .then((r) => r.json())
      .then((d) => (d.games ? setGames(d.games) : setError(d.error)))
      .catch((e) => setError(String(e)));
    const g = searchParams.get('g');
    if (g) setShareId(g);
  }, [searchParams]);

  const makeShare = useCallback(async () => {
    if (!selected) return null;
    const r = await fetch(`/api/lab/shared`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ galleryId: selected.id, params: {} }),
    });
    const d = await r.json();
    if (d.shareId) {
      setShareId(d.shareId);
      setSearchParams({ g: d.shareId });
      return d.shareId as string;
    }
    return null;
  }, [selected, setSearchParams]);

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
        <section className="gamelab-create">
        <h2>Create a new game</h2>
        <p className="muted">
          Describe the rules. The compiler proposes GameSpec data, validates it,
          smoke-plays it, and discloses every assumption — it never silently
          accepts a draft.
        </p>
        <div className="template-row">
          {['Two players each ante one token.',
            'Each player is dealt one hidden card from ranks 1 to 5. Players ante one token.',
            'Players take turns bidding resources; highest bid wins the pot.'].map((t) => (
            <button key={t} className="template-chip" onClick={() => setRulesText(t)}>
              {t.slice(0, 34)}…
            </button>
          ))}
        </div>
        <textarea
          className="rules-input"
          rows={4}
          placeholder={'e.g. "Each player is dealt one hidden card from ranks 1-5. Players ante one token..."'}
          value={rulesText}
          onChange={(e) => setRulesText(e.target.value)}
        />
        <button className="compile-btn" disabled={compiling || !rulesText.trim()} onClick={() => void compileGame()}>
          {compiling ? 'Compiling…' : '⚙ Compile Game'}
        </button>

        {report && !report.ok && (
          <div className="compile-report failed">
            <strong>✗ Compilation stopped at stage: {report.stage}</strong>
            <ul>{(report.diagnostics ?? []).map((d, i) => <li key={i}>{d}</li>)}</ul>
          </div>
        )}
        {report && report.ok && report.report && (
          <div className="compile-report passed">
            <ul>
              <li>✓ {report.report.players} players</li>
              <li>✓ phases: {(report.report.phases ?? []).join(' → ') || 'detected'}</li>
              <li>✓ semantic smoke: {report.report.smoke.reached_terminal}/{report.report.smoke.episodes} random episodes reached terminal</li>
              {(report.report.assumptions ?? []).map((a, i) => <li key={`a${i}`}>• assumption: {a}</li>)}
              {(report.report.ambiguities ?? []).map((a, i) => <li key={`m${i}`} className="warn">⚠ ambiguity: {a}</li>)}
              {(report.report.unsupported ?? []).map((a, i) => <li key={`u${i}`} className="warn">⚠ unsupported: {a}</li>)}
            </ul>
            <div className="launch-row">
              <button disabled={launching === 'custom'} onClick={() => void playCompiled(false)}>▶ Play with Friends</button>
              <button className="ai" disabled={launching === 'custom'} onClick={() => void playCompiled(true)}>▶ Play vs AI</button>
            </div>
          </div>
        )}
        </section>
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
            <div className="gamelab-play-row">
              <button
                className="gamelab-play"
                disabled={launching !== null}
                onClick={(e) => {
                  e.stopPropagation();
                  void playLive(g.id, false);
                }}
              >
                ▶ Play
              </button>
              <button
                className="gamelab-play gamelab-play-ai"
                disabled={launching !== null}
                onClick={(e) => {
                  e.stopPropagation();
                  void playLive(g.id, true);
                }}
              >
                {launching === g.id ? 'Staging…' : '▶ Play vs AI'}
              </button>
            </div>
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
            <button
              onClick={() => void makeShare()}
              title="Copy a link that opens exactly this game"
            >
              🔗 Share
            </button>
            {shareId && (
              <code className="gamelab-share-link">
                {`${window.location.origin}/gamelab?g=${shareId}`}
              </code>
            )}
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
