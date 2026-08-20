import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import type { RoomApi } from '../useRoom.js';
import { loadName } from '../session.js';

export default function HomePage({ room }: { room: RoomApi }) {
  const navigate = useNavigate();
  const [name, setName] = useState(loadName());
  const [busy, setBusy] = useState(false);

  const createGame = async () => {
    if (!room.socket) return;
    setBusy(true);
    const finalName = name.trim() || undefined;
    const res = await room.createRoom(finalName ?? 'Host');
    setBusy(false);
    if (res.ok && res.roomId) navigate(`/game/${res.roomId}`);
  };

  return (
    <div className="home-wrap">
      <div className="home-card">
        <div className="home-deck" aria-hidden>
          <div className="mini-card mc1" />
          <div className="mini-card mc2" />
          <div className="mini-card mc3" />
        </div>
        <h1 className="font-display home-title">Game Night</h1>
        <p className="home-sub">
          Sit around a table with friends and play <strong>Cabo</strong> — no accounts, just a link.
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
        {room.status !== 'connected' && (
          <p className="home-status">Connecting to server…</p>
        )}
      </div>
    </div>
  );
}
