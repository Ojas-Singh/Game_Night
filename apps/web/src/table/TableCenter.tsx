import { AnimatePresence, motion } from 'framer-motion';
import { RANK_LABELS } from '@shared/cards.js';
import type { CaboPlayerView } from '@cabo/views.js';

export default function TableCenter({
  view,
  onDraw,
  onCallCabo,
}: {
  view: CaboPlayerView;
  onDraw: (() => void) | null;
  onCallCabo: (() => void) | null;
}) {
  const discard = view.discardTop;
  return (
    <div className="table-center">
      <div className="pile-row">
        <div className={`pile deck-pile ${onDraw ? 'active' : ''}`} onClick={onDraw ?? undefined} role={onDraw ? 'button' : undefined}>
          <div className="deck-stack s1" />
          <div className="deck-stack s2" />
          <div className="deck-stack s3" />
          <span className="pile-label">DRAW</span>
          <span className="pile-count">{view.deckCount}</span>
        </div>
        <div className="pile discard-pile">
          <AnimatePresence mode="popLayout">
            {discard ? (
              <motion.div
                key={discard.id}
                initial={{ y: -60, scale: 0.7, opacity: 0, rotate: -12 }}
                animate={{ y: 0, scale: 1, opacity: 1, rotate: discard.rank % 2 ? 3 : -4 }}
                exit={{ opacity: 0 }}
                transition={{ type: 'spring', stiffness: 380, damping: 26 }}
                className="discard-card"
              >
                <span
                  className={
                    discard.suit === 'hearts' || discard.suit === 'diamonds' ? 'red' : ''
                  }
                >
                  {RANK_LABELS[discard.rank]}
                  {{ spades: '♠', hearts: '♥', diamonds: '♦', clubs: '♣' }[discard.suit]}
                </span>
              </motion.div>
            ) : (
              <div className="discard-empty" />
            )}
          </AnimatePresence>
          <span className="pile-label">DISCARD</span>
        </div>
      </div>
      {onCallCabo && (
        <motion.button
          initial={{ scale: 0.8, opacity: 0 }}
          animate={{ scale: 1, opacity: 1 }}
          className="cabo-btn"
          onClick={onCallCabo}
        >
          CALL CABO
        </motion.button>
      )}
      {view.cabo && !onCallCabo && (
        <div className="cabo-called-note">🚨 Cabo called — final turns!</div>
      )}
    </div>
  );
}
