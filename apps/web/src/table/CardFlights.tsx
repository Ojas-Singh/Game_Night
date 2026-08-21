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

/** How long the leader card takes to reach its destination. */
const DURATION = 0.85;
/** The comet trail: how many fading ghost copies lag behind the leader. */
const TRAIL = 4;
const TRAIL_STEP = 0.06;

/**
 * Ghost cards that fly from a seat (or the deck) to a destination, with a
 * fading comet-tail so everyone clearly sees the path and the latest
 * movement. Positioned absolutely inside the table — purely an overlay, it
 * never moves the real cards. Face-up ghosts show the rank for public moves
 * (flush/discard); face-down for secret ones (draw, penalty).
 */
export default function CardFlights({ flights, seatPos, discardPos, drawPos, onDone }: CardFlightsProps) {
  return (
    <AnimatePresence>
      {flights.map((f) => {
        const from = f.fromPlayerId === 'deck' ? { x: 50, y: 46 } : seatPos[f.fromPlayerId] ?? { x: 50, y: 46 };
        const to = f.toPlayerId
          ? (seatPos[f.toPlayerId] ?? drawPos)
          : f.toDiscard
            ? discardPos
            : drawPos;
        return <FlightGhost key={f.id} flight={f} from={from} to={to} onDone={onDone} />;
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
  // Remove the whole group shortly after the leader arrives.
  useEffect(() => {
    const t = setTimeout(() => onDone(flight.id), (DURATION + TRAIL * TRAIL_STEP + 0.2) * 1000);
    return () => clearTimeout(t);
  }, [flight.id, onDone]);

  return (
    <motion.div
      className="flight-group"
      initial={{ opacity: 1 }}
      exit={{ opacity: 0, transition: { duration: 0.18 } }}
    >
      {Array.from({ length: TRAIL }).map((_, i) => (
        <GhostCopy
          key={i}
          from={from}
          to={to}
          delay={TRAIL_STEP * (i + 1)}
          opacity={0.5 - i * 0.11}
          scale={0.9 - i * 0.1}
          faceDown={!flight.toDiscard}
          rank={flight.rank}
        />
      ))}
      <GhostCopy
        from={from}
        to={to}
        delay={0}
        opacity={1}
        scale={1}
        faceDown={!flight.toDiscard}
        rank={flight.rank}
        leader
      />
    </motion.div>
  );
}

function GhostCopy({
  from,
  to,
  delay,
  opacity,
  scale,
  faceDown,
  rank,
  leader = false,
}: {
  from: FlightPos;
  to: FlightPos;
  delay: number;
  opacity: number;
  scale: number;
  faceDown: boolean;
  rank: number;
  leader?: boolean;
}) {
  return (
    <motion.div
      className={`flight-ghost ${leader ? 'leader' : 'trail'} ${faceDown ? 'back' : ''}`}
      style={{ width: 60, height: 86 }}
      // x/y centre the card on its left/top (% coords inside the table).
      initial={{
        left: `${from.x}%`,
        top: `${from.y}%`,
        x: -30,
        y: -43,
        opacity: leader ? 0 : 0,
        scale: 0.55,
        rotate: 10,
      }}
      animate={{
        left: `${to.x}%`,
        top: `${to.y}%`,
        x: -30,
        y: -43,
        opacity: [0, opacity, opacity, 0.2],
        scale: [0.55, scale, scale, 0.7],
        rotate: 6,
      }}
      exit={{ opacity: 0, scale: 0.4 }}
      transition={{
        delay,
        duration: DURATION,
        ease: [0.2, 0.7, 0.3, 1],
      }}
    >
      {leader && <div className="flight-arrow" />}
      {faceDown ? (
        <div className="flight-back" />
      ) : (
        <div className="flight-label">{RANK_LABELS[rank as Rank]}</div>
      )}
    </motion.div>
  );
}
