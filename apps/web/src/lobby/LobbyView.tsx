import { Link } from 'react-router-dom';
import { useEffect, useState } from 'react';
import { QRCodeSVG } from 'qrcode.react';
import type { RoomApi } from '../useRoom.js';
import ChatPanel from '../chat/ChatPanel.js';
import DebugPanel from '../DebugPanel.js';
import { loadName } from '../session.js';
import { funnel } from '../analytics.js';
import Avatar from '../table/Avatar.js';
import AvatarCam from '../table/AvatarCam.js';
import InfoModal from '../table/InfoModal.js';
import { seriesStandings, seriesWinner } from './series.js';
import { StylePanel } from './StylePanel.js';
import { loadAvatar, randomAvatar, saveAvatar } from '../avatar.js';
import { AVATAR_COLORS, EYE_STYLES, MOUTH_STYLES, HAT_STYLES } from '../avatar.js';
import type { Avatar as AvatarModel, RoomLobbyState } from '../server-protocol.js';
import type { MediaChat } from '../useMediaChat.js';

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

export default function LobbyView({ room, media }: { room: RoomApi; media: MediaChat }) {
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
  const [showQr, setShowQr] = useState(false);
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

  const inviteLink = `${window.location.origin}/game/${lobby.roomId}`;

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
    window.location.assign('/');
  };

  const startGame = async () => {
    setStarting(true);
    setStartError(null);
    const result = await room.startGame();
    setStarting(false);
    if (result.ok) funnel.gameStarted(lobby.gameId);
    else setStartError(result.error ?? 'Could not start the game');
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
              <button className="copy-invite-btn qr-invite-btn" onClick={() => setShowQr((v) => !v)} aria-expanded={showQr} title="Show the invite as a QR code">
                <span aria-hidden>▦</span>
                <span>QR</span>
              </button>
              <button className="copy-invite-btn" onClick={copyLink}>
                <Icon name={copied ? 'check' : 'copy'} />
                <span>{copied ? 'Copied' : 'Copy link'}</span>
              </button>
              {showQr && (
                <div className="qr-popover" role="dialog" aria-label="Invite QR code">
                  <QRCodeSVG value={inviteLink} size={148} level="M" />
                  <small>Scan to join this table</small>
                </div>
              )}
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
                    <AvatarCam media={media} playerId={p.id} myPlayerId={room.myPlayerId} avatar={p.avatar ?? { color: 0, eyes: 0, mouth: 0, hat: 0 }} size={42} ring={p.isYou} audio />
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
                      {/* Table talk lives right here next to the name — no
                          separate call box. */}
                      <TalkControls media={media} isYou={p.isYou} playerId={p.id} />
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
                  {p.ready && p.kind !== 'ai' && (
                    <span className="badge ready" title="Ready to play">✓ Ready</span>
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
                  {!isHost && !p.isYou && (
                    <button
                      className="report-btn"
                      title={`Report ${p.name} to the host`}
                      onClick={() => room.reportPlayer(p.id, 'reported from lobby')}
                    >
                      ⚑
                    </button>
                  )}
                </li>
              ))}
            </ul>
            <div className="lobby-count-row">
              <div className="lobby-count">
                {lobby.players.length} / 6 players
              </div>
              {!isHost && me && me.kind !== 'ai' && (
                <button
                  className={`ready-toggle ${me.ready ? 'on' : ''}`}
                  onClick={() => room.setReady(!me.ready)}
                  aria-pressed={me.ready}
                  title={me.ready ? 'You are ready to play' : 'Tap when you are ready to play'}
                >
                  {me.ready ? '✓ Ready' : 'Ready up'}
                </button>
              )}
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
              <GameTile
                id="seep"
                label="Seep"
                tagline="2v2 fishing — capture, build, sweep!"
                art={<span className="game-tile-art">♠</span>}
                selected={lobby.gameId === 'seep'}
                selectable={isHost}
                onSelect={() => isHost && room.selectGame('seep')}
                onInfo={() => setRulesGame('seep')}
              />
            </div>
            <SeriesPanel lobby={lobby} isHost={isHost} onSetTarget={(target) => room.setSeriesTarget(target)} />
            <StylePanel socket={room.socket} />
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
              <PickerRow
                label="Color"
                options={AVATAR_COLORS.map((_, i) => `Color ${i + 1}`)}
                sel={avatar.color}
                onPick={(i) => customize({ color: i })}
                renderCurrent={(_, i) => <span className="picker-color" style={{ background: AVATAR_COLORS[i] }} />}
              />
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
type GameId = 'cabo' | 'pairone' | 'seep';

const GAME_META: Record<GameId, { label: string }> = {
  cabo: { label: 'Cabo' },
  pairone: { label: 'Pair One' },
  seep: { label: 'Seep' },
};

const SERIES_GOALS: Array<number | null> = [null, 2, 3, 5, 7];

/**
 * "First to N wins" across rounds: the host picks the goal, everyone sees
 * live standings, and the series winner is celebrated until the goal changes.
 */
