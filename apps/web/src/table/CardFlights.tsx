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
export const DURATION = 0.75;
/** After arrival the whole trail LINGERS and decays, so players can read
 *  back the latest movements instead of the ghost vanishing on landing. */
export const DECAY = 1.6;
/** The comet trail: how many fading ghost copies lag behind the leader. */
const TRAIL = 5;
const TRAIL_STEP = 0.07;
/** Total lifetime of one flight group. */
const TOTAL = DURATION + DECAY;

/**
 * Ghost cards that fly from a seat (or the deck) to a destination, trailed by
 * a dashed path and fading comet copies that DECAY over time — the movement
 * stays readable for a couple of seconds after the card lands. Face-up ghosts
 * show the rank for public moves (flush/discard); face-down for secret ones
 * (draw, penalty). Purely an overlay: it never moves the real cards.
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
  // The group stays on screen while the trail decays, then is removed.
  useEffect(() => {
    const t = setTimeout(() => onDone(flight.id), (TOTAL + TRAIL * TRAIL_STEP + 0.2) * 1000);
    return () => clearTimeout(t);
  }, [flight.id, onDone]);

  return (
    <motion.div
      className="flight-group"
      initial={{ opacity: 1 }}
      exit={{ opacity: 0, transition: { duration: 0.18 } }}
    >
      {/* The lingering dashed path: appears with the flight and decays after
          arrival, showing WHERE the card came from and WHERE it went. */}
      <motion.svg className="flight-svg">
        <motion.line
          className="flight-path-line"
          x1={`${from.x}%`}
          y1={`${from.y}%`}
          x2={`${to.x}%`}
          y2={`${to.y}%`}
          initial={{ opacity: 0 }}
          animate={{ opacity: [0, 0.75, 0.75, 0] }}
          transition={{ duration: TOTAL, times: [0, 0.2, DURATION / TOTAL, 1], ease: 'easeOut' }}
        />
      </motion.svg>
      {Array.from({ length: TRAIL }).map((_, i) => (
        <GhostCopy
          key={i}
          from={from}
          to={to}
          delay={TRAIL_STEP * (i + 1)}
          opacity={0.5 - i * 0.09}
          scale={0.9 - i * 0.09}
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
  // Travel finishes at DURATION; the copy then lingers at the destination and
  // decays to nothing across DECAY seconds (per-copy keyframe timings).
  const total = TOTAL;
  const times = [0, (DURATION * 0.45) / total, DURATION / total, 1];
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
        opacity: 0,
        scale: 0.55,
        rotate: 10,
      }}
      animate={{
        left: `${to.x}%`,
        top: `${to.y}%`,
        x: -30,
        y: -43,
        opacity: [0, opacity, opacity, 0],
        scale: [0.55, scale, scale, 0.7],
        rotate: 6,
      }}
      exit={{ opacity: 0, scale: 0.4 }}
      transition={{
        delay,
        left: { delay, duration: DURATION, ease: [0.2, 0.7, 0.3, 1] },
        top: { delay, duration: DURATION, ease: [0.2, 0.7, 0.3, 1] },
        opacity: { delay, duration: total, times, ease: 'linear' },
        scale: { delay, duration: total, times },
        rotate: { delay, duration: DURATION },
        x: { delay, duration: 0 },
        y: { delay, duration: 0 },
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
