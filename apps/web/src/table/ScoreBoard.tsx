import { motion } from 'framer-motion';
import { RANK_LABELS } from '@shared/cards.js';
import type { CaboPlayerView } from '@cabo/views.js';
import type { RoomApi } from '../useRoom.js';

/**
 * Round-end reveal: score table with the winner highlighted, then
 * Play Again / Return to Lobby. Sequenced card flips are driven by CSS
 * animation-delay on the known (revealed) cards.
 */
export default function ScoreBoard({ view, room }: { view: CaboPlayerView; room: RoomApi }) {
  const scores = view.scores ?? {};
  const best = Math.min(...Object.values(scores));
  const winners = Object.entries(scores).filter(([, s]) => s === best);

  return (
    <motion.div
      initial={{ opacity: 0, scale: 0.94 }}
      animate={{ opacity: 1, scale: 1 }}
      className="round-overlay"
    >
      <div className="round-card">
        <h2 className="font-display round-title">Round complete</h2>
        {view.roundWinnerId ? (
          <p className="round-winner">
            🏆 {view.players.find((p) => p.id === view.roundWinnerId)?.name} wins the round!
          </p>
        ) : (
          <p className="round-winner">
            🤝 Tie between {winners.map(([id]) => view.players.find((p) => p.id === id)?.name).join(' & ')}
          </p>
        )}
        <table className="score-table">
          <thead>
            <tr>
              <th>Player</th>
              <th>Cards</th>
              <th>Score</th>
            </tr>
          </thead>
          <tbody>
            {view.players.map((p, i) => {
              const cards = (view.handCardIds[p.id] ?? []).map(
                (id) => view.knownCards[id],
              );
              return (
                <motion.tr
                  key={p.id}
                  initial={{ opacity: 0, x: -14 }}
                  animate={{ opacity: 1, x: 0 }}
                  transition={{ delay: 0.15 + i * 0.18 }}
                  className={scores[p.id] === best ? 'winner-row' : ''}
                >
                  <td>{p.name}</td>
                  <td className="score-cards">
                    {cards.map(
                      (c, j) =>
                        c && (
                          <motion.span
                            key={c.id}
                            initial={{ rotateY: 180, opacity: 0 }}
                            animate={{ rotateY: 0, opacity: 1 }}
                            transition={{ delay: 0.3 + i * 0.18 + j * 0.14 }}
                            className={`mini-flip ${
                              c.suit === 'hearts' || c.suit === 'diamonds' ? 'red' : ''
                            }`}
                          >
                            {RANK_LABELS[c.rank]}
                            {{ spades: '♠', hearts: '♥', diamonds: '♦', clubs: '♣' }[c.suit]}
                          </motion.span>
                        ),
                    )}
                  </td>
                  <td className="score-num">{scores[p.id]}</td>
                </motion.tr>
              );
            })}
          </tbody>
        </table>
        {room.lobby?.hostId === room.myPlayerId ? (
          <div className="round-actions">
            <button onClick={() => room.returnToLobby()}>Return to Lobby</button>
          </div>
        ) : (
          <p className="waiting-host">Waiting for the host…</p>
        )}
      </div>
    </motion.div>
  );
}