function SeriesPanel({
  lobby,
  isHost,
  onSetTarget,
}: {
  lobby: RoomLobbyState;
  isHost: boolean;
  onSetTarget: (target: number | null) => void;
}) {
  const target = lobby.seriesTarget ?? null;
  const winner = seriesWinner(lobby.scoreboard, target);
  const nameOf = (playerId: string): string =>
    lobby.players.find((p) => p.id === playerId)?.name ?? 'A player';
  const standings = seriesStandings(lobby.scoreboard, lobby.players).filter(
    (s) => s.wins > 0 || winner !== null,
  );
  return (
    <div className="series-panel">
      <div className="series-head">
        <span className="series-title">Series</span>
        {isHost ? (
          <div className="series-target-picker" role="group" aria-label="Series goal">
            {SERIES_GOALS.map((goal) => (
              <button
                key={String(goal)}
                className={`series-chip ${target === goal ? 'on' : ''}`}
                onClick={() => onSetTarget(goal)}
                aria-pressed={target === goal}
                title={goal === null ? 'No series goal — free play' : `First player to win ${goal} rounds`}
              >
                {goal === null ? 'Free play' : `To ${goal}`}
              </button>
            ))}
          </div>
        ) : (
          <span className="series-state">{target === null ? 'Free play' : `First to ${target}`}</span>
        )}
      </div>
      {winner && (
        <div className="series-winner" role="status">
          🏆 {nameOf(winner.playerId)} wins the series!
        </div>
      )}
      {standings.length > 0 && (
        <ol className="series-standings">
          {standings.map((s) => (
            <li key={s.playerId} className={winner?.playerId === s.playerId ? 'leading' : ''}>
              <span>{s.name}{s.isAi ? ' 🤖' : ''}</span>
              <strong>{s.wins}</strong>
            </li>
          ))}
        </ol>
      )}
    </div>
  );
}

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
  renderCurrent,
}: {
  label: string;
  options: readonly string[];
  sel: number;
  onPick: (i: number) => void;
  renderCurrent?: (option: string, index: number) => React.ReactNode;
}) {
  const index = options.length > 0 ? ((sel % options.length) + options.length) % options.length : 0;
  const current = options[index] ?? 'None';
  const previous = options.length > 0 ? (index - 1 + options.length) % options.length : 0;
  const next = options.length > 0 ? (index + 1) % options.length : 0;
  return (
    <div className="picker-row">
      <span className="picker-label">{label}</span>
      <div className="picker-options">
        <button
          type="button"
          className="picker-arrow"
          onClick={() => onPick(previous)}
          aria-label={`Previous ${label.toLowerCase()}`}
          title={`Previous ${label.toLowerCase()}`}
          disabled={options.length < 2}
        >
          ‹
        </button>
        <span className="picker-current" aria-live="polite">
          {renderCurrent ? renderCurrent(current, index) : current}
        </span>
        <button
          type="button"
          className="picker-arrow"
          onClick={() => onPick(next)}
          aria-label={`Next ${label.toLowerCase()}`}
          title={`Next ${label.toLowerCase()}`}
          disabled={options.length < 2}
        >
          ›
        </button>
      </div>
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

// ---------------------------------------------------------------------------
// Table talk, inline: my row gets mic/cam toggles next to my name; other
// rows show that player's live call state. The server never carries media —
// this is a thin UI over the peer-to-peer mesh.
// ---------------------------------------------------------------------------

function TalkControls({ media, isYou, playerId }: { media: MediaChat; isYou?: boolean; playerId: string }) {
  if (!media.supported) return null;

  if (!isYou) {
    const peer = media.peers.find((p) => p.playerId === playerId);
    if (!media.joined || !peer) return null;
    return (
      <span className="talk-status" aria-hidden>
        {peer.connection === 'failed' && <span className="talk-flag" title="Direct connection failed (NAT)">⚠</span>}
        {peer.speaking && <span className="talk-dot speaking" title="Speaking" />}
        {!peer.mic && <span className="talk-muted" title="Microphone off">🔇</span>}
      </span>
    );
  }

  const join = (cam: boolean): void => {
    void media.join({ mic: true, cam }).then((ok) => {
      if (!ok) return;
      funnel.voiceJoined();
      if (cam) funnel.cameraEnabled();
    });
  };

  return (
    <span className="talk-controls">
      {!media.joined ? (
        <>
          <button className="talk-btn" title="Join table talk (mic)" onClick={() => join(false)}>🎙️</button>
          <button className="talk-btn" title="Join with camera" onClick={() => join(true)}>📷</button>
        </>
      ) : (
        <>
          <button
            className={`talk-btn ${media.micOn ? 'on' : 'off'}`}
            title={media.micOn ? 'Mute your mic' : 'Unmute your mic'}
            aria-pressed={media.micOn}
            onClick={() => media.setMic(!media.micOn)}
          >
            {media.micOn ? '🎙️' : '🔇'}
          </button>
          <button
            className={`talk-btn ${media.camOn ? 'on' : 'off'}`}
            title={media.camOn ? 'Turn your camera off' : 'Turn your camera on'}
            aria-pressed={media.camOn}
            onClick={() => void media.setCam(!media.camOn).then((ok) => { if (ok && media.camOn) funnel.cameraEnabled(); })}
          >
            📷
          </button>
          <button className="talk-btn leave" title="Leave table talk" onClick={media.leave}>⏏</button>
        </>
      )}
      {media.joined && <span className="talk-dot live" title="Table talk live" />}
    </span>
  );
}
