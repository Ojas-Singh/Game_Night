import { motion, AnimatePresence } from 'framer-motion';

export type InfoGame = 'cabo' | 'pairone' | 'seep';

interface InfoModalProps {
  open: boolean;
  onClose: () => void;
  /** Which game's rules to show. Defaults to Cabo. */
  game?: InfoGame;
}

/**
 * "How to play" content. In the lobby each game tile opens its own rules;
 * at the table the modal matches the game being played.
 */
export default function InfoModal({ open, onClose, game = 'cabo' }: InfoModalProps) {
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
              <span className="info-title">
                {game === 'pairone'
                  ? 'How to play Pair One'
                  : game === 'seep'
                    ? 'How to play Seep'
                    : 'How to play Cabo'}
              </span>
              <button className="info-close" onClick={onClose} aria-label="Close rules">
                ✕
              </button>
            </div>

            {game === 'pairone' ? <PairOneRules /> : game === 'seep' ? <SeepRules /> : <CaboRules />}
          </motion.div>
        </motion.div>
      )}
    </AnimatePresence>
  );
}

function CaboRules() {
  return (
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
          On your turn, <strong>draw a card</strong>: swap it with one of yours or discard it.
        </p>
        <p className="tip">
          💡 Tip: It&rsquo;s usually better to replace a new card with one of your unknown cards,
          so you learn more about your cards early on.
        </p>
      </section>

      <section className="info-section">
        <h4>Flushing</h4>
        <p>
          If a card matches the number on top of the discard pile, <strong>flush it</strong>{' '}
          &mdash; yours or another player&rsquo;s card you&rsquo;ve already seen, even when it&rsquo;s
          not your turn.
        </p>
        <p>
          <strong>Guess wrong:</strong> the card is revealed to everyone, and you must take a{' '}
          <strong>penalty card</strong>.
        </p>
      </section>

      <section className="info-section special">
        <h4>Special cards</h4>
        <div className="special-panel">
          <p>
            <strong>7 or 8 &mdash; Know Your Fate:</strong> Peek at one of your cards.
          </p>
          <p>
            <strong>9 or 10 &mdash; Know Your Friend:</strong> Peek at one of your friend&rsquo;s
            cards.
          </p>
          <p>
            <strong>Jack or Queen &mdash; Switch Between:</strong> Trade one of your cards with
            someone else&rsquo;s <strong>without looking</strong>.
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
  );
}

function PairOneRules() {
  return (
    <div className="info-body">
      <section className="info-section">
        <h4>Aim</h4>
        <p>
          Collect the most <strong>pairs</strong> — matching numbers — by the time the table is
          empty.
        </p>
      </section>

      <section className="info-section">
        <h4>Setup</h4>
        <p>
          <strong>One full deck</strong> (52 cards) is shuffled and laid out face-down
          in one big grid. Every rank appears <strong>eight times</strong>, so there is always
          another match out there.
        </p>
      </section>

      <section className="info-section">
        <h4>Your turn</h4>
        <p>
          Flip any <strong>two face-down cards</strong>. They stay up for everyone to see.
        </p>
        <p>
          <strong>Same number?</strong> You collect the pair, put it in front of you, and{' '}
          <strong>go again</strong>!
        </p>
        <p>
          <strong>Different numbers?</strong> Both cards flip back where they were, and the turn
          passes left.
        </p>
        <p className="tip">
          💡 Tip: remember positions, not just faces — a missed pair is someone else&rsquo;s
          jackpot on their next turn.
        </p>
      </section>

      <section className="info-section special">
        <h4>Memory is everything</h4>
        <div className="special-panel">
          <p>🧠 Every flip is public — watch what OTHER players turn over too.</p>
          <p>📍 Cards flip back in the exact same spot, so gaps tell you which pairs are gone.</p>
          <p>🔥 Chain matches: each pair you find keeps the turn with you.</p>
        </div>
      </section>

      <section className="info-section">
        <h4>Endgame</h4>
        <p>
          The round ends when the <strong>last pair</strong> is collected. Most pairs wins — ties
          are shared.
        </p>
      </section>
    </div>
  );
}

function SeepRules() {
  return (
    <div className="info-body">
      <section className="info-section">
        <h4>Aim</h4>
        <p>
          Play in <strong>partnerships of two</strong> (you and the player across the table
          score together). Play one card per turn — use its number (A=1, J=11, Q=12, K=13) to
          capture cards worth points: <strong>every spade at face value</strong> (K♠ 13!), the
          other <strong>aces 1</strong> each, and the <strong>10♦ 2</strong>.
        </p>
        <p>
          The team that captures <strong>more cards</strong> gets +4 — 100 points in the deck.
        </p>
      </section>

      <section className="info-section">
        <h4>The opening</h4>
        <p>
          The opener receives 4 cards; 4 more go <strong>face-down</strong> to the table. The
          opener <strong>announces a number 9–13 they hold</strong> — the table turns up — and
          their first play must involve that number: capture cards totalling it, build a ghar of
          it, or throw the announced card. Then everyone is dealt up to 12 cards.
        </p>
      </section>

      <section className="info-section">
        <h4>Capturing</h4>
        <p>
          Play a card and take table cards that <strong>group into its value</strong> — several
          groups at once is fine: with an 8, take <em>A+7</em>, <em>3+5</em> <em>and</em> a
          loose 8. If your card <em>can</em> capture, it <strong>must</strong>.
        </p>
      </section>

      <section className="info-section special">
        <h4>Ghar (houses)</h4>
        <div className="special-panel">
          <p>
            🏗 <strong>Build:</strong> your card + table cards form one set totalling{' '}
            <strong>9–13</strong>, and you hold another card of that total — a{' '}
            <em>kachcha</em> ghar, owned by you.
          </p>
          <p>
            🔒 <strong>Pakka:</strong> a second complete set of the same total (yours or your
            partner&rsquo;s) locks the ghar — it can never be broken again.
          </p>
          <p>
            💥 <strong>Break:</strong> play a card on a <em>kachcha</em> ghar you don&rsquo;t
            own to raise its total (max 13) — you must hold the new total, and the ghar becomes
            yours.
          </p>
          <p>
            🏠 <strong>Capture:</strong> a card matching the total takes the whole ghar.
          </p>
          <p>As long as you own a ghar, you must keep a matching card in hand.</p>
        </div>
      </section>

      <section className="info-section">
        <h4>Seep!</h4>
        <p>
          Clear <strong>every card off the table</strong> in one play: <strong>+50</strong> —
          but only <strong>+25</strong> on the opening play, and <strong>nothing</strong> on
          the deal&rsquo;s final card.
        </p>
      </section>

      <section className="info-section">
        <h4>Endgame</h4>
        <p>
          Everyone plays all 12 cards. Leftover table cards go to the team that captured{' '}
          <strong>last</strong>. Highest total wins the deal.
        </p>
        <p className="tip">💡 Tip: count the spades — a captured K♠ (13) is the richest card in the game.</p>
      </section>
    </div>
  );
}
