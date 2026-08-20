/**
 * Development-only debug helpers:
 *  - reveal ALL card identities (fetched from the dev-only server endpoint)
 *  - add fake players to test table layouts with 3–6 seats
 * Only rendered when __DEBUG__ (compiled out in production builds).
 */

import { useEffect, useState } from 'react';
import type { RoomApi } from './useRoom.js';
import { RANK_LABELS } from '@shared/cards.js';

interface DebugState {
  players: Array<{ id: string; name: string }>;
  engine: {
    phase: string;
    hands: Record<string, Array<{ id: string; suit: string; rank: number }>>;
    deck: number;
  } | null;
}

export default function DebugPanel({ room }: { room: RoomApi }) {
  const [open, setOpen] = useState(false);
  const [state, setState] = useState<DebugState | null>(null);
  const roomId = room.lobby?.roomId;

  useEffect(() => {
    if (!open || !roomId) return;
    const tick = async () => {
      try {
        const res = await fetch(`/debug/room/${roomId}/state`);
        if (res.ok) setState(await res.json());
      } catch {
        /* debug endpoint unavailable */
      }
    };
    void tick();
    const iv = setInterval(tick, 2000);
    return () => clearInterval(iv);
  }, [open, roomId]);

  if (!__DEBUG__) return null;

  return (
    <div className="debug-panel">
      <button className="debug-toggle" onClick={() => setOpen(!open)}>
        🛠
      </button>
      {open && (
        <div className="debug-body">
          <div className="debug-title">DEBUG (dev only)</div>
          {roomId && (
            <button
              className="ghost debug-action"
              onClick={async () => {
                await fetch(`/debug/room/${roomId}/fake-player`, { method: 'POST' });
              }}
            >
              + fake player
            </button>
          )}
          {state?.engine && (
            <div className="debug-state">
              <div>phase: {state.engine.phase}</div>
              <div>deck: {state.engine.deck}</div>
              {Object.entries(state.engine.hands).map(([pid, cards]) => (
                <div key={pid}>
                  {state.players.find((p) => p.id === pid)?.name ?? pid}:{' '}
                  {cards.map((c) => `${RANK_LABELS[c.rank as 1 | 2 | 3]}${{ spades: '♠', hearts: '♥', diamonds: '♦', clubs: '♣' }[c.suit]}`).join(' ')}
                </div>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
