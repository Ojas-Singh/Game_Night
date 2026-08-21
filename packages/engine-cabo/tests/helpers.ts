import type { Card, GamePlayer, Rank, Suit } from '@game-night/shared';
import { CaboEngine, type CaboRules } from '../src/index.js';

export const c = (id: string, suit: Suit, rank: Rank): Card => ({ id, suit, rank });
export const S = 'spades' as const;
export const H = 'hearts' as const;
export const D = 'diamonds' as const;
export const CL = 'clubs' as const;

export function players(n: number): GamePlayer[] {
  return Array.from({ length: n }, (_, i) => ({
    id: `p${i + 1}`,
    name: `Player ${i + 1}`,
    seat: i,
  }));
}

/**
 * Create an engine with a forced deck given in POP order: the first card in
 * `order` is the first card dealt/taken from the deck.
 *
 * Deal order for N players is round-robin: with 3 players and 4 starting
 * cards, player1's hand is [order[0], order[3], order[6], order[9]], etc.
 * The first post-deal draw is order[12].
 */
export function setup(order: Card[], opts?: { rules?: Partial<CaboRules>; players?: number }): CaboEngine {
  const engine = new CaboEngine();
  engine.createGame(players(opts?.players ?? 3), {
    forcedDeck: order.slice().reverse(),
    rules: opts?.rules,
  });
  return engine;
}

/** Actual cards in a (possibly gap-riddled sparse) hand. */
export const live = (hand: (Card | null)[]): Card[] => hand.filter((c): c is Card => !!c);

/** Everyone completes their initial peek (first two cards). */
export function peekAll(engine: CaboEngine, indexes = [0, 1]): void {
  const s = engine.getState();
  for (const p of s.players) {
    engine.handleAction({ type: 'PEEK_STARTING', playerId: p.id, cardIndexes: indexes });
  }
}

export function act(engine: CaboEngine, action: Parameters<CaboEngine['handleAction']>[0]) {
  return engine.handleAction(action);
}

export function mustFail(engine: CaboEngine, action: Parameters<CaboEngine['handleAction']>[0], msg?: string) {
  const res = engine.handleAction(action);
  if (res.ok) throw new Error(`expected action ${action.type} to fail${msg ? ` (${msg})` : ''}`);
  return res;
}

export function mustOk(engine: CaboEngine, action: Parameters<CaboEngine['handleAction']>[0]) {
  const res = engine.handleAction(action);
  if (!res.ok) throw new Error(`expected action ${action.type} to succeed, got: ${res.error}`);
  return res;
}
