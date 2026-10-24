import { useEffect, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import type { RoomApi } from '../useRoom.js';
import { loadName } from '../session.js';
import { funnel } from '../analytics.js';
import GardenScene from '../scene/GardenScene.js';

type Mode = 'create' | 'join';

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
  const [busy, setBusy] = useState(false);
  const [joinError, setJoinError] = useState<string | null>(null);

  useEffect(() => { funnel.homeView(); }, []);

  const createGame = async () => {
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
    if (res.ok && res.roomId) { if (!rzToken) room.selectGame('cabo'); navigate(`/game/${res.roomId}`); }
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
    else void joinGame();
  };

  const canSubmit = Boolean(room.socket) && !busy && (mode === 'create' || code.trim().length > 0);

  return (
    <div className="home-page">
      <GardenScene variant="home" />
      <div className="home-backdrop" aria-hidden>
        <span className="home-spot" />
        <span className="home-card-ghost a">?</span>
        <span className="home-card-ghost b">?</span>
        <span className="home-card-ghost c">?</span>
      </div>

      <header className="home-nav">
        <Link to="/" className="home-brand" aria-label="Game Night home">
          <span className="home-brand-mark" aria-hidden>✦</span>
          <span className="home-brand-text"><strong>Game Night</strong><small>one table · every game</small></span>
        </Link>
        <Link to="/gamelab" className="home-lab">Game Lab</Link>
      </header>

      <main className="home-scene">
        <p className="home-eyebrow">Somewhere, past the garden wall</p>
        <h1 className="home-title font-display">Pull up a stool.<br /><em>The lantern’s lit, the cards are dealt.</em></h1>
        <p className="home-whisper">No accounts, no downloads. Just a name, a few friends, and a hunch about who’s bluffing.</p>

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
              Start a table
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
            aria-labelledby={mode === 'create' ? 'home-tab-create' : 'home-tab-join'}
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
                : busy ? 'Finding the room…' : 'Enter the room'}
            </button>
          </div>

          <p className="home-hint">
            {mode === 'create'
              ? 'You’ll get a link. Friends slip in without an account.'
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
