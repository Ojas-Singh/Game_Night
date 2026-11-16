/**
 * What a Cabo seat can work out about the cards it has not seen.
 *
 * Everything here is read from the seat's own view: the cards it knows and
 * the public event log. From the log it follows, for every card still in a
 * hand,
 *
 *   - whether its owner knows it (looked at it at the start, kept it from the
 *     deck, or peeked at it), and
 *   - a ceiling on its value: a card kept from the deck was better than the
 *     one thrown out for it, and a player who throws a drawn card away holds
 *     no card they know to be worse than it.
 *
 * `chanceCallWins` deals the unseen cards many times within those ceilings
 * and plays the round that follows a Cabo call in each deal.
 */

import type { Card } from '@game-night/shared';
import type { CaboPlayerView } from '@game-night/engine-cabo';

type Rng = { next(): number };

export function cardValue(c: Card): number {
  if (c.rank === 13) return c.suit === 'spades' || c.suit === 'clubs' ? -1 : 13;
  return c.rank;
}

const isRealCard = (id: string): boolean => !id.startsWith('__slot__');

/** A card of unknown face: its rank and what it scores. */
interface Face {
  rank: number;
  value: number;
}

export interface Beliefs {
  /** Faces not accounted for: the deck and every card the seat has not seen. */
  pool: Face[];
  /** Mean value of `pool`. */
  poolMean: number;
  /** Highest value the card can have, for cards with a ceiling. */
  ceiling: Map<string, number>;
  /** Whether the player holding the card knows it. */
  ownerKnows(cardId: string): boolean;
  /** Expected value of a card to this seat. */
  expected(cardId: string): number;
}

const str = (x: unknown): string | undefined => (typeof x === 'string' ? x : undefined);

export function readBeliefs(view: CaboPlayerView, selfId: string): Beliefs {
  const inHand = new Map<string, { owner: string; slot: number }>();
  for (const p of view.players) {
    (view.handCardIds[p.id] ?? []).forEach((id, slot) => {
      if (isRealCard(id)) inHand.set(id, { owner: p.id, slot });
    });
  }

  // Cards the log has named are followed from hand to hand; the others have
  // lain where they were dealt, so the two bottom ones (slots 1 and 3) were
  // looked at by their owner at the start.
  const owner = new Map<string, string>();
  const knownBy = new Map<string, Set<string>>();
  const ceiling = new Map<string, number>();
  const seen = new Array<number>(14).fill(0);
  const learn = (cardId: string, playerId: string): void => {
    let set = knownBy.get(cardId);
    if (!set) knownBy.set(cardId, (set = new Set()));
    set.add(playerId);
  };
  const moved = (cardId: string): boolean => owner.has(cardId);
  const knows = (playerId: string, cardId: string): boolean => {
    if (knownBy.get(cardId)?.has(playerId)) return true;
    const at = inHand.get(cardId);
    return !moved(cardId) && !!at && at.owner === playerId && (at.slot === 1 || at.slot === 3);
  };
  const holds = (playerId: string, cardId: string): boolean =>
    moved(cardId) ? owner.get(cardId) === playerId : inHand.get(cardId)?.owner === playerId;
  const lower = (cardId: string, to: number): void => {
    ceiling.set(cardId, Math.min(ceiling.get(cardId) ?? 13, to));
  };

  for (const e of view.events) {
    const p = e.payload ?? {};
    const actor = str(p.playerId);
    const rank = typeof p.rank === 'number' ? p.rank : 0;
    switch (e.type) {
      case 'ROUND_STARTED':
        owner.clear();
        knownBy.clear();
        ceiling.clear();
        seen.fill(0);
        break;
      case 'DECK_RESHUFFLED':
        seen.fill(0);
        break;
      case 'CARD_REPLACED': {
        const kept = str(p.keptCardId);
        const out = str(p.replacedCardId);
        seen[rank] = (seen[rank] ?? 0) + 1;
        if (!kept || !actor) break;
        if (out) owner.set(out, '');
        owner.set(kept, actor);
        learn(kept, actor);
        // Kept because it beat the card thrown out, or an unknown card's average.
        lower(kept, Math.max(rank, 7) - 1);
        break;
      }
      case 'CARD_DISCARDED': {
        seen[rank] = (seen[rank] ?? 0) + 1;
        if (!actor) break;
        // Thrown away rather than kept: nothing this player knows they hold is worse.
        for (const id of inHand.keys()) {
          if (holds(actor, id) && knows(actor, id)) lower(id, rank);
        }
        break;
      }
      case 'CARD_FLUSHED':
        seen[rank] = (seen[rank] ?? 0) + 1;
        if (str(p.cardId)) owner.set(str(p.cardId)!, '');
        break;
      case 'CARD_TRANSFERRED':
        if (str(p.cardId) && str(p.toPlayerId)) owner.set(str(p.cardId)!, str(p.toPlayerId)!);
        break;
      case 'POWER_RESOLVED': {
        if (!actor) break;
        if (p.power === 'PEEK_OWN' || p.power === 'PEEK_OTHER') {
          if (str(p.cardId)) learn(str(p.cardId)!, actor);
        } else if (p.power === 'BLIND_SWAP' && str(p.ownCardId) && str(p.targetCardId) && str(p.targetPlayerId)) {
          // Both cards must be placed before either is marked as moved.
          const mine = str(p.ownCardId)!;
          const theirs = str(p.targetCardId)!;
          owner.set(mine, str(p.targetPlayerId)!);
          owner.set(theirs, actor);
        }
        break;
      }
      default:
        break;
    }
  }

  // The faces left over once the discard pile and the cards this seat knows are taken out.
  const left = new Array<number>(14).fill(4);
  let blackKings = 2;
  for (let r = 1; r <= 13; r++) left[r] = Math.max(0, 4 - seen[r]!);
  for (const id of inHand.keys()) {
    const c = view.knownCards[id];
    if (!c) continue;
    left[c.rank] = Math.max(0, left[c.rank]! - 1);
    if (c.rank === 13 && cardValue(c) < 0) blackKings -= 1;
  }
  if (view.drawnCard) left[view.drawnCard.rank] = Math.max(0, left[view.drawnCard.rank]! - 1);
  const pool: Face[] = [];
  for (let r = 1; r <= 12; r++) for (let i = 0; i < left[r]!; i++) pool.push({ rank: r, value: r });
  // A king thrown away was almost surely a red one.
  for (let i = 0; i < left[13]!; i++) pool.push({ rank: 13, value: i < Math.max(0, blackKings) ? -1 : 13 });
  const poolMean = pool.length > 0 ? pool.reduce((a, f) => a + f.value, 0) / pool.length : 6.5;

  const expected = (cardId: string): number => {
    const c = view.knownCards[cardId];
    if (c) return cardValue(c);
    const top = ceiling.get(cardId);
    if (top === undefined) return poolMean;
    let sum = 0;
    let n = 0;
    for (const f of pool) {
      if (f.value <= top) {
        sum += f.value;
        n += 1;
      }
    }
    return n > 0 ? sum / n : Math.min(top, poolMean);
  };

  return {
    pool,
    poolMean,
    ceiling,
    ownerKnows: (cardId) => {
      const at = inHand.get(cardId);
      return !!at && knows(at.owner, cardId);
    },
    expected,
  };
}

