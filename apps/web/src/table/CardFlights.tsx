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
export const DURATION = 0.7;
/** After arrival the trail LINGERS and decays so players can read back the
 *  latest movements instead of the ghost vanishing on landing. */
export const DECAY = 1.5;
const TRAIL = 5;
const TRAIL_STEP = 0.06;
/** Total lifetime of one flight group. */
const TOTAL = DURATION + DECAY;

/**
 * 3D card flights: a tumbling card (or a glowing "eye" for peeks) arcs from
 * source to destination with a comet tail, a flowing dashed path, and a
 * landing pulse — then the whole trail decays away. Purely an overlay: it
 * never moves the real cards. Face-up ghosts show the rank for public moves
 * (flush/discard); face-down for secret ones (draw, penalty, swaps).
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
        return f.kind === 'peek' ? (
          <PeekGhost key={f.id} from={from} to={to} onDone={onDone} id={f.id} />
        ) : (
          <FlightGhost key={f.id} flight={f} from={from} to={to} onDone={onDone} />
        );
      })}
    </AnimatePresence>
  );
}

/** Shared lifetime cleanup. */
function useFlightLifetime(id: string, onDone: (id: string) => void): void {
  useEffect(() => {
    const t = setTimeout(() => onDone(id), (TOTAL + TRAIL * TRAIL_STEP + 0.2) * 1000);
    return () => clearTimeout(t);
  }, [id, onDone]);
}

/* ------------------------------------------------------------------ */
/* Card movement                                                       */
/* ------------------------------------------------------------------ */

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
  useFlightLifetime(flight.id, onDone);
  const arc = Math.min(34, Math.hypot(to.x - from.x, to.y - from.y) * 0.22);

  return (
    <motion.div
      className="flight-group"
      initial={{ opacity: 1 }}
      exit={{ opacity: 0, transition: { duration: 0.18 } }}
    >
      <FlightPath from={from} to={to} arc={arc} />
      <LandingPulse to={to} delay={DURATION} />
      {Array.from({ length: TRAIL }).map((_, i) => (
        <GhostCopy
          key={i}
          from={from}
          to={to}
          arc={arc}
          delay={TRAIL_STEP * (i + 1)}
          opacity={0.42 - i * 0.07}
          scale={0.62 - i * 0.08}
          faceDown={!flight.toDiscard}
          rank={flight.rank}
        />
      ))}
      <GhostCopy
        from={from}
        to={to}
        arc={arc}
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
  arc,
  delay,
  opacity,
  scale,
  faceDown,
  rank,
  leader = false,
}: {
  from: FlightPos;
  to: FlightPos;
  arc: number;
  delay: number;
  opacity: number;
  scale: number;
  faceDown: boolean;
  rank: number;
  leader?: boolean;
}) {
  // Travel finishes at DURATION; the copy then lingers at the destination and
  // decays to nothing across DECAY seconds.
  const total = TOTAL;
  const times = [0, (DURATION * 0.5) / total, DURATION / total, 1];
  const spin = leader ? 360 + 180 : 180; // the leader does a full flip + half
  return (
    <motion.div
      className={`flight-ghost ${leader ? 'leader' : 'trail'} ${faceDown ? 'back' : ''}`}
      style={{ width: 60, height: 86, transformPerspective: 900 }}
      initial={{
        left: `${from.x}%`,
        top: `${from.y}%`,
        x: -30,
        y: -43,
        opacity: 0,
        scale: 0.5,
        rotate: -14,
        rotateY: 0,
      }}
      animate={{
        left: `${to.x}%`,
        top: `${to.y}%`,
        x: -30,
        // Arc: lift off the straight line mid-flight so the card "hops".
        y: [-43, -43 - arc, -43 - arc * 0.4, -43],
        opacity: [0, opacity, opacity, 0],
        scale: [0.5, scale * 1.12, scale, 0.72],
        rotate: [-14, 4, 2, 0],
        rotateY: [0, spin * 0.55, spin, spin],
      }}
      exit={{ opacity: 0, scale: 0.4 }}
      transition={{
        delay,
        left: { delay, duration: DURATION, ease: [0.25, 0.8, 0.3, 1] },
        top: { delay, duration: DURATION, ease: [0.25, 0.8, 0.3, 1] },
        y: { delay, duration: DURATION + 0.1, times: [0, 0.5, 0.8, 1], ease: 'easeOut' },
        opacity: { delay, duration: total, times, ease: 'linear' },
        scale: { delay, duration: total, times },
        rotate: { delay, duration: DURATION },
        rotateY: { delay, duration: DURATION, ease: 'easeInOut' },
      }}
    >
      <div className="flight-card3d">
        {leader && <div className="flight-arrow" />}
        {faceDown ? (
          <div className="flight-back" />
        ) : (
          <div className="flight-label">{RANK_LABELS[rank as Rank]}</div>
        )}
      </div>
    </motion.div>
  );
}

