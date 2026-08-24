import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import type { RoomApi } from '../useRoom.js';
import { loadName } from '../session.js';

export default function HomePage({ room }: { room: RoomApi }) {
  const navigate = useNavigate();
  const [name, setName] = useState(loadName());
  const [code, setCode] = useState('');
  const [busy, setBusy] = useState(false);
  const [joinError, setJoinError] = useState<string | null>(null);

  const createGame = async () => {
    if (!room.socket) return;
    setBusy(true);
    setJoinError(null);
    const finalName = name.trim() || undefined;
    const rzToken = sessionStorage.getItem('rulezeroSpecToken') ?? undefined;
    sessionStorage.removeItem('rulezeroSpecToken');
    const res = await room.createRoom(finalName ?? 'Host', rzToken);
    setBusy(false);
    if (res.ok && res.roomId) navigate(`/game/${res.roomId}`);
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
    <div className="home-wrap">
      <div className="home-card">
        <a className="home-gamelab" href="/gamelab">🧪 Game Lab — create & simulate rule-defined games</a>

        <div className="home-deck" aria-hidden>
          <div className="mini-card mc1" />
          <div className="mini-card mc2" />
          <div className="mini-card mc3" />
        </div>
        <h1 className="font-display home-title">Game Night</h1>
        <p className="home-sub">
          Sit around a table with friends — play <strong>Cabo</strong> or{' '}
          <strong>Pair One</strong>. No accounts, just a link.
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
          <button onClick={createGame} disabled={!room.socket || busy}>
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
    </div>
  );
}