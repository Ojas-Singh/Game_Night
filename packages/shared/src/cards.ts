/**
 * Core card primitives shared by every card game on the platform.
 * These types are game-agnostic; game-specific meaning (values, powers)
 * lives in each game's rules definition.
 */

export type Suit = 'spades' | 'hearts' | 'diamonds' | 'clubs';

export const SUITS: readonly Suit[] = ['spades', 'hearts', 'diamonds', 'clubs'] as const;

export type Color = 'red' | 'black';

export function colorOf(suit: Suit): Color {
  return suit === 'hearts' || suit === 'diamonds' ? 'red' : 'black';
}

/** Rank label. Numeric ranks are stored as their number 1..10. */
export type Rank = 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8 | 9 | 10 | 11 | 12 | 13;

export const RANK_LABELS: Record<Rank, string> = {
  1: 'A',
  2: '2',
  3: '3',
  4: '4',
  5: '5',
  6: '6',
  7: '7',
  8: '8',
  9: '9',
  10: '10',
  11: 'J',
  12: 'Q',
  13: 'K',
};

/**
 * A concrete card instance. Every physical card in a game carries a unique,
 * stable id so clients can track animations and the server can reference
 * cards in events without leaking hidden values.
 */
export interface Card {
  /** Unique card instance id, e.g. "c-17". Stable across the whole round. */
  id: string;
  suit: Suit;
  rank: Rank;
}

export function cardLabel(card: Card): string {
  const suitGlyph = { spades: '♠', hearts: '♥', diamonds: '♦', clubs: '♣' }[card.suit];
  return `${RANK_LABELS[card.rank]}${suitGlyph}`;
}

/** A full 52-card deck, no jokers, in canonical suit/rank order. */
export function standardDeck(): Card[] {
  const cards: Card[] = [];
  let n = 0;
  for (const suit of SUITS) {
    for (let rank = 1 as Rank; rank <= 13; rank = (rank + 1) as Rank) {
      cards.push({ id: `c-${n++}`, suit, rank });
    }
  }
  return cards;
}