/* ------------------------------------------------------------------ */
/* Peek: a glowing eye that travels to the peeked card                 */
/* ------------------------------------------------------------------ */

function PeekGhost({ from, to, onDone, id }: { from: FlightPos; to: FlightPos; onDone: (id: string) => void; id: string }) {
  useFlightLifetime(id, onDone);
  const peekDuration = 0.8;
  return (
    <motion.div
      className="flight-group"
      initial={{ opacity: 1 }}
      exit={{ opacity: 0, transition: { duration: 0.18 } }}
    >
      <FlightPath from={from} to={to} arc={10} peek />
      <LandingPulse to={to} delay={peekDuration} peek />
      <motion.div
        className="peek-orb"
        initial={{ left: `${from.x}%`, top: `${from.y}%`, x: -22, y: -22, opacity: 0, scale: 0.4 }}
        animate={{
          left: `${to.x}%`,
          top: `${to.y}%`,
          x: -22,
          y: [-22, -34, -22],
          opacity: [0, 1, 1, 0],
          scale: [0.4, 1.15, 1, 0.8],
        }}
        transition={{
          left: { duration: peekDuration, ease: [0.3, 0.7, 0.3, 1] },
          top: { duration: peekDuration, ease: [0.3, 0.7, 0.3, 1] },
          y: { duration: peekDuration, times: [0, 0.5, 1], ease: 'easeOut' },
          opacity: { duration: TOTAL, times: [0, 0.15, peekDuration / TOTAL, 1], ease: 'linear' },
          scale: { duration: TOTAL, times: [0, 0.3, peekDuration / TOTAL, 1] },
        }}
      >
        <span className="peek-eye">👁</span>
        {[0, 1, 2].map((i) => (
          <span key={i} className="peek-spark" style={{ animationDelay: `${i * 0.14}s` }} />
        ))}
      </motion.div>
    </motion.div>
  );
}

/* ------------------------------------------------------------------ */
/* Shared decorations                                                  */
/* ------------------------------------------------------------------ */

/** The flowing dashed path from source to destination; holds until arrival,
 *  then decays with the trail. */
function FlightPath({ from, to, arc, peek = false }: { from: FlightPos; to: FlightPos; arc: number; peek?: boolean }) {
  // Control point lifted off the midpoint → gentle quadratic curve.
  const cx = (from.x + to.x) / 2;
  const cy = (from.y + to.y) / 2 - arc;
  const d = `M ${from.x} ${from.y} Q ${cx} ${cy} ${to.x} ${to.y}`;
  return (
    <motion.svg className={`flight-svg ${peek ? 'peek' : ''}`}>
      <motion.path
        className="flight-path-line"
        d={d}
        initial={{ opacity: 0 }}
        animate={{ opacity: [0, 0.85, 0.85, 0] }}
        transition={{ duration: TOTAL, times: [0, 0.15, DURATION / TOTAL, 1], ease: 'easeOut' }}
      />
    </motion.svg>
  );
}

/** A soft ring pulse where the card/eye lands. */
function LandingPulse({ to, delay, peek = false }: { to: FlightPos; delay: number; peek?: boolean }) {
  return (
    <motion.div
      className={`landing-pulse ${peek ? 'peek' : ''}`}
      style={{ left: `${to.x}%`, top: `${to.y}%` }}
      initial={{ opacity: 0, scale: 0.3 }}
      animate={{ opacity: [0, 0.9, 0], scale: [0.3, 1.6, 2.1] }}
      transition={{ delay, duration: 0.7, ease: 'easeOut' }}
    />
  );
}
