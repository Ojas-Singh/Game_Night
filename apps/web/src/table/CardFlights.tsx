import { useEffect } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import type { CardFlight } from '../useRoom.js';
import { RANK_LABELS } from '@shared/cards.js';
import type { Rank } from '@shared/cards.js';

export interface FlightPos {
  x: number;
  y: number;
}

/** Measured, pixel-accurate anchors for flight sources & destinations. */
export interface FlightAnchors {
  size: { w: number; h: number };
  deck: FlightPos;
  discard: FlightPos;
  draw: FlightPos;
  /** playerId → centre of that player's actual hand grid (in px). */
  hands: Record<string, FlightPos>;
  /** cardId → centre of that exact card element (data-card-id, in px). */
  cards: Record<string, FlightPos>;
}

interface CardFlightsProps {
  flights: CardFlight[];
  anchors: FlightAnchors;
  /** Local player id — their incoming cards land in the draw slot. */
  myId: string;
  onDone: (id: string) => void;
  /** Geometry-only per-seat centres (SeatPlanner × ellipse). Used when a DOM
   *  hand anchor is missing (element not yet mounted, display:none, etc.) so
   *  a flight is never silently dropped or collapsed to a zero-length move. */
  seatFallback?: Record<string, FlightPos>;
}

/** Minimum meaningful travel distance; below this a ghost is invisible. */
const MIN_TRAVEL_PX = 8;

/** Travel time to the destination. */
export const DURATION = 0.62;
/** After arrival the trail LINGERS and decays so players can read back the
 *  latest movements instead of the ghost vanishing on landing. */
export const DECAY = 1.3;
const TRAIL = 5;
const TRAIL_STEP = 0.055;
/** Total lifetime of one flight group. */
const TOTAL = DURATION + DECAY;
/** Cap on the mid-flight arc lift (px). */
const MAX_ARC = 64;

/**
 * Pixel-accurate card flights: every source/destination is the measured
 * centre of the real DOM element (deck pile, discard pile, draw slot, each
 * hand grid), and the ghosts animate via GPU transforms — so the overlay
 * tracks the true table exactly. Cards arc, flip in 3D, trail a comet tail
 * along a flowing dashed path, pulse on landing, then decay away. Peeks fly
 * as a glowing eye instead of a card (a look, not a move).
 */
function resolvePoint(
  primary: FlightPos | undefined,
  fallbacks: Array<FlightPos | undefined>,
  lastResort: FlightPos,
): FlightPos {
  for (const c of [primary, ...fallbacks]) if (c) return c;
  return lastResort;
}

/** Nudge the destination toward the table centre when a flight would be
 *  degenerate (from ≈ to), so the movement is always visible. */
function ensureVisible(from: FlightPos, to: FlightPos, centre: FlightPos): FlightPos {
  if (Math.hypot(to.x - from.x, to.y - from.y) >= MIN_TRAVEL_PX) return to;
  const dx = centre.x - to.x;
  const dy = centre.y - to.y;
  const len = Math.hypot(dx, dy) || 1;
  return { x: to.x + (dx / len) * 26, y: to.y + (dy / len) * 26 };
}

