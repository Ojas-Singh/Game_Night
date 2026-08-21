/**
 * Seat geometry: place N opponents around the top arc of the ellipse.
 * The local player is always at the bottom; opponents spread naturally
 * from just left of bottom to just right of bottom, arc-style.
 */

export interface Seat {
  /** CSS positioning (percent within the table container). */
  style: React.CSSProperties;
  angle: number;
  /** Degrees to rotate a player's hand so it "faces" their seat (0 = toward
   *  the viewer/bottom; square cards keep values upright via counter-rotation). */
  facing: number;
}

export default function SeatPlanner(opponentCount: number): Seat[] {
  const n = Math.max(1, opponentCount);
  // Angles in degrees measured from the top (0° = directly opposite you).
  // We fan opponents across the arc 20°..160° (leaving the bottom for you).
  const start = 20;
  const end = 160;
  const seats: Seat[] = [];
  for (let i = 0; i < n; i++) {
    const t = n === 1 ? 0.5 : i / (n - 1);
    const angle = start + t * (end - start);
    const rad = (angle * Math.PI) / 180;
    // Ellipse: a bit wider than tall so 6 players still fit.
    const xPct = 50 + 44 * Math.cos(Math.PI - rad);
    const yPct = 46 - 34 * Math.sin(rad);
    // The hand faces toward the table for top players (0°) and tilts in for
    // the left (−) and right (+) sides so each player reads their own hand.
    const facing = angle - 90;
    seats.push({
      angle,
      facing,
      style: {
        left: `${xPct}%`,
        top: `${yPct}%`,
        transform: `translate(-50%, -50%)`,
      },
    });
  }
  return seats;
}
