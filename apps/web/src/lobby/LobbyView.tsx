import { useEffect, useRef, useState } from 'react';
import type { RoomApi } from '../useRoom.js';
import ChatPanel from '../chat/ChatPanel.js';
import { loadName } from '../session.js';

export default function LobbyView({ room }: { room: RoomApi }) {
  const lobby = room.lobby!;
  const me = lobby.players.find((p) => p.isYou);
  const isHost = me?.isHost ?? false;
  const [name, setName] = useState(me?.name ?? loadName());
  const [copied, setCopied] = useState(false);
  const nameRef = useRef(name);

  useEffect(() => {
    nameRef.current = me?.name ?? nameRef.current;
  }, [me?.name]);

  const inviteLink = `${window.location.origin}${window.location.pathname}#/game/${lobby.roomId}`;

  const copyLink = async () => {
    try {
      await navigator.clipboard.writeText(inviteLink);
    } catch {
      const el = document.createElement('textarea');
      el.value = inviteLink;
      document.body.appendChild(el);
      el.select();
      document.execCommand('copy');
      el.remove();
    }
    setCopied(true);
    setTimeout(() => setCopied(false), 1600);
  };

  const canStart = lobby.players.filter((p) => p.connected).length >= 2;

  return (
    <div className="lobby-wrap">
      <div className="lobby-main">
        <header className="lobby-head">
          <h1 className="font-display lobby-title">
            Room <span className="room-code">{lobby.roomId}</span>
          </h1>
          <div className="invite-row">
            <button className="ghost" onClick={copyLink}>
              {copied ? '✓ Copied!' : '🔗 Copy invite link'}
            </button>
            <span className="room-url">{inviteLink}</span>
          </div>
        </header>

        <div className="lobby-body">
          <section className="lobby-panel players-panel">
            <h2 className="lobby-section-title">At the table</h2>
            <ul className="player-list">
              {lobby.players.map((p) => (
                <li key={p.id} className={`player-row ${p.connected ? '' : 'disconnected'}`}>
                  <span className="avatar-bubble">{initials(p.name)}</span>
                  <span className="player-name">{p.name}</span>
                  {p.isHost && <span className="badge host">Host</span>}
                  {p.isYou && <span className="badge you">You</span>}
                  {!p.connected && <span className="badge dc">reconnecting…</span>}
                </li>
              ))}
            </ul>
            <div className="lobby-count">
              {lobby.players.length} / 6 players
            </div>
          </section>

          <section className="lobby-panel game-panel">
            <h2 className="lobby-section-title">Game</h2>
            <div className="game-selector">
              <button
                className={`game-tile selected`}
                title="Cabo — the house-rules classic"
              >
                <span className="game-tile-art">🂡</span>
                <span className="game-tile-name">Cabo</span>
              </button>
              <div className="game-tile soon" title="Coming soon">
                <span className="game-tile-art">?</span>
                <span className="game-tile-name">More soon</span>
              </div>
            </div>
            {isHost ? (
              <div className="host-controls">
                <button
                  className="start-btn"
                  disabled={!canStart}
                  onClick={() => void room.startGame()}
                  title={canStart ? 'Deal everyone in' : 'Need at least 2 players'}
                >
                  Start Game
                </button>
              </div>
            ) : (
              <p className="waiting-host">Waiting for the host to start…</p>
            )}
          </section>
        </div>
      </div>

      <aside className="lobby-side">
        <div className="lobby-panel name-panel">
          <h2 className="lobby-section-title">Your name</h2>
          <div className="name-row">
            <input
              type="text"
              value={name}
              maxLength={24}
              onChange={(e) => setName(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && name.trim()) room.setName(name.trim());
              }}
              onBlur={() => {
                if (name.trim() && name.trim() !== nameRef.current) room.setName(name.trim());
              }}
              placeholder="Your name"
            />
          </div>
        </div>
        <ChatPanel room={room} expanded />
      </aside>
    </div>
  );
}

function initials(name: string): string {
  return name
    .split(' ')
    .map((w) => w[0])
    .filter(Boolean)
    .slice(0, 2)
    .join('')
    .toUpperCase();
}
