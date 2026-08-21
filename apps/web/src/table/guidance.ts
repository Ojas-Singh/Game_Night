import { useCallback, useEffect, useState } from 'react';
import type { CaboPlayerView } from '@cabo/views.js';
import { POWER_DESCRIPTIONS } from '@cabo/rules.js';
import { playSound } from '../sound.js';

/**
 * Derives the one-line guidance prompt ("Ojas is drawing…",
 * "Choose one of your cards to view") from the filtered view — the UI always
 * communicates what the game expects.
 */
export function useGuidance(view: CaboPlayerView, myId: string) {
  const [error, setErrorState] = useState<string | null>(null);

  useEffect(() => {
    if (!error) return;
    const t = setTimeout(() => setErrorState(null), 2600);
    return () => clearTimeout(t);
  }, [error]);

  const setError = useCallback((msg: string) => {
    playSound('error');
    setErrorState(msg);
  }, []);

  const current = view.players.find((p) => p.isCurrentTurn);
  const amCurrent = current?.id === myId;
  const currentName = current?.name ?? '…';

  let text: string;
  let urgent = false;
  if (error) {
    text = error;
    urgent = true;
  } else if (view.phase === 'ROUND_COMPLETE') {
    text = 'Round over — check the scores!';
  } else if (view.phase === 'TRANSFER_PENDING') {
    text = view.pendingTransfer
      ? 'You flushed their card! Give them one of your cards'
      : 'A card is being exchanged…';
    urgent = !!view.pendingTransfer;
  } else if (view.pendingPower) {
    text = POWER_DESCRIPTIONS[view.pendingPower.power as keyof typeof POWER_DESCRIPTIONS];
    urgent = true;
  } else if (view.phase === 'DRAW_DECISION') {
    text = amCurrent
      ? 'Keep the drawn card (tap a hand slot) or discard it (tap the drawn card)'
      : `${currentName} is deciding…`;
  } else if (view.phase === 'TURN_END') {
    if (view.cabo) {
      text = amCurrent
        ? 'Final round — end your turn when ready'
        : `${currentName} is finishing the round…`;
    } else {
      text = amCurrent
        ? 'Action done — ring the bell to call Cabo, or end your turn'
        : `${currentName} may call Cabo…`;
    }
  } else if (view.phase === 'TURN_DRAW') {
    if (view.cabo) {
      text = amCurrent
        ? 'Final turn! Draw a card — or trust your hand and just play'
        : `${currentName}'s final turn…`;
    } else {
      text = amCurrent ? 'Your turn — tap the deck to draw' : `${currentName} is drawing…`;
    }
  } else {
    text = '…';
  }

  return { text, urgent, setError };
}
