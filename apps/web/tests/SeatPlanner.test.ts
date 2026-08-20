import { describe, expect, it } from 'vitest';
import SeatPlanner from '../src/table/SeatPlanner.js';

/** Extract left/top percentages from a seat style. */
function pos(style: React.CSSProperties): { left: number; top: number } {
  const left = parseFloat(String(style.left).replace('%', ''));
  const top = parseFloat(String(style.top).replace('%', ''));
  return { left, top };
}

describe('SeatPlanner (player POV around the ellipse)', () => {
  it('produces exactly one seat per opponent', () => {
    for (let n = 1; n <= 5; n++) {
      expect(SeatPlanner(n)).toHaveLength(n);
    }
  });

  it('2 players: the single opponent sits at the top center (opposite you)', () => {
    const [seat] = SeatPlanner(1);
    const { left, top } = pos(seat!.style);
    expect(left).toBeCloseTo(50, 0);
    expect(top).toBeLessThan(20); // upper area of the table
  });

  it('all seats stay inside the table bounds', () => {
    for (let n = 1; n <= 5; n++) {
      for (const seat of SeatPlanner(n)) {
        const { left, top } = pos(seat.style);
        expect(left).toBeGreaterThan(0);
        expect(left).toBeLessThan(100);
        expect(top).toBeGreaterThan(0);
        expect(top).toBeLessThan(60); // opponents never intrude on the player's bottom area
      }
    }
  });

  it('fans opponents symmetrically around the top arc', () => {
    const seats = SeatPlanner(3);
    const positions = seats.map((s) => pos(s.style));
    // Symmetry: mirror around the horizontal center for evenly indexed pairs.
    const leftmost = positions[0]!.left;
    const rightmost = positions[2]!.left;
    expect(leftmost + rightmost).toBeCloseTo(100, 0);
    // Middle opponent centered.
    expect(positions[1]!.left).toBeCloseTo(50, 0);
  });

  it('more opponents spread wider across the arc', () => {
    const narrow = SeatPlanner(1).map((s) => pos(s.style).left);
    const wide = SeatPlanner(5).map((s) => pos(s.style).left);
    const narrowSpan = Math.max(...narrow) - Math.min(...narrow);
    const wideSpan = Math.max(...wide) - Math.min(...wide);
    expect(wideSpan).toBeGreaterThan(narrowSpan);
  });

  it('angles increase monotonically left to right', () => {
    const seats = SeatPlanner(4);
    for (let i = 1; i < seats.length; i++) {
      expect(seats[i]!.angle).toBeGreaterThan(seats[i - 1]!.angle);
    }
  });
});
