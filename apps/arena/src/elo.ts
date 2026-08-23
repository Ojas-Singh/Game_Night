/**
 * Elo ladder — online rating updates across episodes. Multi-player games are
 * scored pairwise (each participant vs every other), the standard practical
 * approximation for N-player games.
 */

export interface LadderState {
  ratings: Record<string, number>;
  games: Record<string, number>;
}

const DEFAULT_RATING = 1000;
const K = 24;

export class EloLadder {
  readonly state: LadderState;

  constructor(initial?: LadderState) {
    this.state = initial ?? { ratings: {}, games: {} };
  }

  rating(agentId: string): number {
    return this.state.ratings[agentId] ?? DEFAULT_RATING;
  }

  private ensure(agentId: string): void {
    if (this.state.ratings[agentId] == null) this.state.ratings[agentId] = DEFAULT_RATING;
    this.state.games[agentId] = this.state.games[agentId] ?? 0;
  }

  /** outcome: 1 win, 0 loss, 0.5 tie — for ONE participant vs each other. */
  recordGame(agentIds: string[], outcomeFor: (id: string) => number): void {
    for (const id of agentIds) this.ensure(id);
    const deltas = new Map<string, number>();
    for (const a of agentIds) deltas.set(a, 0);
    for (let i = 0; i < agentIds.length; i++) {
      for (let j = i + 1; j < agentIds.length; j++) {
        const a = agentIds[i]!;
        const b = agentIds[j]!;
        const sA = outcomeFor(a);
        const sB = 1 - sA;
        const ea = 1 / (1 + 10 ** ((this.rating(b) - this.rating(a)) / 400));
        const eb = 1 - ea;
        deltas.set(a, deltas.get(a)! + K * (sA - ea));
        deltas.set(b, deltas.get(b)! + K * (sB - eb));
      }
    }
    for (const [id, d] of deltas) {
      this.state.ratings[id] = Math.round(this.rating(id) + d);
      this.state.games[id]! += 1;
    }
  }

  standings(): Array<{ id: string; rating: number; games: number }> {
    return Object.entries(this.state.ratings)
      .map(([id, rating]) => ({ id, rating, games: this.state.games[id] ?? 0 }))
      .sort((a, b) => b.rating - a.rating);
  }
}
