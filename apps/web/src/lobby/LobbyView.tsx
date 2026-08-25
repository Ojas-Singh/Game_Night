import { Link } from 'react-router-dom';
import { useEffect, useState } from 'react';
import type { RoomApi } from '../useRoom.js';
import ChatPanel from '../chat/ChatPanel.js';
import DebugPanel from '../DebugPanel.js';
import { loadName } from '../session.js';
import Avatar from '../table/Avatar.js';
import InfoModal from '../table/InfoModal.js';
import { loadAvatar, randomAvatar, saveAvatar } from '../avatar.js';
import { AVATAR_COLORS, EYE_STYLES, MOUTH_STYLES, HAT_STYLES } from '../avatar.js';
import type { Avatar as AvatarModel } from '../server-protocol.js';

const AI_PERSONA_LABELS: Record<string, string> = {
  balanced: 'Balanced',
  baiter: 'Baiter',
  conservative: 'Conservative',
  aggressor: 'Aggressor',
  scholar: 'Scholar',
};

const AI_PERSONA_OPTIONS = [
  { id: 'balanced', label: 'Balanced', description: 'Adapts to the table and takes solid value lines.' },
  { id: 'scholar', label: 'Scholar', description: 'Tracks information carefully and plays the odds.' },
  { id: 'conservative', label: 'Conservative', description: 'Protects a low score and avoids wild guesses.' },
  { id: 'aggressor', label: 'Aggressor', description: 'Pressures opponents and attacks every opening.' },
  { id: 'baiter', label: 'Baiter', description: 'Sets traps with discards and deceptive plays.' },
] as const;

