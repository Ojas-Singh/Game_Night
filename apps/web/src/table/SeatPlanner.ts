/**
 * Seat geometry: place N opponents around the top arc of the ellipse.
 * The local player is always at the bottom; opponents spread naturally
 * from just left of bottom to just right of bottom, arc-style.
 */

export interface Seat {
  /** CSS positioning (percent within the table container). */
  style: React.CSSProperties;
  angle: number;
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
    seats.push({
      angle,
      style: {
        left: `${xPct}%`,
        top: `${yPct}%`,
        transform: `translate(-50%, -50%) rotate(${(angle - 90) * 0.12}deg)`,
      },
    });
  }
  return seats;
}
