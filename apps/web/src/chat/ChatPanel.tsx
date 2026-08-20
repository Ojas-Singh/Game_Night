import { useEffect, useRef, useState } from 'react';
import type { RoomApi } from '../useRoom.js';

/**
 * Collapsible chat — never obscures the table. In gameplay it starts
 * collapsed to a bubble with an unread badge; in the lobby it's expanded.
 */
export default function ChatPanel({ room, expanded = false }: { room: RoomApi; expanded?: boolean }) {
  const [open, setOpen] = useState(expanded);
  const [text, setText] = useState('');
  const [flash, setFlash] = useState<string | null>(null);
  const listRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (open && listRef.current) {
      listRef.current.scrollTop = listRef.current.scrollHeight;
    }
  }, [room.chat.length, open]);

  const send = () => {
    const t = text.trim();
    if (!t) return;
    room.sendChat(t);
    setText('');
  };

  return (
    <div className={`chat-panel ${open ? 'open' : 'closed'}`}>
      {open ? (
        <>
          <div className="chat-head">
            <span className="chat-title">Chat</span>
            {!expanded && (
              <button className="chat-collapse" onClick={() => setOpen(false)} aria-label="Collapse chat">
                ▾
              </button>
            )}
          </div>
          <div className="chat-log" ref={listRef}>
            {room.chat.map((m) => (
              <div key={m.id} className={`chat-msg ${m.playerId === null ? 'system' : ''}`}>
                {m.playerId === null ? (
                  <span className="chat-system-text">{m.text}</span>
                ) : (
                  <>
                    <span className="chat-name">{m.playerName}</span>
                    <span className="chat-text">{m.text}</span>
                  </>
                )}
              </div>
            ))}
          </div>
          <div className="chat-input-row">
            <input
              type="text"
              value={text}
              placeholder="Say something…"
              maxLength={500}
              onChange={(e) => setText(e.target.value)}
              onKeyDown={(e) => e.key === 'Enter' && send()}
            />
            <button className="ghost chat-send" onClick={send} aria-label="Send">
              ➤
            </button>
          </div>
          {flash && <div className="chat-flash">{flash}</div>}
        </>
      ) : (
        <button className="chat-bubble" onClick={() => { setOpen(true); room.markChatRead(); }}>
          💬
          {room.unreadChat > 0 && <span className="chat-badge">{room.unreadChat}</span>}
        </button>
      )}
    </div>
  );
}