export default function LobbyView({ room }: { room: RoomApi }) {
  const lobby = room.lobby!;
  const me = lobby.players.find((p) => p.isYou);
  const isHost = me?.isHost ?? false;
  const [nameDraft, setNameDraft] = useState(me?.name ?? loadName());
  const [editingName, setEditingName] = useState(false);
  const [avatar, setAvatar] = useState<AvatarModel>(me?.avatar ?? loadAvatar());
  const [copied, setCopied] = useState(false);
  const [aiMenuOpen, setAiMenuOpen] = useState(false);
  const [addingPersona, setAddingPersona] = useState<string | null>(null);
  const [confirmLeave, setConfirmLeave] = useState(false);
  const [starting, setStarting] = useState(false);
  const [startError, setStartError] = useState<string | null>(null);
  // Rules live on each game tile — tap a tile's ⓘ to read them. No auto-popup.
  const [rulesGame, setRulesGame] = useState<GameId | null>(null);

  const customize = (patch: Partial<AvatarModel>) => {
    const next = { ...avatar, ...patch };
    setAvatar(next);
    saveAvatar(next);
    room.setAvatar(next);
  };
  useEffect(() => {
    if (!editingName) setNameDraft(me?.name ?? loadName());
  }, [editingName, me?.name]);

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

  const commitName = () => {
    const clean = nameDraft.trim();
    if (clean && clean !== me?.name) room.setName(clean);
    setEditingName(false);
  };

  const surpriseMe = () => {
    const next = randomAvatar();
    setAvatar(next);
    saveAvatar(next);
    room.setAvatar(next);
  };

  const addAi = async (selectedPersona: string) => {
    setAddingPersona(selectedPersona);
    const result = await room.addAiPlayer(selectedPersona);
    setAddingPersona(null);
    if (result.ok) setAiMenuOpen(false);
  };

  const leaveRoom = () => {
    room.leaveRoom();
    window.location.hash = '#/';
  };

  const startGame = async () => {
    setStarting(true);
    setStartError(null);
    const result = await room.startGame();
    setStarting(false);
    if (!result.ok) setStartError(result.error ?? 'Could not start the game');
  };

  const canStart = lobby.players.filter((p) => p.connected).length >= 2 && !lobby.inGame;

  return (
    <div className="lobby-wrap">
      <div className="lobby-main">
        <header className="lobby-head">
          <h1 className="font-display lobby-title">
            Room <span className="room-code">{lobby.roomId}</span>
          </h1>
          <div className="invite-row">
            {confirmLeave ? (
              <div className="leave-confirm" role="alertdialog" aria-label="Leave room confirmation">
                <span>Leave this table?</span>
                <button className="leave-confirm-yes" onClick={leaveRoom}>
                  <Icon name="logout" /> Leave
                </button>
                <button className="icon-btn" onClick={() => setConfirmLeave(false)} aria-label="Stay in room" title="Stay in room">
                  <Icon name="close" />
                </button>
              </div>
            ) : (
              <button
                className="lobby-action leave-action"
                onClick={() => setConfirmLeave(true)}
                title="Leave this room and return home"
              >
                <Icon name="logout" />
                <span>Leave room</span>
              </button>
            )}
            <div className="invite-card">
              <span className="invite-card-icon"><Icon name="link" /></span>
              <span className="invite-card-copy">
                <strong>Invite friends</strong>
                <span className="room-url">{inviteLink}</span>
              </span>
              <button className="copy-invite-btn" onClick={copyLink}>
                <Icon name={copied ? 'check' : 'copy'} />
                <span>{copied ? 'Copied' : 'Copy link'}</span>
              </button>
            </div>
          </div>
        </header>

        <div className="lobby-body">
          <section className="lobby-panel players-panel">
            <div className="section-heading-row">
              <div>
                <h2 className="lobby-section-title">At the table</h2>
                <p className="section-kicker">Choose your look and make a seat.</p>
              </div>
              {isHost && (
                <div className="ai-seat-control">
                  <button
                    className="add-seat-btn"
                    onClick={() => setAiMenuOpen((open) => !open)}
                    disabled={lobby.players.length >= 6}
                    aria-expanded={aiMenuOpen}
                    aria-haspopup="menu"
                    title={lobby.players.length >= 6 ? 'Table is full' : 'Add an AI player'}
                  >
                    <Icon name="plus" />
                    <span>AI seat</span>
                  </button>
                  {aiMenuOpen && lobby.players.length < 6 && (
                    <div className="ai-menu" role="menu">
                      <div className="ai-menu-title">Choose an opponent</div>
                      {AI_PERSONA_OPTIONS.map((option) => (
                        <button
                          key={option.id}
                          className="ai-option"
                          role="menuitem"
                          disabled={addingPersona !== null}
                          onClick={() => void addAi(option.id)}
                        >
                          <span className="ai-option-icon"><Icon name="bot" /></span>
                          <span className="ai-option-copy">
                            <strong>{option.label}</strong>
                            <small>{option.description}</small>
                          </span>
                          {addingPersona === option.id && <span className="ai-option-loading">…</span>}
                        </button>
                      ))}
                    </div>
                  )}
                </div>
              )}
            </div>
            <ul className="player-list">
              {lobby.players.map((p) => (
                <li key={p.id} className={`player-row ${p.connected ? '' : 'disconnected'} ${p.isYou ? 'is-you' : ''}`}>
                  <div className="player-avatar-wrap">
                    <Avatar avatar={p.avatar ?? { color: 0, eyes: 0, mouth: 0, hat: 0 }} size={42} ring={p.isYou} />
                    {p.kind === 'ai' && <span className="player-ai-mark" title="AI player"><Icon name="bot" /></span>}
                  </div>
                  <div className="player-identity">
                    <div className="player-name-line">
                      {p.isYou && editingName ? (
                        <input
                          className="inline-name-input"
                          value={nameDraft}
                          maxLength={24}
                          autoFocus
                          onChange={(e) => setNameDraft(e.target.value)}
                          onKeyDown={(e) => {
                            if (e.key === 'Enter') commitName();
                            if (e.key === 'Escape') {
                              setNameDraft(p.name);
                              setEditingName(false);
                            }
                          }}
                          onBlur={commitName}
                          aria-label="Edit your name"
                        />
                      ) : (
                        <span className="player-name">{p.name}</span>
                      )}
                      {p.isYou && !editingName && (
                        <button className="name-edit-btn" onClick={() => setEditingName(true)} aria-label="Edit your name" title="Edit your name">
                          <Icon name="pencil" />
                        </button>
                      )}
                    </div>
                    <span className="player-subtitle">
                      {p.kind === 'ai'
                        ? `${AI_PERSONA_LABELS[p.aiPersona ?? 'balanced'] ?? 'Balanced'} strategy`
                        : p.isYou ? 'That’s you' : p.connected ? 'Ready to play' : 'Reconnecting…'}
                    </span>
                  </div>
                  {p.kind === 'ai' && (
                    <span
                      className="badge ai"
                      title={`AI player — ${AI_PERSONA_LABELS[p.aiPersona ?? 'balanced'] ?? 'Balanced'} strategy`}
                    >
                      AI
                    </span>
                  )}
                  {p.isHost && <span className="badge host">Host</span>}
                  {p.isYou && <span className="badge you">You</span>}
                  {isHost && !p.isYou && !p.isHost && (
                    <button
                      className="kick-btn"
                      title={`Remove ${p.name} from the room`}
                      onClick={() => void room.kickPlayer(p.id)}
                    >
                      <Icon name="close" />
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
                <Link className="ghost gamelab-host-link" to="/gamelab" title="Open the RuleZero Game Lab">
                  🧪 Game Lab
                </Link>
                <button
                  className="start-btn"
                  disabled={!canStart || starting}
                  onClick={() => void startGame()}
                  title={canStart ? 'Deal everyone in' : 'Need at least 2 players'}
                >
                  {starting ? 'Dealing…' : 'Start Game'}
                </button>
                {startError && <p className="lobby-action-error">{startError}</p>}
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
          <div className="avatar-panel-head">
            <div>
              <h2 className="lobby-section-title">Your look</h2>
              <p className="section-kicker">Make a table personality.</p>
            </div>
            <button className="shuffle-look" onClick={surpriseMe} title="Randomize your avatar">
              <Icon name="shuffle" />
              <span>Surprise me</span>
            </button>
          </div>
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
                    aria-pressed={avatar.color === i}
                    title={`Color ${i + 1}`}
                  />
                ))}
              </div>
              <PickerRow label="Eyes" options={EYE_STYLES} sel={avatar.eyes} onPick={(i) => customize({ eyes: i })} />
              <PickerRow label="Mouth" options={MOUTH_STYLES} sel={avatar.mouth} onPick={(i) => customize({ mouth: i })} />
              <PickerRow label="Hat" options={HAT_STYLES} sel={avatar.hat} onPick={(i) => customize({ hat: i })} />
            </div>
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
          aria-pressed={sel === i}
        >
          {opt}
        </button>
      ))}
    </div>
  );
}

