/**
 * Table memory for Laya (prompt version 2): what a careful human player at the
 * table can know, rebuilt from the round's public event log and the viewer's
 * own knowledge. Nothing hidden is used: card ranks come only from events that
 * every player sees (discards, flushes, revealed misflushes) or from cards the
 * viewer itself has seen (view.knownCards).
 *
 *  - unseen pool: the 52-card deck minus every card whose identity the viewer
 *    knows (its own knowledge and every public discard/flush), by rank, with
 *    the mean value of an unseen card; this is the chance of a flush match and
 *    the expected value of any unknown card;
 *  - estimated totals: known values plus unknown cards at the unseen mean;
 *  - who has seen which card: card ids follow cards through swaps and
 *    transfers, so "Ada has seen your #2" stays true after the card moves;
 *  - recent actions: the last few public moves of every player, in words.
 */
import type { CaboPlayerView } from '@game-night/engine-cabo';
import type { Card } from '@game-night/shared';

type Ev = { type: string; playerId?: string; payload?: Record<string, unknown> };

const RANK = (r: number): string => ({ 1: 'A', 11: 'J', 12: 'Q', 13: 'K' } as Record<number, string>)[r] ?? String(r);
const cardValue = (c: Card): number => (c.rank === 13 ? (c.suit === 'hearts' || c.suit === 'diamonds' ? 13 : -1) : c.rank);
/** Mean value of a K whose colour is not known (two black at -1, two red at 13). */
const K_MEAN = 6;
/** Cards every player looks at during the deal (rules.initialPeekCards). */
const DEAL_PEEK = 2;

export interface TableMemory {
  unseen: Map<number, number>; // rank -> count not seen by the viewer
  unseenMean: number;
  unseenTotal: number;
  seenBy: Map<string, Set<string>>; // card id -> players who have seen it
  origin: Map<string, string>; // card id -> how it reached its hand ('kept' from the deck, or 'from <seat id>' in a swap)
  recent: string[];
}

function events(view: CaboPlayerView): Ev[] {
  return ((view as unknown as { events?: Ev[] }).events ?? []) as Ev[];
}

/** Name of a seat as the decision text uses it ("You", "Ada", ...). */
function nameOf(view: CaboPlayerView, me: string, pid: string | undefined): string {
  if (!pid) return '?';
  if (pid === me) return 'You';
  return view.players.find((p) => p.id === pid)?.name ?? pid;
}

/** "your #2", "Ada's #1": a card's current place, or "a card" once it has left every hand. */
function placeOf(view: CaboPlayerView, me: string, cid: string): string {
  for (const p of view.players) {
    const i = (view.handCardIds[p.id] ?? []).indexOf(cid);
    if (i >= 0) return p.id === me ? `your #${i + 1}` : `${p.name}'s #${i + 1}`;
  }
  return 'a card now gone';
}