export default function CardFlights({
  flights, anchors, myId, onDone, seatFallback = {}, prevCards = {},
}: CardFlightsProps & {
  /** Positions captured before the last update — flight ORIGINS for cards
   *  that have already left the DOM (swapped to discard, flushed). */
  prevCards?: Record<string, FlightPos>;
}) {
  const centre = { x: anchors.size.w / 2, y: anchors.size.h / 2 };
  const handOrSeat = (pid: string): FlightPos | undefined =>
    anchors.hands[pid] ?? seatFallback[pid];
  return (
    <AnimatePresence>
      {flights.map((f) => {
        // Prefer the EXACT card element when we know it, then the measured
        // hand anchor, then the geometry-only seat position — the ghost must
        // always have somewhere real to start and land.
        const from = resolvePoint(
          f.fromCardId ? prevCards[f.fromCardId] : undefined,
          [
            // A deck-origin flight may carry the kept card id only so the
            // local player's previous draw-slot anchor can be used. Never use
            // the card's CURRENT hand position as its source in that case.
            f.fromPlayerId === 'deck' ? anchors.deck : undefined,
            // A source card is leaving its old slot. If the old snapshot is
            // unavailable, use the owner's hand/seat rather than the card's
            // current destination slot (important for transfers).
            f.fromPlayerId !== 'deck' ? handOrSeat(f.fromPlayerId) : undefined,
          ],
          anchors.discard,
        );
        let to = resolvePoint(
          f.toCardId ? anchors.cards[f.toCardId] : undefined,
          [
            f.toPlayerId ? handOrSeat(f.toPlayerId) : undefined,
            f.toPlayerId && f.toPlayerId === myId ? anchors.draw : undefined,
          ],
          f.toPlayerId ? anchors.discard : f.toDiscard ? anchors.discard : anchors.draw,
        );
        to = ensureVisible(from, to, centre);
        return f.kind === 'peek' ? (
          <PeekGhost key={f.id} id={f.id} from={from} to={to} anchors={anchors} onDone={onDone} />
        ) : (
          <FlightGhost key={f.id} flight={f} from={from} to={to} anchors={anchors} onDone={onDone} />
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

/** Mid-point lifted off the straight line → the card hops over the table. */
function arcMid(from: FlightPos, to: FlightPos): FlightPos {
  const arc = Math.min(MAX_ARC, Math.hypot(to.x - from.x, to.y - from.y) * 0.18);
  // Lift perpendicular to the travel direction, biased upward.
  return { x: (from.x + to.x) / 2, y: (from.y + to.y) / 2 - arc };
}

/* ------------------------------------------------------------------ */
/* Card movement                                                       */
/* ------------------------------------------------------------------ */

function FlightGhost({
  flight,
  from,
  to,
  anchors,
  onDone,
}: {
  flight: CardFlight;
  from: FlightPos;
  to: FlightPos;
  anchors: FlightAnchors;
  onDone: (id: string) => void;
}) {
  useFlightLifetime(flight.id, onDone);
  const mid = arcMid(from, to);
  // Cards landing on the discard pile must NOT linger: the real card is
  // already face-up beneath, and a lingering ghost (black label) made the
  // pile look like it "turns black first". Only hand-bound cards linger.
  const linger = !flight.toDiscard;

  return (
    <motion.div
      className="flight-group"
      initial={{ opacity: 1 }}
      exit={{ opacity: 0, transition: { duration: 0.18 } }}
    >
      <FlightPath from={from} to={to} mid={mid} anchors={anchors} linger={linger} />
      <LandingPulse to={to} delay={DURATION} />
      {Array.from({ length: TRAIL }).map((_, i) => (
        <GhostCopy
          key={i}
          from={from}
          to={to}
          mid={mid}
          delay={TRAIL_STEP * (i + 1)}
          opacity={0.4 - i * 0.065}
          scale={0.62 - i * 0.08}
          faceDown={!flight.toDiscard}
          rank={flight.rank}
          linger={linger}
        />
      ))}
      <GhostCopy
        from={from}
        to={to}
        mid={mid}
        delay={0}
        opacity={1}
        scale={1}
        faceDown={!flight.toDiscard}
        rank={flight.rank}
        linger={linger}
        leader
      />
    </motion.div>
  );
}

function GhostCopy({
  from,
  to,
  mid,
  delay,
  opacity,
  scale,
  faceDown,
  rank,
  leader = false,
  linger = true,
}: {
  from: FlightPos;
  to: FlightPos;
  mid: FlightPos;
  delay: number;
  opacity: number;
  scale: number;
  faceDown: boolean;
  rank: number;
  leader?: boolean;
  linger?: boolean;
}) {
  // Travel finishes at DURATION; lingering copies then decay across DECAY
  // seconds — or fade almost immediately when landing on the discard pile.
  const total = linger ? TOTAL : DURATION + 0.12;
  const times = [0, 0.5 * (DURATION / total), DURATION / total, 1];
  const spin = leader ? 540 : 180;
  return (
    <motion.div
      className={`flight-ghost ${leader ? 'leader' : 'trail'} ${faceDown ? 'back' : ''}`}
      style={{ width: 60, height: 86, transformPerspective: 900 }}
      initial={{ x: from.x, y: from.y, opacity: 0, scale: 0.5, rotate: -12, rotateY: 0 }}
      animate={{
        // Pixel coords, animated as transforms: smooth + exactly on target.
        x: [from.x, mid.x, to.x],
        y: [from.y, mid.y, to.y],
        opacity: [0, opacity, opacity, 0],
        scale: [0.5, scale * 1.1, scale, 0.72],
        rotate: [-12, 3, 0],
        rotateY: [0, spin * 0.6, spin],
      }}
      exit={{ opacity: 0, scale: 0.4 }}
      transition={{
        delay,
        x: { delay, duration: DURATION, ease: [0.3, 0.75, 0.25, 1] },
        y: { delay, duration: DURATION, ease: [0.35, 0.7, 0.3, 1] },
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

function PeekGhost({
  id,
  from,
  to,
  anchors,
  onDone,
}: {
  id: string;
  from: FlightPos;
  to: FlightPos;
  anchors: FlightAnchors;
  onDone: (id: string) => void;
}) {
  useFlightLifetime(id, onDone);
  const mid = { x: (from.x + to.x) / 2, y: (from.y + to.y) / 2 - 18 };
  const peekDuration = 0.7;
  return (
    <motion.div
      className="flight-group"
      initial={{ opacity: 1 }}
      exit={{ opacity: 0, transition: { duration: 0.18 } }}
    >
      <FlightPath from={from} to={to} mid={mid} anchors={anchors} peek />
      <LandingPulse to={to} delay={peekDuration} peek />
      <motion.div
        className="peek-orb"
        initial={{ x: from.x, y: from.y, opacity: 0, scale: 0.4 }}
        animate={{
          x: [from.x, mid.x, to.x],
          y: [from.y, mid.y, to.y],
          opacity: [0, 1, 1, 0],
          scale: [0.4, 1.15, 1, 0.85],
        }}
        transition={{
          x: { duration: peekDuration, ease: [0.3, 0.7, 0.3, 1] },
          y: { duration: peekDuration, ease: [0.35, 0.7, 0.3, 1] },
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
 *  then decays with the trail. Drawn in measured pixels. */
function FlightPath({
  from,
  to,
  mid,
  anchors,
  peek = false,
  linger = true,
}: {
  from: FlightPos;
  to: FlightPos;
  mid: FlightPos;
  anchors: FlightAnchors;
  peek?: boolean;
  linger?: boolean;
}) {
  const total = linger ? TOTAL : DURATION + 0.12;
  const d = `M ${from.x} ${from.y} Q ${mid.x} ${mid.y} ${to.x} ${to.y}`;
  return (
    <motion.svg
      className={`flight-svg ${peek ? 'peek' : ''}`}
      width={anchors.size.w}
      height={anchors.size.h}
      viewBox={`0 0 ${anchors.size.w} ${anchors.size.h}`}
    >
      <motion.path
        className="flight-path-line"
        d={d}
        initial={{ opacity: 0 }}
        animate={{ opacity: [0, 0.85, 0.85, 0] }}
        transition={{ duration: total, times: [0, 0.12, DURATION / total, 1], ease: 'easeOut' }}
      />
    </motion.svg>
  );
}

/** Swap in the PEEK style: for each exchanged card a small glowing
 *  face-down ghost glides from its OLD slot to its partner's OLD slot (its
 *  landing position), with the same curved path, sparks and landing pulse
 *  as the peek eye — no blinking connector lines. */
export function SwapGhosts({
  ghosts,
  size,
}: {
  ghosts: Array<{ id: string; from: FlightPos; to: FlightPos }>;
  size: { w: number; h: number };
}) {
  return (
    <>
      {ghosts.map((g) => (
        <SwapGhost key={g.id} from={g.from} to={g.to} size={size} />
      ))}
    </>
  );
}

function SwapGhost({ from, to, size }: { from: FlightPos; to: FlightPos; size: { w: number; h: number } }) {
  const mid = { x: (from.x + to.x) / 2, y: (from.y + to.y) / 2 - Math.min(46, Math.hypot(to.x - from.x, to.y - from.y) * 0.2) };
  const d = `M ${from.x} ${from.y} Q ${mid.x} ${mid.y} ${to.x} ${to.y}`;
  const D = 0.66;
  const TOTAL = 2.0;
  return (
    <motion.div className="flight-group" initial={{ opacity: 1 }} exit={{ opacity: 0, transition: { duration: 0.18 } }}>
      <svg className="flight-svg swap" width={size.w} height={size.h} viewBox={`0 0 ${size.w} ${size.h}`}>
        <motion.path
          className="flight-path-line swap"
          d={d}
          initial={{ opacity: 0 }}
          animate={{ opacity: [0, 0.8, 0.8, 0] }}
          transition={{ duration: TOTAL, times: [0, 0.12, D / TOTAL, 1], ease: 'easeOut' }}
        />
      </svg>
      <LandingPulse to={to} delay={D} />
      <motion.div
        className="swap-ghost"
        style={{ transformPerspective: 900 }}
        initial={{ x: from.x, y: from.y, opacity: 0, scale: 0.4, rotate: -12 }}
        animate={{
          x: [from.x, mid.x, to.x],
          y: [from.y, mid.y, to.y],
          opacity: [0, 1, 1, 0],
          scale: [0.4, 1.12, 1, 0.8],
          rotate: [-12, 6, 0],
        }}
        transition={{
          x: { duration: D, ease: [0.3, 0.7, 0.3, 1] },
          y: { duration: D, ease: [0.35, 0.7, 0.3, 1] },
          opacity: { duration: TOTAL, times: [0, 0.15, D / TOTAL, 1], ease: 'linear' },
          scale: { duration: TOTAL, times: [0, 0.3, D / TOTAL, 1] },
          rotate: { duration: D },
        }}
      >
        <div className="swap-ghost-card">
          <span className="swap-ghost-icon">⇄</span>
          {[0, 1, 2].map((i) => (
            <span key={i} className="peek-spark swap-spark" style={{ animationDelay: `${i * 0.14}s` }} />
          ))}
        </div>
      </motion.div>
    </motion.div>
  );
}

/** A soft ring pulse where the card/eye lands. */
function LandingPulse({ to, delay, peek = false }: { to: FlightPos; delay: number; peek?: boolean }) {
  return (
    <motion.div
      className={`landing-pulse ${peek ? 'peek' : ''}`}
      style={{ x: to.x, y: to.y }}
      initial={{ opacity: 0, scale: 0.3 }}
      animate={{ opacity: [0, 0.9, 0], scale: [0.3, 1.5, 2] }}
      transition={{ delay, duration: 0.65, ease: 'easeOut' }}
    />
  );
}