type IconName = 'bot' | 'check' | 'close' | 'copy' | 'link' | 'logout' | 'pencil' | 'plus' | 'shuffle';

function Icon({ name }: { name: IconName }) {
  const common = {
    width: 17,
    height: 17,
    viewBox: '0 0 24 24',
    fill: 'none',
    stroke: 'currentColor',
    strokeWidth: 1.9,
    strokeLinecap: 'round' as const,
    strokeLinejoin: 'round' as const,
    'aria-hidden': true,
  };
  switch (name) {
    case 'bot':
      return <svg {...common}><rect x="4" y="7" width="16" height="12" rx="3" /><path d="M12 4v3M8 12h.01M16 12h.01M8 16h8" /></svg>;
    case 'check':
      return <svg {...common}><path d="m5 12 4 4L19 6" /></svg>;
    case 'close':
      return <svg {...common}><path d="m6 6 12 12M18 6 6 18" /></svg>;
    case 'copy':
      return <svg {...common}><rect x="8" y="8" width="11" height="11" rx="2" /><path d="M16 8V6a2 2 0 0 0-2-2H6a2 2 0 0 0-2 2v8a2 2 0 0 0 2 2h2" /></svg>;
    case 'link':
      return <svg {...common}><path d="M10 13.5 14 10m-7.5 7.5-1 1a3.5 3.5 0 0 1-5-5l3-3a3.5 3.5 0 0 1 5 0m2-4 1-1a3.5 3.5 0 0 1 5 5l-3 3a3.5 3.5 0 0 1-5 0" /></svg>;
    case 'logout':
      return <svg {...common}><path d="M10 5H6a2 2 0 0 0-2 2v10a2 2 0 0 0 2 2h4M14 8l4 4-4 4M9 12h9" /></svg>;
    case 'pencil':
      return <svg {...common}><path d="m4 16-.8 4.8L8 20l10.8-10.8a2.8 2.8 0 0 0-4-4L4 16Z" /><path d="m13.5 6.5 4 4" /></svg>;
    case 'plus':
      return <svg {...common}><path d="M12 5v14M5 12h14" /></svg>;
    case 'shuffle':
      return <svg {...common}><path d="M16 3h5v5M4 7h2c4 0 5 10 10 10h5M16 21h5v-5M4 17h2c1.4 0 2.4-.8 3.2-1.8M14.8 8.8C15.6 7.8 16.6 7 18 7h3" /></svg>;
  }
}
