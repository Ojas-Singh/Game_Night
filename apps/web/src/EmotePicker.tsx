import { useState } from 'react';
import type { RoomApi } from './useRoom.js';

const EMOTES = ['😄', '😲', '😅', '😈', '😭', '🔥', '👏', '🤔'];

export default function EmotePicker({ room }: { room: RoomApi }) {
  const [open, setOpen] = useState(false);
  return (
    <div className="emote-picker">
      <button
        className="emote-toggle"
        onClick={() => setOpen(!open)}
        aria-label="Reactions"
        title="Reactions"
      >
        😊
      </button>
      {open && (
        <div className="emote-row">
          {EMOTES.map((e) => (
            <button
              key={e}
              className="emote-btn"
              onClick={() => {
                room.sendEmote(e);
                setOpen(false);
              }}
            >
              {e}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