export function tableMemory(view: CaboPlayerView, me: string, recentPerPlayer = 2): TableMemory {
  const ev = events(view);
  // ranks whose identity the viewer knows: its own knowledge + every public discard and flush
  const knownIds = new Set(Object.keys(view.knownCards));
  const goneRanks: number[] = [];
  const goneKs = { black: 0, red: 0, unknown: 0 };
  const seenBy = new Map<string, Set<string>>();
  const see = (cid: unknown, pid: unknown) => {
    if (typeof cid !== 'string' || typeof pid !== 'string') return;
    if (!seenBy.has(cid)) seenBy.set(cid, new Set());
    seenBy.get(cid)!.add(pid);
  };
  const origin = new Map<string, string>();
  const forget = (cid: unknown) => { if (typeof cid === 'string') { seenBy.delete(cid); origin.delete(cid); } };
  const lines = new Map<string, string[]>();
  const say = (pid: string | undefined, text: string) => {
    if (!pid) return;
    if (!lines.has(pid)) lines.set(pid, []);
    lines.get(pid)!.push(text);
  };
  const gone = (cid: unknown, rank: unknown) => {
    if (typeof rank !== 'number') return;
    if (typeof cid === 'string' && knownIds.has(cid)) return; // counted from knownCards
    goneRanks.push(rank);
    if (rank === 13) goneKs.unknown += 1;
  };
  for (const e of ev) {
    const p = (e.payload ?? {}) as Record<string, unknown>;
    const who = (p.playerId as string | undefined) ?? e.playerId;
    switch (e.type) {
      case 'CARD_DISCARDED':
        gone(p.cardId, p.rank);
        say(who, `drew and discarded ${RANK(p.rank as number)}`);
        break;
      case 'CARD_REPLACED':
        gone(p.replacedCardId, p.rank);
        forget(p.replacedCardId);
        see(p.keptCardId, who);
        if (typeof p.keptCardId === 'string' && who) origin.set(p.keptCardId, 'kept');
        say(who, `kept the drawn card as ${placeOf(view, me, p.keptCardId as string)}, threw ${RANK(p.rank as number)}`);
        break;
      case 'CARD_FLUSHED': {
        gone(p.cardId, p.rank);
        forget(p.cardId);
        const own = p.sourcePlayerId === who;
        say(who, own ? `flushed own ${RANK(p.rank as number)}` : `flushed ${nameOf(view, me, p.sourcePlayerId as string)}'s ${RANK(p.rank as number)}`);
        break;
      }
      case 'FAILED_FLUSH_OWN':
        for (const cid of (p.cardIds as string[]) ?? []) for (const q of view.players) see(cid, q.id);
        say(who, 'misflushed (card shown, penalty)');
        break;
      case 'FAILED_FLUSH_OTHER':
        say(who, `failed to flush ${placeOf(view, me, p.cardId as string)} (penalty)`);
        break;
      case 'POWER_RESOLVED':
        if (p.power === 'PEEK_OWN') { see(p.cardId, who); say(who, `peeked ${placeOf(view, me, p.cardId as string)}`); }
        else if (p.power === 'PEEK_OTHER') { see(p.cardId, who); say(who, `peeked ${placeOf(view, me, p.cardId as string)}`); }
        else if (p.power === 'BLIND_SWAP' && p.ownCardId) {
          if (typeof p.targetCardId === 'string') origin.set(p.targetCardId, `from ${p.targetPlayerId as string}`);
          if (typeof p.ownCardId === 'string' && who) origin.set(p.ownCardId, `from ${who}`);
          say(who, `swapped ${placeOf(view, me, p.targetCardId as string)} with ${placeOf(view, me, p.ownCardId as string)}`);
        }
        break;
      case 'CARD_TRANSFERRED':
        if (typeof p.cardId === 'string') origin.set(p.cardId, `from ${p.fromPlayerId as string}`);
        say(p.fromPlayerId as string, `gave a card to ${nameOf(view, me, p.toPlayerId as string)} (now ${placeOf(view, me, p.cardId as string)})`);
        break;
      case 'CABO_CALLED':
        say(who, p.auto ? 'ran out of cards (Cabo)' : 'called Cabo');
        break;
      default:
        break;
    }
  }
  // the unseen pool
  const unseen = new Map<number, number>();
  for (let r = 1; r <= 13; r++) unseen.set(r, 4);
  for (const c of Object.values(view.knownCards)) unseen.set(c.rank, (unseen.get(c.rank) ?? 0) - 1);
  for (const r of goneRanks) unseen.set(r, (unseen.get(r) ?? 0) - 1);
  for (const [r, n] of unseen) if (n < 0) unseen.set(r, 0);
  let total = 0, sum = 0;
  const knownKs = Object.values(view.knownCards).filter((c) => c.rank === 13);
  const blackLeft = Math.max(0, 2 - knownKs.filter((c) => cardValue(c) === -1).length);
  const redLeft = Math.max(0, 2 - knownKs.filter((c) => cardValue(c) === 13).length);
  for (const [r, n] of unseen) {
    total += n;
    if (r === 13) sum += n * (blackLeft + redLeft > 0 ? (blackLeft * -1 + redLeft * 13) / (blackLeft + redLeft) : K_MEAN);
    else sum += n * r;
  }
  const recent: string[] = [];
  for (const pl of view.players) {
    const l = lines.get(pl.id) ?? [];
    if (l.length) recent.push(`${nameOf(view, me, pl.id)}: ${l.slice(-recentPerPlayer).join('; ')}`);
  }
  return { unseen, unseenMean: total ? sum / total : 0, unseenTotal: total, seenBy, origin, recent };
}

/** The memory lines appended to the table text (prompt version 2). Kept short: Laya reads ~512 tokens. */
export function memoryText(view: CaboPlayerView, me: string): string {
  const m = tableMemory(view, me);
  const pool = [...m.unseen.entries()].filter(([, n]) => n > 0).map(([r, n]) => `${RANK(r)}×${n}`).join(' ');
  const out = [`Unseen cards (${m.unseenTotal}, mean ${m.unseenMean.toFixed(1)}): ${pool}.`];
  // what the others have seen of MY cards, and how much each opponent knows of its own hand
  const mine = (view.handCardIds[me] ?? []).map((cid, i) => {
    const s = [...(m.seenBy.get(cid) ?? [])].filter((p) => p !== me).map((p) => nameOf(view, me, p));
    return s.length ? `#${i + 1} seen by ${s.join(', ')}` : null;
  }).filter(Boolean);
  if (mine.length) out.push(`Your cards known to others: ${mine.join('; ')}.`);
  const est = view.players.filter((p) => p.id !== me).map((p) => {
    const ids = (view.handCardIds[p.id] ?? []).filter((c) => !c.startsWith('__slot__'));
    // cards seen since the deal, plus the two every player peeks at the deal (the events do not say which)
    const knownToThem = Math.min(ids.length, ids.filter((c) => m.seenBy.get(c)?.has(p.id)).length + DEAL_PEEK);
    let v = 0;
    for (const c of ids) v += view.knownCards[c] ? cardValue(view.knownCards[c]!) : m.unseenMean;
    return `${p.name} ≈${Math.round(v)} (knows ~${knownToThem}/${ids.length})`;
  });
  if (est.length) out.push(`Estimated totals: ${est.join(', ')}.`);
  // lasting facts about the cards still held: kept from the deck by the holder (usually low), or moved in from
  // another hand; these stay true however long ago they happened, unlike the recent actions below
  const notes = view.players.map((pl) => {
    const facts = (view.handCardIds[pl.id] ?? []).map((cid, i) => {
      const o = m.origin.get(cid);
      if (!o) return null;
      return `#${i + 1} ${o === 'kept' ? 'kept from deck' : `from ${nameOf(view, me, o.slice(5))}`}`;
    }).filter(Boolean);
    return facts.length ? `${nameOf(view, me, pl.id)}: ${facts.join(', ')}` : null;
  }).filter(Boolean);
  if (notes.length) out.push(`Hand history: ${notes.join(' | ')}.`);
  if (m.recent.length) out.push(`Recent: ${m.recent.join(' | ')}.`);
  return out.join('\n');
}
