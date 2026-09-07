import type { ReactNode } from 'react';
import { useNavigate } from 'react-router-dom';
import type { RoomApi } from '../useRoom.js';
import ChatPanel from '../chat/ChatPanel.js';

export default function TableShell({ room, children, title, actor }: { room: RoomApi; children: ReactNode; title: string; actor?: number | null }) {
  const navigate = useNavigate();
  const host = room.lobby?.hostId === room.myPlayerId;
  return <main className="platform-table"><header className="platform-toolbar"><h1>{title}</h1><span>Table {room.roomId}</span>
    <button className="ghost" onClick={() => { room.leaveRoom(); navigate('/'); }}>Leave table</button>
    {host && <button className="ghost" onClick={() => room.returnToLobby()}>Back to lobby</button>}
  </header><div className="platform-seats">{room.lobby?.players.map((p, i) => <div key={p.id} className={`platform-seat ${actor === i ? 'active' : ''}`}>
    {p.name}{p.id === room.myPlayerId ? ' · You' : ''}{p.kind === 'ai' ? ' · AI' : ''}{!p.connected ? ' · Reconnecting' : ''}
  </div>)}</div>{children}<ChatPanel room={room} floating /></main>;
}