/** One hand in one deal of the unseen cards. */
interface DealtCard extends Face {
  /** Its holder knows what it is. */
  known: boolean;
}

/**
 * Chance that `selfId` ends with the lowest hand if it calls Cabo now: the
 * unseen cards are dealt `samples` times and every other player takes the one
 * turn the call leaves them. They play as a careful player does: keep the
 * drawn card when it beats the worst card they know of, get rid of a card
 * matching a discard, and use a swap to hand the caller their worst card.
 * The caller wins a tie for the lowest hand.
 */
export function chanceCallWins(
  view: CaboPlayerView,
  selfId: string,
  beliefs: Beliefs,
  rng: Rng,
  samples = 300,
): number {
  const seats = view.players.filter((p) => p.cardCount > 0 || p.id === selfId);
  const me = seats.findIndex((p) => p.id === selfId);
  if (me < 0) return 0;
  const order = seats.map((_, i) => seats[(me + i) % seats.length]!);
  // Cards to deal, the most restricted first so that their ceilings can be met.
  const unknown: Array<{ seat: number; top: number; known: boolean }> = [];
  const fixed: DealtCard[][] = order.map(() => []);
  order.forEach((p, seat) => {
    for (const id of view.handCardIds[p.id] ?? []) {
      if (!isRealCard(id)) continue;
      const c = view.knownCards[id];
      const known = beliefs.ownerKnows(id);
      if (c) fixed[seat]!.push({ rank: c.rank, value: cardValue(c), known });
      else unknown.push({ seat, top: beliefs.ceiling.get(id) ?? 13, known });
    }
  });
  unknown.sort((a, b) => a.top - b.top);

  let wins = 0;
  for (let s = 0; s < samples; s++) {
    const pool = [...beliefs.pool];
    const take = (top: number): Face => {
      if (pool.length === 0) return { rank: 7, value: 7 };
      let pick = -1;
      let count = 0;
      for (let i = 0; i < pool.length; i++) {
        if (pool[i]!.value <= top) {
          count += 1;
          if (rng.next() * count < 1) pick = i;
        }
      }
      if (pick < 0) pick = Math.floor(rng.next() * pool.length);
      const face = pool[pick]!;
      pool[pick] = pool[pool.length - 1]!;
      pool.pop();
      return face;
    };
    const hands = fixed.map((h) => h.map((c) => ({ ...c })));
    for (const u of unknown) hands[u.seat]!.push({ ...take(u.top), known: u.known });

    const mean = beliefs.poolMean;
    for (let seat = 1; seat < hands.length; seat++) {
      const hand = hands[seat]!;
      if (hand.length === 0) continue;
      const drawn = take(13);
      let worst = 0;
      const guess = (c: DealtCard): number => (c.known ? c.value : mean);
      for (let i = 1; i < hand.length; i++) if (guess(hand[i]!) > guess(hand[worst]!)) worst = i;
      let thrown: Face;
      if (drawn.value < guess(hand[worst]!)) {
        thrown = hand[worst]!;
        hand[worst] = { ...drawn, known: true };
      } else {
        thrown = drawn;
        if ((drawn.rank === 11 || drawn.rank === 12) && hands[0]!.length > 0) {
          const mine = Math.floor(rng.next() * hands[0]!.length);
          const given = hand[worst]!;
          hand[worst] = { ...hands[0]![mine]!, known: false };
          hands[0]![mine] = { ...given, known: false };
        }
      }
      // Anyone still to play, or who has just played, drops a known match.
      for (let other = 1; other < hands.length; other++) {
        const at = hands[other]!.findIndex((c) => c.known && c.rank === thrown.rank && c.value >= 0);
        if (at >= 0) hands[other]!.splice(at, 1);
      }
    }

    const totals = hands.map((h) => h.reduce((a, c) => a + c.value, 0));
    if (totals[0] === Math.min(...totals)) wins += 1;
  }
  return wins / samples;
}
