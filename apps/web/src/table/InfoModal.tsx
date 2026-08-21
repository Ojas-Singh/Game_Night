import { motion, AnimatePresence } from 'framer-motion';

interface InfoModalProps {
  open: boolean;
  onClose: () => void;
}

/**
 * In-game "Info" button content: the house rules plus a rhyme to remember the
 * special card actions. Read-only reference — closing returns to the table.
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
                  Be the player with the <strong>lowest score</strong> when someone calls{' '}
                  <strong>CABO</strong> and the round ends. Number cards are worth their face
                  value, <strong>Ace = 1</strong>, <strong>J = 11</strong>, <strong>Q = 12</strong>,
                  red <strong>King = 13</strong>, black <strong>King = −1</strong> — and your score
                  can never drop below <strong>−2</strong>.
                </p>
              </section>

              <section className="info-section">
                <h4>Setup</h4>
                <p>
                  Everyone gets 4 cards face-down in a 2×2 grid. At the start you peek at your{' '}
                  <strong>bottom two</strong>. On your turn, <strong>draw</strong> a card (keep it and
                  swap it in, or throw it straight onto the pile), or <strong>flush</strong> the pile.
                </p>
              </section>

              <section className="info-section">
                <h4>Flushing</h4>
                <p>
                  Throw cards that match the rank on top of the pile — your own, or another
                  player&rsquo;s card you&rsquo;ve already seen. Guess wrong and you&rsquo;ll be{' '}
                  <strong>caught</strong>: the card is revealed to everyone and you draw a{' '}
                  <strong>secret penalty card</strong>.
                </p>
              </section>

              <section className="info-section rhyme">
                <h4>The special cards</h4>
                <div className="rhyme-panel">
                  <p>
                    Five or six — <strong>swap the crowd</strong>:
                    <br />
                    two of your friends swap ~ allow.
                  </p>
                  <p>
                    Seven or eight — <strong>your own fate</strong>:
                    <br />
                    peek one of yours to set things straight.
                  </p>
                  <p>
                    Nine or ten — <strong>a friend&rsquo;s disguise</strong>:
                    <br />
                    peek their card before your eyes.
                  </p>
                  <p>
                    Jack or Queen — <strong>the blind swap</strong>:
                    <br />
                    trade one of yours without a peek, don&rsquo;t stop.
                  </p>
                </div>
              </section>

              <section className="info-section">
                <h4>CABO</h4>
                <p>
                  On your turn you can call <strong>CABO</strong> to end the round. Everyone else
                  gets one final turn; the caller doesn&rsquo;t. Then all cards are revealed and
                  the lowest score wins. Flush out all your cards to end the round early!
                </p>
              </section>
            </div>
          </motion.div>
        </motion.div>
      )}
    </AnimatePresence>
  );
}
