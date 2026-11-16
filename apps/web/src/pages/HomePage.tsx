import { useEffect, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import type { RoomApi } from '../useRoom.js';
import { loadName } from '../session.js';
import { funnel } from '../analytics.js';
import GardenScene from '../scene/GardenScene.js';
import FullscreenButton from '../FullscreenButton.js';
import { openStudio, uploadAsset } from '../studio/client.js';
import { makePage } from '../studio/pictures.js';
import { MODE_INFO } from '../studio/SetupPanel.js';
import type { StudioMode, StudioSetup } from '@game-night/shared';

type Mode = 'create' | 'draw' | 'join';

/**
 * The front door: one quiet, full-height scene. No catalogue, no marketing
 * sections — just the two things a visitor can do (start a table or slip into
 * one) and enough atmosphere to make it feel like a room rather than a form.
 */
export default function HomePage({ room }: { room: RoomApi }) {
  const navigate = useNavigate();
  const [name, setName] = useState(loadName());
  const [code, setCode] = useState('');
  const [mode, setMode] = useState<Mode>('create');
  const [drawMode, setDrawMode] = useState<StudioMode>('together');
  const [busy, setBusy] = useState(false);
  const [joinError, setJoinError] = useState<string | null>(null);

  useEffect(() => { funnel.homeView(); }, []);

  const createGame = async () => {
    if (!room.socket) return;
    setBusy(true);
    setJoinError(null);
    const finalName = name.trim() || undefined;
    const res = await room.createRoom(finalName ?? 'Host');
    setBusy(false);
    if (res.ok && res.roomId) { room.selectGame('cabo'); navigate(`/game/${res.roomId}`); }
  };

  /** Make a room and walk straight into its studio. */
  const createCanvas = async () => {
    if (!room.socket) return;
    setBusy(true);
    setJoinError(null);
    try {
      sessionStorage.setItem('gn:intent', 'draw');
    } catch { /* private mode */ }
    const res = await room.createRoom(name.trim() || 'Host');
    if (!res.ok || !res.roomId) {
      setBusy(false);
      setJoinError(res.error ?? 'could not make a room');
      return;
    }
    const setup: StudioSetup = { mode: drawMode };
    if (drawMode !== 'together') {
      // A page to colour straight away; the host can swap it in the studio.
      try {
        const page = await makePage('mandala', (Math.random() * 1e9) | 0);
        const asset = await uploadAsset(res.roomId, page.blob);
        setup.image = { asset, width: page.width, height: page.height, placement: 'lines', opacity: 1 };
      } catch { /* open without a picture */ }
    }
    await openStudio(room.socket, setup);
    setBusy(false);
    navigate(`/game/${res.roomId}`);
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
    else setJoinError(res.error ?? 'that room slipped away — check the code');
  };

  const switchMode = (next: Mode) => {
    setMode(next);
    setJoinError(null);
  };

  const submit = () => {
    if (busy) return;
    if (mode === 'create') void createGame();
    else if (mode === 'draw') void createCanvas();
    else void joinGame();
  };

  const canSubmit = Boolean(room.socket) && !busy && (mode !== 'join' || code.trim().length > 0);

  return (
    <div className="home-page">
      <GardenScene variant="home" />
      <div className="home-backdrop" aria-hidden>
        <span className="home-spot" />
        <span className="home-card-ghost a">?</span>
        <span className="home-card-ghost b">?</span>
        <span className="home-card-ghost c">?</span>
        <svg className="home-stroke-ghost" viewBox="0 0 220 120" aria-hidden>
          <path d="M10 90c30-60 60 20 90-30s55 10 110-40" />
        </svg>
      </div>

      <header className="home-nav">
        <Link to="/" className="home-brand" aria-label="Game Night home">
          <span className="home-brand-mark" aria-hidden>✦</span>
          <span className="home-brand-text"><strong>Game Night</strong><small>cards &amp; canvases with friends</small></span>
        </Link>
        <span className="home-nav-right">
          <FullscreenButton />
        </span>
      </header>

      <main className="home-scene">
        <p className="home-eyebrow">Somewhere, past the garden wall</p>
        <h1 className="home-title font-display">Pull up a stool.<br /><em>Deal the cards, or pass the brushes.</em></h1>
        <p className="home-whisper">No accounts, no downloads. Bluff your way through Cabo, Seep and Pair One — or paint one picture together, pen tablet and all.</p>

        <section className="home-door" aria-label="Start or join a table">
          <div className="home-tabs" role="tablist" aria-label="Start or join a table">
            <button
              type="button"
              role="tab"
              id="home-tab-create"
              aria-selected={mode === 'create'}
              aria-controls="home-door-panel"
              className={mode === 'create' ? 'on' : ''}
              onClick={() => switchMode('create')}
            >
              Play cards
            </button>
            <button
              type="button"
              role="tab"
              id="home-tab-draw"
              aria-selected={mode === 'draw'}
              aria-controls="home-door-panel"
              className={mode === 'draw' ? 'on' : ''}
              onClick={() => switchMode('draw')}
            >
              Draw together
            </button>
            <button
              type="button"
              role="tab"
              id="home-tab-join"
              aria-selected={mode === 'join'}
              aria-controls="home-door-panel"
              className={mode === 'join' ? 'on' : ''}
              onClick={() => switchMode('join')}
            >
              Join a room
            </button>
          </div>

          <div
            className="home-door-panel"
            id="home-door-panel"
            role="tabpanel"
            aria-labelledby={`home-tab-${mode}`}
          >
            <label className="field">
              <span className="sr-only">Your name</span>
              <input
                id="home-name"
                type="text"
                placeholder="Your name"
                value={name}
                maxLength={24}
                autoComplete="nickname"
                onChange={(e) => setName(e.target.value)}
                onKeyDown={(e) => e.key === 'Enter' && submit()}
              />
            </label>

            {mode === 'draw' && (
              <div className="home-draw-modes" role="radiogroup" aria-label="How to draw">
                {(Object.keys(MODE_INFO) as StudioMode[]).map((m) => (
                  <button
                    key={m}
                    type="button"
                    role="radio"
                    aria-checked={drawMode === m}
                    className={drawMode === m ? 'on' : ''}
                    onClick={() => setDrawMode(m)}
                    title={MODE_INFO[m].blurb}
                  >
                    {MODE_INFO[m].short}
                  </button>
                ))}
              </div>
            )}

            {mode === 'join' && (
              <label className="field">
                <span className="sr-only">Room code</span>
                <input
                  id="home-code"
                  type="text"
                  placeholder="ROOM CODE"
                  value={code}
                  maxLength={6}
                  autoCapitalize="characters"
                  autoCorrect="off"
                  spellCheck={false}
                  className="join-code"
                  onChange={(e) => setCode(e.target.value.toUpperCase())}
                  onKeyDown={(e) => e.key === 'Enter' && submit()}
                />
              </label>
            )}

            <button className="home-enter" onClick={submit} disabled={!canSubmit}>
              {mode === 'create'
                ? busy ? 'Lighting the lamp…' : 'Deal me in'
                : mode === 'draw'
                  ? busy ? 'Laying out the paper…' : 'Open a canvas'
                  : busy ? 'Finding the room…' : 'Enter the room'}
            </button>
          </div>

          <p className="home-hint">
            {mode === 'create'
              ? 'You’ll get a link. Friends slip in without an account.'
              : mode === 'draw'
                ? MODE_INFO[drawMode].blurb + ' Share the link to invite.'
                : 'Six characters, straight from your host.'}
          </p>
          {joinError && <p className="home-join-error" role="alert">{joinError}</p>}
          {room.status !== 'connected' && <p className="home-status" role="status">Connecting to the table…</p>}
        </section>
      </main>

      <footer className="home-foot">
        <span>Private rooms · shareable links</span>
        <span><Link to="/privacy">Privacy</Link> · <Link to="/tos">Terms</Link></span>
      </footer>
    </div>
  );
}
