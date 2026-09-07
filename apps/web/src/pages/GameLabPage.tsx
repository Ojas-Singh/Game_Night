import { useEffect, useState } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import type { RoomApi } from '../useRoom.js';
import { loadName } from '../session.js';
import LearningPanel from '../lab/LearningPanel.js';
import CompileFlow from '../lab/CompileFlow.js';
import { labApi } from '../lab/api.js';

type Game = { id: string; title: string; blurb: string; tags: string[]; specHash: string };
export default function GameLabPage({ room }: { room: RoomApi }) {
  const [games, setGames] = useState<Game[]>([]);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState('');
  const [job, setJob] = useState<any>(null);
  const navigate = useNavigate();
  const [params] = useSearchParams();
  useEffect(() => {
    const shared = params.get('g');
    if (shared) navigate(`/shared/${shared}`, { replace: true });
    labApi('/games').then(r => setGames(r.games)).catch(e => setError(e.message));
  }, []);
  useEffect(() => {
    if (!job || !['queued', 'running'].includes(job.status)) return;
    const timer = setInterval(() => labApi('/jobs/' + job.id).then(r => setJob(r.job)).catch(e => setError(e.message)), 1000);
    return () => clearInterval(timer);
  }, [job?.id, job?.status]);
  async function launchShared(id: string, ai: boolean) {
    const { token } = await labApi(`/shared/${id}/room`, {});
    const result = await room.createRoom(loadName() || 'Host', token, ai);
    if (!result.ok) throw new Error(result.error);
    navigate(`/game/${result.roomId}`);
  }
  async function launch(game: Game, ai: boolean) {
    setBusy(game.id); setError('');
    try { const r = await labApi('/shared', { galleryId: game.id }); await launchShared(r.shareId, ai); }
    catch (e) { setError((e as Error).message); } finally { setBusy(''); }
  }
  return <main className="scroll-page"><div className="lab-page">
    <header className="lab-header"><Link to="/" className="brand">Game Night</Link><span>GAME LAB</span></header>
    <CompileFlow onLaunch={launchShared} />
    <LearningPanel room={room} />
    <section aria-labelledby="gallery-title"><p className="eyebrow">PULL UP A CHAIR</p><h2 id="gallery-title">Discover something new</h2>
      <p className="muted">Small games with interesting decisions. Every game runs on the same deterministic rules interpreter.</p>
      {error && <p role="alert" className="lab-error">{error}</p>}
      <div className="discovery-grid">{games.map(game => <article className="discovery-card" key={game.id}>
        <div className="game-card-art" aria-hidden>♠</div><h3>{game.title}</h3><p>{game.blurb}</p><div className="game-tags">{game.tags.map(t => <span key={t}>{t}</span>)}</div>
        <div className="launch-row"><button disabled={!!busy || !room.socket} onClick={() => void launch(game, false)}>Play</button><button disabled={!!busy || !room.socket} onClick={() => void launch(game, true)}>Play vs AI</button></div>
        <button className="ghost" onClick={async () => { try { const r = await labApi('/simulate', { id: game.id, agents: [{ agent: 'random' }, { agent: 'random' }], episodes: 100 }); setJob(r.job); } catch (e) { setError((e as Error).message); } }}>Simulate 100 games</button>
      </article>)}</div>
      {job && <section className="lab-review" aria-live="polite"><h3>Simulation</h3>{job.status === 'ready' ? <>
        <p>{job.result.episodes} episodes · {job.result.unfinished} unfinished</p>
        <p>Average returns: {Object.entries(job.result.avgReturns).map(([p, v]) => `${p}: ${v}`).join(' · ')}</p>
      </> : <p>{job.error || job.status}</p>}</section>}
    </section>
  </div></main>;
}
