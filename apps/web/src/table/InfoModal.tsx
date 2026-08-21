import { motion, AnimatePresence } from 'framer-motion';

interface InfoModalProps {
  open: boolean;
  onClose: () => void;
}

/**
 * In-game "Info" button content: the house rules, written to be quick to read
 * and easy to remember. Read-only reference — closing returns to the table.
 */
export default function InfoModal({ open, onClose }: InfoModalProps) {
  return (
    <AnimatePresence>
      {open && (
        <motion.div
          className="info-overlay"
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          onClick={onClose}
        >
          <motion.div
            className="info-card"
            initial={{ scale: 0.9, y: 16, opacity: 0 }}
            animate={{ scale: 1, y: 0, opacity: 1 }}
            exit={{ scale: 0.94, y: 10, opacity: 0 }}
            transition={{ type: 'spring', stiffness: 320, damping: 28 }}
            onClick={(e) => e.stopPropagation()}
          >
            <div className="info-head">
              <span className="info-title">How to play Cabo</span>
              <button className="info-close" onClick={onClose} aria-label="Close rules">
                ✕
              </button>
            </div>

            <div className="info-body">
              <section className="info-section">
                <h4>Aim</h4>
                <p>
                  Have the <strong>lowest score</strong> by the end of the game.
                </p>
                <p>
                  Number cards = face value &middot; <strong>Ace = 1</strong> &middot;{' '}
                  <strong>Jack = 11</strong> &middot; <strong>Queen = 12</strong> &middot;{' '}
                  <strong>Red King = 13</strong> &middot; <strong>Black King = &minus;1</strong>
                </p>
                <p>
                  Lowest possible score: <strong>&minus;2</strong>.
                </p>
              </section>

              <section className="info-section">
                <h4>Setup</h4>
                <p>
                  Get <strong>4 face-down cards</strong> in a 2&times;2 grid. Peek at your{' '}
                  <strong>bottom two</strong>.
                </p>
                <p>
                  On your turn, <strong>draw a card</strong>: swap it with one of yours or discard
                  it.
                </p>
                <p className="tip">
                  💡 Tip: It&rsquo;s usually better to replace a new card with one of your unknown
                  cards, so you learn more about your cards early on.
                </p>
              </section>

              <section className="info-section">
                <h4>Flushing</h4>
                <p>
                  If a card matches the number on top of the discard pile, <strong>flush it</strong>{' '}
                  &mdash; yours or another player&rsquo;s card you&rsquo;ve already seen, even when
                  it&rsquo;s not your turn.
                </p>
                <p>
                  <strong>Guess wrong:</strong> the card is revealed to everyone, and you must take
                  a <strong>penalty card</strong>.
                </p>
              </section>

              <section className="info-section special">
                <h4>Special cards</h4>
                <div className="special-panel">
                  <p>
                    <strong>7 or 8 &mdash; Know Your Fate:</strong> Peek at one of your cards.
                  </p>
                  <p>
                    <strong>9 or 10 &mdash; Know Your Friend:</strong> Peek at one of your
                    friend&rsquo;s cards.
                  </p>
                  <p>
                    <strong>Jack or Queen &mdash; Switch Between:</strong> Trade one of your cards
                    with someone else&rsquo;s <strong>without looking</strong>.
                  </p>
                </div>
              </section>

              <section className="info-section">
                <h4>Call CABO</h4>
                <p>
                  On your turn, call <strong>CABO</strong> to end the round. Everyone else gets{' '}
                  <strong>one final turn</strong> &mdash; but you don&rsquo;t.
                </p>
                <p>
                  Card reveal! <strong>Lowest score wins.</strong>
                </p>
              </section>
            </div>
          </motion.div>
        </motion.div>
      )}
    </AnimatePresence>
  );
}