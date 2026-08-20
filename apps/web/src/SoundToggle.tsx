import { useState } from 'react';
import { isSoundEnabled, playSound, setSoundEnabled } from './sound.js';

export default function SoundToggle() {
  const [on, setOn] = useState(isSoundEnabled());
  return (
    <button
      className="sound-toggle"
      title={on ? 'Mute sounds' : 'Enable sounds'}
      aria-label={on ? 'Mute sounds' : 'Enable sounds'}
      onClick={() => {
        const next = !on;
        setOn(next);
        setSoundEnabled(next);
        if (next) playSound('flip');
      }}
    >
      {on ? '🔊' : '🔇'}
    </button>
  );
}
