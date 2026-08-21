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
                initial={{ opacity: 0, scale: 0.6, y: -24 }}
                animate={{ opacity: 1, scale: 1, y: 0, rotate: discard.rank % 2 ? 3 : -4 }}
                exit={{ opacity: 0 }}
                transition={{ type: 'spring', stiffness: 320, damping: 26 }}
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
      <div className="cabo-ring-zone">
        {onCallCabo ? (
          <AnimatePresence>
            <motion.button
              className="cabo-ring"
              onClick={onCallCabo}
              aria-label="Call Cabo"
              title="Ring the bell — call Cabo! Everyone gets one last turn."
              initial={{ scale: 0.6, opacity: 0, rotate: -20 }}
              animate={{ scale: 1, opacity: 1, rotate: 0 }}
              exit={{ scale: 0.6, opacity: 0 }}
              transition={{ type: 'spring', stiffness: 260, damping: 20 }}
            >
              {/* A cute little service bell — no text needed. */}
              <span className="cabo-bell">
                <span className="dome" />
                <span className="base" />
                <span className="knob" />
              </span>
            </motion.button>
          </AnimatePresence>
        ) : null}
      </div>
    </div>
  );
}
