import { useEffect, useRef, useState } from 'react';
import type { RoomApi } from '../useRoom.js';
import ChatPanel from '../chat/ChatPanel.js';
import DebugPanel from '../DebugPanel.js';
import { loadName } from '../session.js';
import Avatar from '../table/Avatar.js';
import { loadAvatar, saveAvatar } from '../avatar.js';
import { AVATAR_COLORS, EYE_STYLES, MOUTH_STYLES, HAT_STYLES } from '../avatar.js';
import type { Avatar as AvatarModel } from '../server-protocol.js';

export default function LobbyView({ room }: { room: RoomApi }) {
  const lobby = room.lobby!;
  const me = lobby.players.find((p) => p.isYou);
  const isHost = me?.isHost ?? false;
  const [name, setName] = useState(me?.name ?? loadName());
  const [avatar, setAvatar] = useState<AvatarModel>(me?.avatar ?? loadAvatar());
  const [copied, setCopied] = useState(false);

  const customize = (patch: Partial<AvatarModel>) => {
    const next = { ...avatar, ...patch };
    setAvatar(next);
    saveAvatar(next);
    room.setAvatar(next);
  };
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
            <button
              className="ghost"
              onClick={() => {
                room.leaveRoom();
                window.location.hash = '#/';
              }}
              title="Leave this room and start fresh"
            >
              🏠 Leave room
            </button>
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
                  <Avatar avatar={p.avatar ?? { color: 0, eyes: 0, mouth: 0, hat: 0 }} size={38} />
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
                <div className="house-rule-row">
                  <label className="rule-label" title="When a player discards a 5 or 6, they swap two of their opponents' cards">
                    <input
                      type="checkbox"
                      checked={lobby.swapOthersEnabled}
                      onChange={(e) => room.setSwapOthers(e.target.checked)}
                    />
                    <span>5–6 swap rule</span>
                  </label>
                </div>
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
        <DebugPanel room={room} />
        <div className="lobby-panel avatar-panel">
          <h2 className="lobby-section-title">Your avatar</h2>
          <div className="avatar-editor">
            <Avatar avatar={avatar} size={84} ring />
            <div className="avatar-options">
              <div className="swatch-row">
                {AVATAR_COLORS.map((hex, i) => (
                  <button
                    key={hex}
                    className={`swatch ${avatar.color === i ? 'sel' : ''}`}
                    style={{ background: hex }}
                    onClick={() => customize({ color: i })}
                    aria-label={`Color ${i + 1}`}
                  />
                ))}
              </div>
              <PickerRow label="Eyes" options={EYE_STYLES} sel={avatar.eyes} onPick={(i) => customize({ eyes: i })} />
              <PickerRow label="Mouth" options={MOUTH_STYLES} sel={avatar.mouth} onPick={(i) => customize({ mouth: i })} />
              <PickerRow label="Hat" options={HAT_STYLES} sel={avatar.hat} onPick={(i) => customize({ hat: i })} />
            </div>
          </div>
        </div>
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


function PickerRow({
  label,
  options,
  sel,
  onPick,
}: {
  label: string;
  options: readonly string[];
  sel: number;
  onPick: (i: number) => void;
}) {
  return (
    <div className="picker-row">
      <span className="picker-label">{label}</span>
      {options.map((opt, i) => (
        <button
          key={opt}
          className={`picker-opt ${sel === i ? 'sel' : ''}`}
          onClick={() => onPick(i)}
          title={opt}
        >
          {opt}
        </button>
      ))}
    </div>
  );
}
