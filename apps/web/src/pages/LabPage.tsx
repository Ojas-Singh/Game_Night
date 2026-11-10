import { useEffect, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import type { LabComparison, LabPlayerKind, LabRunStatus } from '@shared/lab.js';
import { LabError, labApi, labKey, setLabKey, type LabInfo } from '../lab/api.js';
import { changedKeys, readReportFile, type LabGame, type Rules } from '../lab/format.js';
import LabResults from '../lab/LabResults.js';
import RulesEditor from '../lab/RulesEditor.js';
import '../styles/lab.css';

interface RuleSet {
  id: number;
  name: string;
  rules: Rules;
}

const clone = <T,>(value: T): T => JSON.parse(JSON.stringify(value)) as T;

function firstSets(game: LabGame): RuleSet[] {
  const [name, rules] = game.presets[0]!;
  return [{ id: 0, name, rules: clone(rules) }];
}

/**
 * The game lab: change a game's rules, play many rounds under each rule set
 * and see what moved. Runs here are measured by the server; reports made
 * elsewhere (`python -m gamelab_train.lab --json`) open from a file.
 */
export default function LabPage() {
  const [info, setInfo] = useState<LabInfo | null>(null);
  const [problem, setProblem] = useState<{ text: string; needsKey: boolean } | null>(null);
  const [key, setKey] = useState(labKey());
  const [gameId, setGameId] = useState('');
  const [players, setPlayers] = useState(2);
  const [sets, setSets] = useState<RuleSet[]>([]);
  const [open, setOpen] = useState(0);
  const [player, setPlayer] = useState<LabPlayerKind>('random');
  const [rounds, setRounds] = useState(2000);
  const [seed, setSeed] = useState(0);
  const [run, setRun] = useState<LabRunStatus | null>(null);
  const [result, setResult] = useState<LabComparison | null>(null);
  const [message, setMessage] = useState('');
  const nextId = useRef(1);

  const chooseGame = (game: LabGame, modelGames: string[]) => {
    setGameId(game.id);
    setPlayers(game.minPlayers);
    setSets(firstSets(game));
    setOpen(0);
    setPlayer(modelGames.includes(game.id) ? 'model' : 'random');
  };

  const load = () => {
    labApi.info().then(
      (data) => {
        setInfo(data);
        setProblem(null);
        const game = data.games.find((g) => g.id === 'cabo') ?? data.games[0];
        if (game) chooseGame(game, data.modelGames);
      },
      (err: unknown) => setProblem({
        needsKey: err instanceof LabError && err.status === 401,
        text: err instanceof LabError && err.status === 404 ? 'The lab is not switched on for this server.' : String(err instanceof Error ? err.message : err),
      }),
    );
  };
  useEffect(load, []);

  // Follow the run in progress.
  const running = run?.state === 'running' ? run.id : null;
  useEffect(() => {
    if (!running) return undefined;
    const timer = setInterval(() => {
      labApi.status(running).then(
        (status) => {
          setRun(status);
          if (status.state === 'done' && status.result) setResult(status.result);
          if (status.state === 'failed') setMessage(status.error ?? 'the run failed');
        },
        (err: unknown) => {
          setRun(null);
          setMessage(String(err instanceof Error ? err.message : err));
        },
      );
    }, 400);
    return () => clearInterval(timer);
  }, [running]);

  if (!info) {
    return (
      <div className="lab-page">
        <Link to="/" className="shop-back">← Game Night</Link>
        <h1 className="font-display">Game lab</h1>
        {problem ? <p className="lab-warning" role="alert">{problem.text}</p> : <p className="lab-note">Opening the lab…</p>}
        {problem?.needsKey && (
          <form className="lab-key" onSubmit={(e) => { e.preventDefault(); setLabKey(key); load(); }}>
            <input type="password" aria-label="Lab key" placeholder="Lab key" value={key} onChange={(e) => setKey(e.target.value)} />
            <button type="submit">Open</button>
          </form>
        )}
      </div>
    );
  }

  const game = info.games.find((g) => g.id === gameId)!;
  const hasModel = info.modelGames.includes(game.id);
  const current = sets[open] ?? sets[0]!;
  const base = sets[0]!;
  const playerCounts = Array.from({ length: game.maxPlayers - game.minPlayers + 1 }, (_, i) => game.minPlayers + i);

  const edit = (change: (set: RuleSet) => RuleSet) => setSets(sets.map((s) => (s.id === current.id ? change(s) : s)));
  const addSet = () => {
    const id = nextId.current++;
    setSets([...sets, { id, name: `Variant ${sets.length}`, rules: clone(current.rules) }]);
    setOpen(sets.length);
  };
  const removeSet = () => {
    setSets(sets.filter((s) => s.id !== current.id));
    setOpen(0);
  };

  const start = async () => {
    setMessage('');
    try {
      const { id } = await labApi.start({
        game: game.id,
        players,
        rounds,
        player,
        seed,
        variants: sets.map((s) => ({ name: s.name.trim(), rules: s.rules })),
      });
      setRun({ id, state: 'running', done: 0, total: rounds * sets.length });
    } catch (err) {
      setMessage(String(err instanceof Error ? err.message : err));
    }
  };

  const openFile = async (file: File | undefined) => {
    if (!file) return;
    setMessage('');
    try {
      setResult(readReportFile(await file.text(), file.name));
    } catch (err) {
      setMessage(String(err instanceof Error ? err.message : err));
    }
  };

  return (
    <div className="lab-page">
      <Link to="/" className="shop-back">← Game Night</Link>
      <h1 className="font-display">Game lab</h1>
      <p className="lab-note">Change the rules, play many rounds under each rule set, and see what moved.</p>

      <section className="lab-setup" aria-label="What to measure">
        <label>
          <span>Game</span>
          <select value={game.id} onChange={(e) => chooseGame(info.games.find((g) => g.id === e.target.value)!, info.modelGames)}>
            {info.games.map((g) => <option key={g.id} value={g.id}>{g.id}</option>)}
          </select>
        </label>
        <label>
          <span>Players</span>
          <select value={players} onChange={(e) => setPlayers(Number(e.target.value))}>
            {playerCounts.map((n) => <option key={n} value={n}>{n}</option>)}
          </select>
        </label>
        <label>
          <span>Played by</span>
          <select value={player} onChange={(e) => setPlayer(e.target.value as LabPlayerKind)}>
            <option value="random">Random moves</option>
            <option value="model" disabled={!hasModel}>Trained player</option>
            <option value="search" disabled={!hasModel}>Trained player, looking ahead ({info.modelSamples} deals)</option>
          </select>
        </label>
        <label>
          <span>Rounds per rule set</span>
          <input type="number" min={10} max={info.limits.rounds} step={100} value={rounds} onChange={(e) => setRounds(Math.max(10, Math.min(info.limits.rounds, Number(e.target.value) || 10)))} />
        </label>
        <label>
          <span>Seed</span>
          <input type="number" min={0} value={seed} onChange={(e) => setSeed(Math.max(0, Number(e.target.value) || 0))} />
        </label>
      </section>
      {!hasModel && (
        <p className="lab-note">
          No trained player for this game is loaded on this server, so runs here use random moves. Reports made with the
          trained player elsewhere can be opened below.
        </p>
      )}

      <section className="lab-sets" aria-label="Rule sets">
        <div className="lab-tabs" role="tablist" aria-label="Rule sets">
          {sets.map((s, i) => (
            <button key={s.id} type="button" role="tab" aria-selected={i === open} className={i === open ? 'on' : ''} onClick={() => setOpen(i)}>
              {s.name || 'Unnamed'}
              {i === 0 ? <small>baseline</small> : <small>{changedKeys(s.rules, base.rules).length} changed</small>}
            </button>
          ))}
          <button type="button" className="ghost" onClick={addSet} disabled={sets.length >= info.limits.variants}>+ Rule set</button>
        </div>
        <div className="lab-set-head">
          <label>
            <span>Name</span>
            <input type="text" value={current.name} maxLength={60} onChange={(e) => edit((s) => ({ ...s, name: e.target.value }))} />
          </label>
          <label>
            <span>Start from</span>
            <select value="" onChange={(e) => { const found = game.presets.find(([n]) => n === e.target.value); if (found) edit((s) => ({ ...s, rules: clone(found[1]) })); }}>
              <option value="">a preset…</option>
              {game.presets.map(([name]) => <option key={name} value={name}>{name}</option>)}
            </select>
          </label>
          {open > 0 && <button type="button" className="ghost" onClick={removeSet}>Remove</button>}
        </div>
        <RulesEditor
          settings={game.settings}
          rules={current.rules}
          base={open === 0 ? game.presets[0]![1] : base.rules}
          onChange={(k, v) => edit((s) => ({ ...s, rules: { ...s.rules, [k]: v } }))}
        />
      </section>

      <section className="lab-run">
        {running ? (
          <>
            <progress value={run!.done} max={run!.total} aria-label="Rounds played" />
            <span>{run!.done.toLocaleString()} of {run!.total.toLocaleString()} rounds</span>
            <button type="button" className="ghost" onClick={() => void labApi.cancel(running)}>Stop</button>
          </>
        ) : (
          <>
            <button type="button" onClick={() => void start()}>Measure</button>
            <label className="lab-file">
              Open a report file
              <input type="file" accept="application/json,.json" onChange={(e) => { void openFile(e.target.files?.[0]); e.target.value = ''; }} />
            </label>
          </>
        )}
        {message && <p className="lab-warning" role="alert">{message}</p>}
      </section>

      {result && <LabResults result={result} game={info.games.find((g) => g.id === result.game)} />}
    </div>
  );
}
