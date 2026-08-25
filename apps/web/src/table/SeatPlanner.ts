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
  /** Where the avatar+name pill sits relative to that player's hand, from MY
   *  point of view — like people seated around a real table: opposite players
   *  sit BEYOND their cards (above them), side players sit beside them. */
  whoSide: 'above' | 'left' | 'right';
}

/**
 * Return the other players in circular turn order, starting immediately
 * after the viewer. The engine's player list is seat-ordered, but rendering
 * that list unchanged makes the table jump across the circle whenever the
 * local player is not seat zero.
 */
export function orderPlayersForViewer<T extends { id: string }>(
  players: readonly T[],
  viewerId: string,
): T[] {
  const viewerIndex = players.findIndex((p) => p.id === viewerId);
  if (viewerIndex < 0) return [...players];
  return [...players.slice(viewerIndex + 1), ...players.slice(0, viewerIndex)];
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
    // Cards face their OWNER: the card's top edge points from the player's
    // seat toward the table centre (like a real table). The opposite player
    // ends up 180° — upside down from my view, so the cards they know (their
    // bottom row) appear at the TOP of their hand from my perspective.
    // R = atan2(50 - xPct, yPct - 46) evaluated on the ellipse offsets:
    const facing = (Math.atan2(44 * Math.cos(rad), -34 * Math.sin(rad)) * 180) / Math.PI;
    // Keep the two upper-side seats above their decks when five people are
    // playing. Putting them on the fixed screen edges makes their avatars
    // look detached from the cards. The remaining seats sit at the sides.
    const whoSide: Seat['whoSide'] =
      angle >= 55 && angle <= 125 ? 'above' : angle < 90 ? 'right' : 'left';
    seats.push({
      angle,
      facing,
      whoSide,
      style: {
        left: `${xPct}%`,
        top: `${yPct}%`,
        transform: `translate(-50%, -50%)`,
      },
    });
  }
  return seats;
}
