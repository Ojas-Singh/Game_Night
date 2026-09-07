import { useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import type { RoomApi } from '../useRoom.js';
import { loadName } from '../session.js';

export default function HomePage({ room }: { room: RoomApi }) {
  const navigate = useNavigate();
  const [name, setName] = useState(loadName());
  const [code, setCode] = useState('');
  const [busy, setBusy] = useState(false);
  const [joinError, setJoinError] = useState<string | null>(null);

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
    <div className="scroll-page">
      <div className="home-wrap">
      <div className="home-card">

        <div className="home-deck" aria-hidden>
          <div className="mini-card mc1" />
          <div className="mini-card mc2" />
          <div className="mini-card mc3" />
        </div>
        <h1 className="font-display home-title">Game Night</h1>
        <p className="home-sub">
          Sit around a table with friends — play <strong>Cabo</strong>, <strong>Seep</strong>, or a game of your own. No accounts, just a link.
        </p>
        <div className="home-form">
          <input
            type="text"
            placeholder="Your name"
            value={name}
            maxLength={24}
            onChange={(e) => setName(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && !busy && createGame()}
          />
          <button onClick={() => void createGame()} disabled={!room.socket || busy}>
            {busy ? 'Setting the table…' : 'Create Game'}
          </button>
        </div>
        <p className="home-hint">
          You'll get a shareable link. Send it to friends — they join instantly.
        </p>

        <div className="home-join-divider">
          <span>or join with a room code</span>
        </div>
        <div className="home-join">
          <input
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
          <button onClick={joinGame} disabled={!room.socket || busy || !code.trim()}>
            Join Room
          </button>
        </div>
        {joinError && <p className="home-join-error">{joinError}</p>}

        {room.status !== 'connected' && (
          <p className="home-status">Connecting to server…</p>
        )}
      </div>
      <section className="home-discovery" aria-label="Choose a game">
        <p className="eyebrow">YOUR NEXT GREAT GAME NIGHT</p><h2>A seat for everyone.</h2>
        <div className="discovery-grid">
          {[{ id: 'cabo', title: 'Cabo', info: '2–6 players · Memory & misdirection', symbol: '♦' },
            { id: 'seep', title: 'Seep', info: '4 players · Partners & strategy', symbol: '♠' },
            { id: 'pairone', title: 'Pair One', info: '2–6 players · Find your match', symbol: '♥' }].map(g =>
            <article className="discovery-card" key={g.id}><div className="game-card-art" aria-hidden>{g.symbol}</div><h3>{g.title}</h3><p>{g.info}</p>
              <button disabled={busy || !room.socket} onClick={() => void createGame(g.id)}>Create {g.title} table</button></article>)}
          <article className="discovery-card lab-discovery"><div className="game-card-art" aria-hidden>✦</div><h3>Game Lab</h3><p>Your rules. A new game. Ready to play.</p><Link className="button-link" to="/gamelab">Explore & create</Link></article>
        </div>
      </section>
      </div>
    </div>
  );
}