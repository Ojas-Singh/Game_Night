import { useEffect, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import type { RoomApi } from '../useRoom.js';
import { loadName } from '../session.js';
import { funnel } from '../analytics.js';

export default function HomePage({ room }: { room: RoomApi }) {
  const navigate = useNavigate();
  const [name, setName] = useState(loadName());
  const [code, setCode] = useState('');
  const [busy, setBusy] = useState(false);
  const [joinError, setJoinError] = useState<string | null>(null);

  useEffect(() => { funnel.homeView(); }, []);

  const createGame = async (gameId = 'cabo') => {
    if (!room.socket) return;
    setBusy(true);
    setJoinError(null);
    const finalName = name.trim() || undefined;
    const rawLaunch = sessionStorage.getItem('rulezeroLaunch');
    sessionStorage.removeItem('rulezeroLaunch');
    let rzToken: string | undefined;
    let autoAi = false;
    if (rawLaunch) {
      try {
        const parsed = JSON.parse(rawLaunch) as { token?: string; autoAi?: boolean };
        rzToken = parsed.token;
        autoAi = Boolean(parsed.autoAi);
      } catch { /* ignore malformed */ }
    }
    const res = await room.createRoom(finalName ?? 'Host', rzToken, autoAi);
    setBusy(false);
    if (res.ok && res.roomId) { if (!rzToken) room.selectGame(gameId); navigate(`/game/${res.roomId}`); }
  };

  const joinGame = async () => {
    const clean = code.trim().toUpperCase();
    if (!room.socket || !clean) return;
    setBusy(true);
    setJoinError(null);
    const finalName = name.trim() || undefined;
    const res = await room.joinRoom(clean, finalName);
    setBusy(false);
    if (res.ok && res.roomId) navigate(`/game/${res.roomId}`);
    else setJoinError(res.error ?? 'failed to join room');
  };

  return (
    <div className="scroll-page home-page">
      <div className="home-wrap">
        <header className="home-nav">
          <Link to="/" className="home-brand" aria-label="Game Night home">
            <span className="home-brand-mark" aria-hidden>✦</span>
            <span><strong>Game Night</strong><small>One table. Every game.</small></span>
          </Link>
          <nav className="home-nav-links" aria-label="Main navigation">
            <a href="#games">Games</a>
            <Link to="/gamelab">Game Lab</Link>
            <span className="home-nav-status"><i /> No account needed</span>
          </nav>
        </header>

        <main>
          <section className="home-hero" aria-labelledby="home-title">
            <div className="home-hero-copy">
              <p className="eyebrow">THE TABLE IS OPEN</p>
              <h1 id="home-title" className="font-display home-title">Bring your people.<br /><em>Deal something great.</em></h1>
              <p className="home-sub">
                A warm, easy place for game nights with friends. Live voice &amp; video at the table, a 3D room, AI opponents, and house rules that actually play.
              </p>
              <div className="home-card" aria-label="Start or join a table">
                <div className="home-action-heading"><span>Start a table</span><small>Pick a game after everyone arrives.</small></div>
                <div className="home-form">
                  <label className="sr-only" htmlFor="home-name">Your name</label>
                  <input
                    id="home-name"
                    type="text"
                    placeholder="Your name"
                    value={name}
                    maxLength={24}
                    onChange={(e) => setName(e.target.value)}
                    onKeyDown={(e) => e.key === 'Enter' && !busy && createGame()}
                  />
                  <button onClick={() => void createGame()} disabled={!room.socket || busy}>
                    {busy ? 'Setting the table…' : 'Create room'}
                  </button>
                </div>
                <p className="home-hint">You’ll get a shareable link. Friends join instantly.</p>
                <div className="home-join-divider"><span>already have a room?</span></div>
                <div className="home-join">
                  <label className="sr-only" htmlFor="home-code">Room code</label>
                  <input
                    id="home-code"
                    type="text"
                    placeholder="ABC123"
                    value={code}
                    maxLength={6}
                    autoCapitalize="characters"
                    autoCorrect="off"
                    spellCheck={false}
                    className="join-code"
                    onChange={(e) => setCode(e.target.value.toUpperCase())}
                    onKeyDown={(e) => e.key === 'Enter' && !busy && joinGame()}
                  />
                  <button className="ghost" onClick={joinGame} disabled={!room.socket || busy || !code.trim()}>Join room</button>
                </div>
                {joinError && <p className="home-join-error">{joinError}</p>}
                {room.status !== 'connected' && <p className="home-status">Connecting to server…</p>}
              </div>
            </div>

            <div className="home-stage" aria-label="A game table waiting for players">
              <div className="home-stage-glow" />
              <div className="home-stage-topline"><span>TONIGHT’S TABLE</span><span>2–6 PLAYERS</span></div>
              <div className="home-stage-table">
                <div className="stage-card stage-card-back" aria-hidden>♣</div>
                <div className="stage-card stage-card-face" aria-hidden><b>7</b><span>♥</span></div>
                <div className="stage-card stage-card-diamond" aria-hidden>♦</div>
                <div className="stage-table-center"><span>GAME NIGHT</span><strong>PLAY TOGETHER</strong></div>
              </div>
              <div className="stage-seat stage-seat-a"><span>♠</span><small>Sam</small></div>
              <div className="stage-seat stage-seat-b"><span>♥</span><small>Riley</small></div>
              <div className="stage-seat stage-seat-c"><span>✦</span><small>You</small></div>
              <div className="home-stage-caption"><strong>Classics, house rules, and brand-new ideas.</strong><span>Share one link and pull up a chair.</span></div>
            </div>
          </section>

          <section className="home-discovery" id="games" aria-labelledby="games-title">
            <div className="home-section-heading"><div><p className="eyebrow">FIND YOUR NEXT FAVORITE</p><h2 id="games-title">Pick a table.</h2></div><p>Start with a classic, then make something entirely your own.</p></div>
            <div className="discovery-grid">
              {[{ id: 'cabo', title: 'Cabo', info: 'Memory, timing & misdirection', meta: '2–6 players', symbol: '♦', tone: 'red' },
                { id: 'seep', title: 'Seep', info: 'Partners, captures & big swings', meta: '4 players · 2v2', symbol: '♠', tone: 'green' },
                { id: 'pairone', title: 'Pair One', info: 'A bright, social memory game', meta: '2–6 players', symbol: '♥', tone: 'blue' }].map(g =>
                <article className={`discovery-card game-discovery-card ${g.tone}`} key={g.id}><div className="game-card-art" aria-hidden><span>{g.symbol}</span></div><div className="game-card-meta">{g.meta}</div><h3>{g.title}</h3><p>{g.info}</p>
                  <button disabled={busy || !room.socket} onClick={() => void createGame(g.id)}>Create a {g.title} table <span aria-hidden>→</span></button></article>)}
              <article className="discovery-card lab-discovery"><div className="game-card-art" aria-hidden>✦</div><div className="game-card-meta">YOUR RULES · GAME LAB</div><h3>Make a game</h3><p>Describe the rules in plain language. Review, validate, and play the result with your friends.</p><Link className="button-link" to="/gamelab">Open Game Lab <span aria-hidden>→</span></Link></article>
            </div>
          </section>
        </main>
        <footer className="home-footer"><span>Game Night</span><span>Private rooms · Shareable links · No accounts</span><span><Link to="/privacy">Privacy</Link> · <Link to="/tos">Terms</Link></span></footer>
      </div>
    </div>
  );
}
