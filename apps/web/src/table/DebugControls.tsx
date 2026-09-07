import { useState } from 'react';
import type { RoomApi } from '../useRoom.js';
import type { AiThought } from '../server-protocol.js';

/** Host-only controls for inspecting a live table without changing normal play. */
export default function DebugControls({ room }: { room: RoomApi }) {
  const [open, setOpen] = useState(false);
  const isHost = room.lobby?.hostId === room.myPlayerId;
  if (!isHost) return null;
  const thoughts = room.lobby?.aiThoughts ?? [];
  const hasAi = room.lobby?.players.some((player) => player.kind === 'ai') ?? false;

  return (
    <>
      <button
        className={`debug-toggle ${room.testMode || room.lobby?.aiDebug ? 'on' : ''}`}
        onClick={() => setOpen((value) => !value)}
        aria-expanded={open}
        aria-haspopup="dialog"
        aria-label="Open debug controls"
        title="Debug controls"
      >
        DEBUG
      </button>
      {open && (
        <aside className="debug-menu" role="dialog" aria-label="Debug controls">
          <div className="debug-menu-head">
            <div><strong>Table debug</strong><small>Host only · never shown to guests</small></div>
            <button className="debug-menu-close" onClick={() => setOpen(false)} aria-label="Close debug controls">×</button>
          </div>
          <label className="debug-option">
            <input type="checkbox" checked={room.testMode} onChange={(event) => room.setTestMode(event.target.checked)} />
            <span><strong>Reveal every card</strong><small>Test Mode shows hidden cards to this table.</small></span>
          </label>
          <label className="debug-option">
            <input type="checkbox" checked={!!room.lobby?.aiDebug} onChange={(event) => room.setAiDebug(event.target.checked)} />
            <span><strong>Show AI reasoning</strong><small>Stream each AI’s latest thought and selected move.</small></span>
          </label>
          <div className="debug-trace-head"><span>AI activity</span><span>{thoughts.length ? `${thoughts.length} entries` : 'waiting'}</span></div>
          {!hasAi && <p className="debug-empty">Add an AI seat to see its decisions here.</p>}
          {hasAi && !room.lobby?.aiDebug && <p className="debug-empty">Turn on AI reasoning, then start or continue the table.</p>}
          {room.lobby?.aiDebug && thoughts.length > 0 && (
            <ol className="debug-traces" aria-live="polite">
              {thoughts.slice().reverse().slice(0, 24).map((thought) => <Trace key={thought.id} thought={thought} />)}
            </ol>
          )}
        </aside>
      )}
    </>
  );
}

function Trace({ thought }: { thought: AiThought }) {
  return (
    <li className={`debug-trace ${thought.status}`}>
      <div className="debug-trace-top"><strong>{thought.playerName}</strong><span>{thought.status === 'thinking' ? 'thinking…' : thought.action ?? 'decision'}</span></div>
      <p>{thought.thought}</p>
      <small>{thought.source}</small>
    </li>
  );
}
