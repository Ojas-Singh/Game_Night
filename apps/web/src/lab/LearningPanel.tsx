import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import type { RoomApi } from '../useRoom.js';
import { labApi } from './api.js';

type Checkpoint = { id: string; generation: number; runId: string; promoted: boolean; metrics: any };
export default function LearningPanel({ room }: { room: RoomApi }) {
  const [checkpoints, setCheckpoints] = useState<Checkpoint[]>([]);
  const [selected, setSelected] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [game, setGame] = useState('kuhnish');
  const navigate = useNavigate();
  useEffect(() => {
    let stopped = false;
    const load = () => labApi('/checkpoints').then(r => { if (!stopped) setCheckpoints(r.checkpoints); }).catch(e => { if (!stopped) setError(e.message); });
    void load(); const timer = setInterval(load, 10000);
    return () => { stopped = true; clearInterval(timer); };
  }, []);
  const checkpoint = checkpoints.find(c => c.id === selected);
  async function watch() {
    setBusy(true); setError('');
    try {
      const { token } = await labApi(`/games/${game}/room`, {});
      const r = await room.createRoom('Audience', token, true, true, selected);
      if (!r.ok) throw new Error(r.error);
      navigate(`/game/${r.roomId}`);
    } catch (e) { setError((e as Error).message); } finally { setBusy(false); }
  }
  return <section className="lab-review"><p className="eyebrow">LEARNING AT THE TABLE</p><h2>Watch practice become progress</h2>
    <p>Compare real saved policies. A new checkpoint is promoted only when its validation results support an improvement.</p>
    {!checkpoints.length ? <p>No trained checkpoints yet. Completed training runs will appear here.</p> : <>
      <label>Checkpoint<select value={selected} onChange={e => setSelected(e.target.value)}><option value="">Choose a checkpoint</option>
        {checkpoints.map(c => <option key={c.id} value={c.id}>{c.runId.slice(0,6)} · Generation {c.generation}{c.promoted ? ' · Promoted' : ''}</option>)}
      </select></label>
      <label>Game<select value={game} onChange={e => setGame(e.target.value)}><option value="kuhnish">Kuhnish Duel</option><option value="claim">Counter Claim</option><option value="goofseq">Prize Bidding</option></select></label>
      {checkpoint?.metrics.validation && <p>Validation return: {checkpoint.metrics.validation.averageReturn.toFixed(3)} · 95% interval [{checkpoint.metrics.validation.confidence95.map((x: number) => x.toFixed(3)).join(', ')}] · {checkpoint.metrics.validation.games} games</p>}
      <button disabled={!selected || busy || !room.socket} onClick={() => void watch()}>Watch AI vs AI</button>
    </>}{error && <p role="alert">{error}</p>}
  </section>;
}
