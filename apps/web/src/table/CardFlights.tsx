import { useEffect } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import type { CardFlight } from '../useRoom.js';
import { RANK_LABELS } from '@shared/cards.js';
import type { Rank } from '@shared/cards.js';

export interface FlightPos {
  x: number;
  y: number;
}

interface CardFlightsProps {
  flights: CardFlight[];
  /** playerId → percent coords within .table-ellipse (me + opponents). */
  seatPos: Record<string, FlightPos>;
  /** Percent coords of the discard pile within .table-ellipse. */
  discardPos: FlightPos;
  /** Drop position for a drawn card (local slot). */
  drawPos: FlightPos;
  onDone: (id: string) => void;
}

const DURATION = 0.85;

/**
 * Ghost cards that fly from a seat (or the deck) to the discard pile (or to
 * your slot for a draw). Positioned absolutely inside the table so every
 * player sees where each card came from and where it landed. Purely an
 * overlay — it never moves the real cards.
 */
export default function CardFlights({ flights, seatPos, discardPos, drawPos, onDone }: CardFlightsProps) {
  return (
    <AnimatePresence>
      {flights.map((f) => {
        const from = f.fromPlayerId === 'deck' ? { x: 50, y: 46 } : seatPos[f.fromPlayerId] ?? { x: 50, y: 46 };
        const to = f.toDiscard ? discardPos : drawPos;
        return (
          <FlightGhost key={f.id} flight={f} from={from} to={to} onDone={onDone} />
        );
      })}
    </AnimatePresence>
  );
}

function FlightGhost({
  flight,
  from,
  to,
  onDone,
}: {
  flight: CardFlight;
  from: FlightPos;
  to: FlightPos;
  onDone: (id: string) => void;
}) {
  // Remove ourselves shortly after the animation completes.
  useEffect(() => {
    const t = setTimeout(() => onDone(flight.id), (DURATION + 0.15) * 1000);
    return () => clearTimeout(t);
  }, [flight.id, onDone]);

  return (
    <motion.div
      className="flight-ghost"
      style={{ width: 60, height: 86 }}
      // x/y centre the card on its left/top (% coords inside the table).
      initial={{ left: `${from.x}%`, top: `${from.y}%`, x: -30, y: -43, opacity: 0, scale: 0.6, rotate: 8 }}
      animate={{ left: `${to.x}%`, top: `${to.y}%`, x: -30, y: -43, opacity: [0, 1, 1, 0.9], scale: [0.6, 1.1, 1, 0.8] }}
      exit={{ opacity: 0, scale: 0.4 }}
      transition={{ duration: DURATION, ease: [0.2, 0.7, 0.3, 1] }}
    >
      <div className="flight-arrow" />
      {flight.toDiscard ? (
        <div className="flight-label">{RANK_LABELS[flight.rank as Rank]}</div>
      ) : (
        // A drawn card is face-down to everyone except the drawer: show the
        // back pattern instead of leaking its value via the shared event log.
        <div className="flight-back" />
      )}
    </motion.div>
  );
}
