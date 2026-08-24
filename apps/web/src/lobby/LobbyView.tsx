import { useEffect, useRef, useState } from 'react';
import type { RoomApi } from '../useRoom.js';
import ChatPanel from '../chat/ChatPanel.js';
import DebugPanel from '../DebugPanel.js';
import { loadName } from '../session.js';
import Avatar from '../table/Avatar.js';
import InfoModal from '../table/InfoModal.js';
import { loadAvatar, saveAvatar } from '../avatar.js';
import { AVATAR_COLORS, EYE_STYLES, MOUTH_STYLES, HAT_STYLES } from '../avatar.js';
import type { Avatar as AvatarModel } from '../server-protocol.js';

const AI_PERSONA_LABELS: Record<string, string> = {
  balanced: 'Balanced',
  baiter: 'Baiter',
  conservative: 'Conservative',
  aggressor: 'Aggressor',
  scholar: 'Scholar',
};

export default function LobbyView({ room }: { room: RoomApi }) {
  const lobby = room.lobby!;
  const [persona, setPersona] = useState('balanced');
  const me = lobby.players.find((p) => p.isYou);
  const isHost = me?.isHost ?? false;
  const [name, setName] = useState(me?.name ?? loadName());
  const [avatar, setAvatar] = useState<AvatarModel>(me?.avatar ?? loadAvatar());
  const [copied, setCopied] = useState(false);
  // Rules live on each game tile — tap a tile's ⓘ to read them. No auto-popup.
  const [rulesGame, setRulesGame] = useState<GameId | null>(null);

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
                  <span className="player-name">
                    {p.kind === 'ai' ? '🤖 ' : ''}
                    {p.name}
                  </span>
                  {p.kind === 'ai' && (
                    <span
                      className="badge ai"
                      title={`AI player — ${AI_PERSONA_LABELS[p.aiPersona ?? 'balanced'] ?? 'Balanced'} strategy`}
                    >
                      {AI_PERSONA_LABELS[p.aiPersona ?? 'balanced'] ?? 'AI'}
                    </span>
                  )}
                  {p.isHost && <span className="badge host">Host</span>}
                  {p.isYou && <span className="badge you">You</span>}
                  {!p.connected && <span className="badge dc">reconnecting…</span>}
                  {isHost && !p.isYou && !p.isHost && (
                    <button
                      className="kick-btn"
                      title={`Remove ${p.name} from the room`}
                      onClick={() => void room.kickPlayer(p.id)}
                    >
                      ✕
                    </button>
                  )}
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
              <GameTile
                id="cabo"
                label="Cabo"
                tagline="Bluff, peek & flush"
                art={<span className="game-tile-art">🂡</span>}
                selected={lobby.gameId === 'cabo'}
                selectable={isHost}
                onSelect={() => isHost && room.selectGame('cabo')}
                onInfo={() => setRulesGame('cabo')}
              />
              <GameTile
                id="pairone"
                label="Pair One"
                tagline="Memory — match the numbers"
                art={
                  <span className="tile-pair-art" aria-hidden>
                    <span className="tile-pair-back" />
                    <span className="tile-pair-face">7♥</span>
                  </span>
                }
                selected={lobby.gameId === 'pairone'}
                selectable={isHost}
                onSelect={() => isHost && room.selectGame('pairone')}
                onInfo={() => setRulesGame('pairone')}
              />
            </div>
            {isHost ? (
              <div className="host-controls">
                <div className="add-ai-row">
                  <label className="rule-label" htmlFor="ai-persona">
                    🤖 Add AI player
                  </label>
                  <select
                    id="ai-persona"
                    className="persona-select"
                    value={persona}
                    onChange={(e) => setPersona(e.target.value)}
                  >
                    {Object.entries(AI_PERSONA_LABELS).map(([id, label]) => (
                      <option key={id} value={id}>
                        {label}
                      </option>
                    ))}
                  </select>
                  <button
                    className="ghost add-ai-btn"
                    disabled={lobby.players.length >= 6}
                    title={lobby.players.length >= 6 ? 'Table is full' : 'Seat an AI opponent'}
                    onClick={() => void room.addAiPlayer(persona)}
                  >
                    + Seat AI
                  </button>
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
              <p className="waiting-host">
                Waiting for the host to start…
                {!isHost && (
                  <span className="waiting-game">
                    {' '}· {GAME_META[lobby.gameId as GameId]?.label ?? lobby.gameId}
                  </span>
                )}
              </p>
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
        <InfoModal
          open={rulesGame !== null}
          onClose={() => setRulesGame(null)}
          game={rulesGame ?? 'cabo'}
        />
        <button className="ghost rules-again" onClick={() => setRulesGame(lobby.gameId as GameId)}>
          📖 Show {GAME_META[lobby.gameId as GameId]?.label ?? 'game'} rules
        </button>
      </aside>
    </div>
  );
}

/** Platform games, for tile metadata. */
type GameId = 'cabo' | 'pairone';

const GAME_META: Record<GameId, { label: string }> = {
  cabo: { label: 'Cabo' },
  pairone: { label: 'Pair One' },
};

/**
 * A game tile in the lobby: the host taps it to pick the game; anyone can tap
 * the ⓘ corner to read that game's rules before sitting down.
 */
function GameTile({
  id,
  label,
  tagline,
  art,
  selected,
  selectable,
  onSelect,
  onInfo,
}: {
  id: GameId;
  label: string;
  tagline: string;
  art: React.ReactNode;
  selected: boolean;
  selectable: boolean;
  onSelect: () => void;
  onInfo: () => void;
}) {
  return (
    <div className={`game-tile ${selected ? 'selected' : ''}`}>
      <button
        className="game-tile-hit"
        onClick={selectable ? onSelect : undefined}
        disabled={!selectable}
        title={
          selectable
            ? `${label} — ${tagline}. Tap to select this game`
            : `${label} — ${tagline} (only the host can change the game)`
        }
        aria-pressed={selected}
      >
        {art}
        <span className="game-tile-name">{label}</span>
        <span className="game-tile-tagline">{tagline}</span>
        {!selectable && selected && <span className="game-tile-chosen">chosen</span>}
      </button>
      <button
        className="game-tile-info"
        onClick={(e) => {
          e.stopPropagation();
          onInfo();
        }}
        aria-label={`How to play ${label}`}
        title={`How to play ${label}`}
      >
        ⓘ
      </button>
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
