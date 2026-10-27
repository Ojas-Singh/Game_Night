// Trick suite for Laya-on-Cabo: does the agent play the known-right move in a position that tests one skill?
//
// Every scenario starts from a real seeded game (heuristic bots play until it is seat p0's turn to draw), then edits
// a copy of the engine state: cards change identity only by swapping rank/suit with another card (ids stay unique and
// the 52-card multiset stays valid), p0's knowledge is set to exactly the cards the scenario says p0 has seen, and the
// public event log is rewritten to match (so prompt version 2's table memory reads the same story). Engine actions then
// drive the position to the phase under test (draw, discard a power card, flush, ...). Each scenario names the right
// move(s) by a predicate on the action.
//
// The right answer is checked independently by rollouts (as teacher.mjs: re-deal what p0 cannot see, apply each
// move, play the round out, payoff 0.8 x win + 0.2 x margin, common random numbers, default 1024 rollouts). The
// rollout bots are the heuristic bot with two artifacts removed (fairBots): unknown slots and tied victims are picked
// at random instead of "first slot / lowest seat" (the plain bot makes p0's #1 the target of every blind swap), and
// p0 itself calls Cabo only at an estimated total <= --cabo-max (default 10) instead of at almost every turn end.
// Scenarios marked `memory` hinge on table history: either public history the v1 prompt does not show (the discard
// pile), which the determinization already respects, or a hint about hidden cards (an opponent kept a drawn card in a
// slot), for which the rollouts use a `prior` that re-deals consistently with it. Status per scenario: agree (best
// right move beats the best wrong move by > 2 SE), weak (within 2 SE), disagree (worse by > 2 SE). Agree and weak are
// scored; disagree is listed and skipped. The teacher baseline uses the plain heuristic bots, like eval.mjs.
//
// usage: node tricks.mjs <agent> [--batch] [--json out.json] [--rollouts N] [--cabo-max N] [--show] [--only id,id]
//        node tricks.mjs --check [--rollouts N] [--show] [--json out.json]   (construction checks + validation only)
//   agent: heuristic | teacher:<rollouts> | [laya:]http://host:port[#p2]   (#p2: model trained on prompt version 2)
//   --batch: one POST /batch for all scenarios (batch_server.py); otherwise POST /decide per scenario (laya_server.py)
//   --show: print each position as the model reads it (prompt version 2 text) with every move's rollout value
import { writeFileSync } from 'node:fs';
import { CaboHeuristicBot, layaRelabelView } from '@game-night/agent-bots';
import {
  actorOf, buildDecision, candidateMoves, createAgentRng, decisionText, describeAction, determinize, engineFrom,
  heuristicBots, newGame, payoff, playOut,
} from './cabo-common.mjs';

const ME = 'p0';

// ---------------------------------------------------------------------------------------------------------------
// Cards
// ---------------------------------------------------------------------------------------------------------------
const SUITS = { '♥': 'hearts', '♦': 'diamonds', '♠': 'spades', '♣': 'clubs' };
const value = (c) => (c.rank === 13 ? (c.suit === 'hearts' || c.suit === 'diamonds' ? 13 : -1) : c.rank);
const powerOf = (r) => (r === 7 || r === 8 ? 'PEEK_OWN' : r === 9 || r === 10 ? 'PEEK_OTHER' : r === 11 || r === 12 ? 'BLIND_SWAP' : null);

/** '9', 'A', 'Q', 'Kb' (black king, -1), 'Kr' (red king, 13), or with a suit symbol: '5♠'. */
function parseSpec(spec) {
  const m = String(spec).match(/^(A|J|Q|K|\d{1,2})(r|b|♥|♦|♠|♣)?$/);
  if (!m) throw new Error(`bad card spec ${spec}`);
  const rank = { A: 1, J: 11, Q: 12, K: 13 }[m[1]] ?? Number(m[1]);
  let suits = ['hearts', 'diamonds', 'spades', 'clubs'];
  if (m[2] === 'r') suits = ['hearts', 'diamonds'];
  else if (m[2] === 'b') suits = ['spades', 'clubs'];
  else if (m[2]) suits = [SUITS[m[2]]];
  if (rank === 13 && !m[2]) throw new Error('say Kb or Kr: a king needs its colour');
  return { rank, suits };
}

function allCards(s) {
  return [
    ...s.deck, ...s.discard, ...(s.drawnCard ? [s.drawnCard] : []),
    ...Object.values(s.hands).flatMap((h) => h.filter(Boolean)),
  ];
}

/** 52 distinct ids and 52 distinct rank/suit pairs, 4 of each rank. */
function checkDeck(s) {
  const cards = allCards(s);
  const ids = new Set(cards.map((c) => c.id));
  const faces = new Set(cards.map((c) => `${c.rank}/${c.suit}`));
  if (cards.length !== 52 || ids.size !== 52 || faces.size !== 52) {
    throw new Error(`card multiset broken: ${cards.length} cards, ${ids.size} ids, ${faces.size} faces`);
  }
}

// ---------------------------------------------------------------------------------------------------------------
// Scenario construction
// ---------------------------------------------------------------------------------------------------------------
/** Events in which `pid` drew and threw a card that is still in the discard pile (one per past turn). */
function throwEvents(s, pid) {
  const inDiscard = new Set(s.discard.slice(0, -1).map((c) => c.id));
  return s.events.filter((e) => (e.type === 'CARD_DISCARDED' || e.type === 'CARD_REPLACED')
    && (e.payload?.playerId ?? e.playerId) === pid
    && inDiscard.has(e.payload.cardId ?? e.payload.replacedCardId));
}

const fourEach = (s) => Object.values(s.hands).every((h) => h.length === 4 && h.every(Boolean));

/** Does `e` (by another seat) touch p0's current cards, or move cards to/from p0? */
function touchesMe(e, mine) {
  const p = e.payload ?? {};
  if (p.targetPlayerId === ME || p.toPlayerId === ME || p.fromPlayerId === ME) return true;
  if ((p.playerId ?? e.playerId) === ME) return p.power === 'BLIND_SWAP' && !!p.ownCardId;
  return [p.keptCardId, p.cardId, p.ownCardId, p.targetCardId, ...(p.cardIds ?? [])].some((id) => mine.has(id));
}

/** No other seat has seen, peeked, swapped or kept any of p0's current cards (the scenario decides who saw what). */
function untouched(s) {
  const mine = new Set(s.hands[ME].map((c) => c.id));
  if (s.players.some((p) => p.id !== ME && s.knowledge[p.id].some((id) => mine.has(id)))) return false;
  return !s.events.some((e) => touchesMe(e, mine));
}

/** Fallback for long histories: forget the others' knowledge of p0's cards and drop the events that touched them. */
function sanitize(s) {
  const mine = new Set(s.hands[ME].map((c) => c.id));
  for (const p of s.players) if (p.id !== ME) s.knowledge[p.id] = s.knowledge[p.id].filter((id) => !mine.has(id));
  s.events = s.events.filter((e) => !touchesMe(e, mine));
  s.events.forEach((e, i) => { e.seq = i + 1; });
  s.eventSeq = s.events.length;
  return s;
}

/** Play a seeded heuristic game until p0 must draw with 4-card hands and enough history. Prefer a history in which
 *  nobody touched p0's cards; long histories (many discards) fall back to a sanitized one. */
function baseState(nPlayers, seed, minDiscard = 4, needThrows = {}) {
  for (const strict of [true, false]) {
    for (let k = 0; k < (strict ? 3000 : 400); k++) {
      const sd = seed + k * 7919;
      const players = Array.from({ length: nPlayers }, (_, i) => ({ id: `p${i}`, name: `P${i}`, seat: i }));
      const e = newGame(players, sd);
      const bots = heuristicBots(players);
      const rng = createAgentRng(sd);
      for (let step = 0; step < 400; step++) {
        const s = e.getState();
        const who = actorOf(s);
        if (!who || s.cabo) break;
        if (who === ME && s.phase === 'TURN_DRAW' && fourEach(s) && s.discard.length >= minDiscard
          && Object.entries(needThrows).every(([pid, n]) => throwEvents(s, pid).length >= n)) {
          if (untouched(s)) return { state: structuredClone(s), seed: sd };
          if (!strict) return { state: sanitize(structuredClone(s)), seed: sd, sanitized: true };
        }
        const view = e.getPlayerState(who);
        let action;
        try { action = bots[who].decide({ gameId: 'cabo', selfId: who, view, step }, { rng }).action; } catch { break; }
        // the bots call Cabo very early (2 players: after one turn); the base game only needs history, so play on
        if (action.type === 'CALL_CABO') action = { type: 'END_TURN', playerId: who };
        if (!e.handleAction({ ...action, playerId: who }).ok) break;
      }
    }
  }
  throw new Error(`no base game for ${nPlayers}p seed ${seed}`);
}

/** Editing helper over a cloned state. */
class Table {
  constructor(s) {
    this.s = s;
    this.locked = new Set();
    this.actions = [];
    this.usedEvents = new Set();
  }
  hand(pid) { return this.s.hands[pid]; }
  top() { return this.s.discard[this.s.discard.length - 1]; }
  deckTop() { return this.s.deck[this.s.deck.length - 1]; }

  /** Give `card` the identity `spec` by swapping rank/suit with the free card that has it. */
  set(card, spec) {
    const { rank, suits } = parseSpec(spec);
    if (this.locked.has(card.id)) throw new Error(`card ${card.id} already set`);
    if (!(card.rank === rank && suits.includes(card.suit))) {
      const s = this.s;
      const p0Known = new Set(s.knowledge[ME]);
      // prefer cards nobody has seen: deck, then hidden hand cards, then the discard history, then the top
      const pool = [
        ...s.deck.map((c) => [c, 0]),
        ...Object.values(s.hands).flatMap((h) => h.filter(Boolean).map((c) => [c, p0Known.has(c.id) ? 3 : 1])),
        ...s.discard.map((c, i) => [c, i === s.discard.length - 1 ? 5 : 2]),
      ];
      const cand = pool
        .filter(([c]) => c.id !== card.id && !this.locked.has(c.id) && c.rank === rank && suits.includes(c.suit))
        .sort((a, b) => a[1] - b[1]);
      if (!cand.length) throw new Error(`no free card for ${spec}`);
      const o = cand[0][0];
      [card.rank, o.rank] = [o.rank, card.rank];
      [card.suit, o.suit] = [o.suit, card.suit];
    }
    this.locked.add(card.id);
    return card;
  }

  /** Put a card of `spec` into the discard history (below the top). */
  toDiscard(spec) {
    const c = this.s.discard.slice(0, -1).find((x) => !this.locked.has(x.id));
    if (!c) throw new Error('discard pile too short');
    return this.set(c, spec);
  }

  /** p0 has seen exactly these cards (its own or others'). */
  p0Knows(...cards) {
    const ids = cards.map((c) => c.id);
    this.s.knowledge[ME] = ids;
    this.s.initialPeekCardIds[ME] = (this.s.initialPeekCardIds[ME] ?? []).filter((id) => ids.includes(id));
  }

  know(pid, ...cards) {
    for (const c of cards) if (!this.s.knowledge[pid].includes(c.id)) this.s.knowledge[pid].push(c.id);
  }

  /** Rewrite one of `pid`'s past turns as "kept the drawn card in `slotCard`'s place, threw a high card". */
  keptInto(pid, slotCard, thrown = ['Kr', '9', '10', 'J', 'Q', '8']) {
    const ev = throwEvents(this.s, pid).filter((e) => !this.usedEvents.has(e.seq)).reverse();
    for (const e of ev) {
      const tid = e.payload.cardId ?? e.payload.replacedCardId;
      const card = this.s.discard.find((c) => c.id === tid);
      if (this.locked.has(tid)) continue;
      // keep the event log coherent: a thrown power card was followed by its power, so keep the power class
      const spec = thrown.find((sp) => powerOf(parseSpec(sp).rank) === powerOf(card.rank));
      if (!spec) continue;
      try { this.set(card, spec); } catch { continue; }
      this.usedEvents.add(e.seq);
      e.type = 'CARD_REPLACED';
      e.payload = { playerId: pid, keptCardId: slotCard.id, replacedCardId: tid, rank: card.rank };
      this.know(pid, slotCard);
      return;
    }
    throw new Error(`no past turn of ${pid} to rewrite`);
  }

  /** Insert a public event just before p0's current turn started. */
  inject(type, payload) {
    const ev = this.s.events;
    let at = ev.length;
    for (let i = ev.length - 1; i >= 0; i--) if (ev[i].type === 'TURN_STARTED') { at = i; break; }
    ev.splice(at, 0, { seq: 0, type, playerId: payload.playerId, timestamp: ev[at - 1]?.timestamp, payload });
    ev.forEach((e, i) => { e.seq = i + 1; });
    this.s.eventSeq = ev.length;
  }

  act(pid, action) { this.actions.push([pid, action]); }

  /** Rewrite event ranks to the edited identities, check the deck, apply the queued actions. */
  finish() {
    const s = this.s;
    // p0's own history must agree with what the scenario says p0 knows: a kept card p0 no longer "knows" becomes a
    // plain draw-and-discard, and peeks at cards p0 no longer knows are dropped.
    const k0 = new Set(s.knowledge[ME]);
    const inHand = new Set(Object.values(s.hands).flatMap((h) => h.filter(Boolean).map((c) => c.id)));
    s.events = s.events.filter((e) => {
      const p = e.payload ?? {};
      if ((p.playerId ?? e.playerId) !== ME) return true;
      if (e.type === 'CARD_REPLACED' && !k0.has(p.keptCardId)) {
        e.type = 'CARD_DISCARDED';
        e.payload = { playerId: ME, cardId: p.replacedCardId, rank: p.rank };
      }
      if (e.type === 'POWER_RESOLVED' && (p.power === 'PEEK_OWN' || p.power === 'PEEK_OTHER') && inHand.has(p.cardId) && !k0.has(p.cardId)) return false;
      return true;
    });
    s.events.forEach((e, i) => { e.seq = i + 1; });
    s.eventSeq = s.events.length;
    const byId = new Map(allCards(s).map((c) => [c.id, c]));
    for (const e of s.events) {
      const p = e.payload;
      if (!p) continue;
      if (typeof p.rank === 'number') {
        const id = p.cardId ?? p.replacedCardId ?? p.sourceCardId;
        if (byId.has(id)) p.rank = byId.get(id).rank;
      }
      if (Array.isArray(p.ranks) && Array.isArray(p.cardIds)) p.ranks = p.cardIds.map((id, i) => byId.get(id)?.rank ?? p.ranks[i]);
    }
    checkDeck(s);
    const e = engineFrom(s);
    for (const [pid, a] of this.actions) {
      const r = e.handleAction({ ...a, playerId: pid });
      if (!r.ok) throw new Error(`setup action ${a.type} failed: ${r.error}`);
    }
    return e.getState();
  }
}

/** Re-deal p0-hidden cards so that `cardId` has value <= max (swap with a random hidden low card). */
function constrainLow(world, cardIds, max, rng) {
  const known = new Set(world.knowledge[ME]);
  const hidden = [...Object.values(world.hands).flatMap((h) => h.filter(Boolean)), ...world.deck]
    .filter((c) => !known.has(c.id));
  const fixed = new Set();
  for (const id of cardIds) {
    const c = hidden.find((x) => x.id === id);
    if (!c) continue;
    if (value(c) > max) {
      const low = hidden.filter((x) => value(x) <= max && !fixed.has(x.id) && !cardIds.includes(x.id));
      if (low.length) {
        const o = low[Math.floor(rng.next() * low.length)];
        [c.rank, o.rank] = [o.rank, c.rank];
        [c.suit, o.suit] = [o.suit, c.suit];
      }
    }
    fixed.add(id);
  }
}

// ---------------------------------------------------------------------------------------------------------------
// The scenarios. build(t) edits the table and returns refs (card ids) used by `right` and `prior`.
// ---------------------------------------------------------------------------------------------------------------
const draw = (t) => t.act(ME, { type: 'DRAW' });
const drawAndDiscard = (t) => { t.act(ME, { type: 'DRAW' }); t.act(ME, { type: 'DISCARD_DRAWN' }); };
const isSwap = (a) => a.type === 'POWER_APPLY' && a.payload.power === 'BLIND_SWAP';

export const SCENARIOS = [
  {
    id: 'flush-own', players: 3, seed: 101, phase: 'DRAW_DECISION',
    trick: 'flush your own known card matching the discard top before keeping/discarding the drawn card',
    build(t) {
      const h = t.hand(ME);
      t.set(t.deckTop(), '5'); t.set(t.top(), '9'); t.set(h[0], '9'); t.set(h[1], '3'); t.set(h[3], '6');
      t.p0Knows(h[0], h[1], h[3]);
      draw(t);
      return { nine: h[0].id };
    },
    right: (a, r) => a.type === 'FLUSH_OWN' && a.cardIds.includes(r.nine),
  },
  {
    id: 'flush-pair', players: 4, seed: 202, phase: 'DRAW_DECISION',
    trick: 'flush a known pair matching the discard top before the top changes',
    build(t) {
      const h = t.hand(ME);
      t.set(t.deckTop(), '4'); t.set(t.top(), '6'); t.set(h[0], '6'); t.set(h[2], '6'); t.set(h[1], '2');
      t.p0Knows(h[0], h[1], h[2]);
      draw(t);
      return {};
    },
    right: (a) => a.type === 'FLUSH_OWN',
  },
  {
    id: 'flush-other', players: 2, seed: 303, phase: 'DRAW_DECISION',
    trick: "flush an opponent's card you know matches (then hand over your red K)",
    build(t) {
      const h = t.hand(ME), a = t.hand('p1');
      t.set(t.deckTop(), '6'); t.set(t.top(), '5'); t.set(a[1], '5'); t.set(h[0], 'Kr'); t.set(h[1], '3'); t.set(h[3], '4');
      t.p0Knows(h[0], h[1], h[3], a[1]);
      draw(t);
      return { target: a[1].id };
    },
    right: (a, r) => a.type === 'FLUSH_OTHER' && a.cardId === r.target,
  },
  {
    id: 'transfer-highest', players: 3, seed: 404, phase: 'TRANSFER_PENDING',
    trick: 'after flushing an opponent, give away your highest known card',
    build(t) {
      const h = t.hand(ME), a = t.hand('p1');
      t.set(t.top(), '8'); t.set(a[2], '8'); t.set(h[0], '2'); t.set(h[1], 'J'); t.set(h[3], '5');
      t.p0Knows(h[0], h[1], h[3], a[2]);
      t.act(ME, { type: 'FLUSH_OTHER', targetPlayerId: 'p1', cardId: a[2].id });
      return { high: h[1].id };
    },
    right: (a, r) => a.type === 'TRANSFER_CARD' && a.cardId === r.high,
  },
  {
    id: 'keep-low', players: 3, seed: 505, phase: 'DRAW_DECISION',
    trick: 'keep a low drawn card in place of your known high card',
    build(t) {
      const h = t.hand(ME);
      t.set(t.deckTop(), '2'); t.set(t.top(), '5'); t.set(h[0], '3'); t.set(h[1], '10'); t.set(h[2], '6'); t.set(h[3], '4');
      t.p0Knows(...h);
      draw(t);
      return {};
    },
    right: (a) => a.type === 'KEEP_DRAWN' && a.handIndex === 1,
  },
  {
    id: 'discard-high', players: 2, seed: 606, phase: 'DRAW_DECISION',
    trick: 'discard a high drawn card (red K) when your hand is low',
    build(t) {
      const h = t.hand(ME);
      t.set(t.deckTop(), 'Kr'); t.set(t.top(), '5'); t.set(h[0], 'A'); t.set(h[1], '4'); t.set(h[2], '2'); t.set(h[3], '3');
      t.p0Knows(...h);
      draw(t);
      return {};
    },
    right: (a) => a.type === 'DISCARD_DRAWN',
  },
  {
    id: 'keep-into-unknown', players: 2, seed: 1313, phase: 'DRAW_DECISION',
    trick: 'replace an unknown card with a below-average drawn card rather than discard it',
    build(t) {
      const h = t.hand(ME);
      t.set(t.deckTop(), '4'); t.set(t.top(), '10'); t.set(h[0], 'A'); t.set(h[1], '3');
      t.p0Knows(h[0], h[1]);
      draw(t);
      return {};
    },
    right: (a) => a.type === 'KEEP_DRAWN' && (a.handIndex === 2 || a.handIndex === 3),
  },
  {
    id: 'peek-own', players: 4, seed: 707, phase: 'POWER_PENDING',
    trick: 'use a 7/8 peek on one of your unknown cards',
    build(t) {
      const h = t.hand(ME);
      t.set(t.deckTop(), '7'); t.set(h[1], '3'); t.set(h[3], '5');
      t.p0Knows(h[1], h[3]);
      drawAndDiscard(t);
      return { unknown: [h[0].id, h[2].id] };
    },
    right: (a, r) => a.type === 'POWER_APPLY' && a.payload.power === 'PEEK_OWN' && r.unknown.includes(a.payload.cardId),
  },
  {
    id: 'peek-other', players: 3, seed: 808, phase: 'POWER_PENDING',
    trick: "use a 9/10 peek on an opponent card you have not seen",
    build(t) {
      const h = t.hand(ME), a = t.hand('p1'), b = t.hand('p2');
      t.set(t.deckTop(), '9'); t.set(h[1], '3'); t.set(h[3], '5');
      t.set(a[0], '2'); t.set(a[1], '4'); t.set(b[0], 'Q'); t.set(b[1], '10'); t.set(b[2], 'J');
      t.p0Knows(h[1], h[3], a[0], a[1], b[0], b[1], b[2]);
      drawAndDiscard(t);
      return { unknown: [a[2].id, a[3].id, b[3].id] };
    },
    right: (a, r) => a.type === 'POWER_APPLY' && a.payload.power === 'PEEK_OTHER' && r.unknown.includes(a.payload.cardId),
  },
  {
    id: 'swap-high-for-low', players: 3, seed: 909, phase: 'POWER_PENDING',
    trick: "J/Q swap: give your known high card for an opponent's known low card",
    build(t) {
      const h = t.hand(ME), a = t.hand('p1');
      t.set(t.deckTop(), 'J'); t.set(h[0], 'A'); t.set(h[1], 'Q'); t.set(h[3], '4'); t.set(a[0], '2');
      t.p0Knows(h[0], h[1], h[3], a[0]);
      drawAndDiscard(t);
      return { give: h[1].id, take: a[0].id };
    },
    right: (a, r) => isSwap(a) && a.payload.ownCardId === r.give && a.payload.targetCardId === r.take,
  },
  {
    id: 'keep-low-cards', players: 2, seed: 1010, phase: 'POWER_PENDING',
    trick: 'J/Q swap: give your unknown card, never one of your known low cards',
    build(t) {
      const h = t.hand(ME), a = t.hand('p1');
      t.set(t.deckTop(), 'J'); t.set(h[0], 'A'); t.set(h[1], '2'); t.set(h[3], '3'); t.set(a[1], 'Q');
      t.p0Knows(h[0], h[1], h[3], a[1]);
      drawAndDiscard(t);
      return { give: h[2].id, avoid: a[1].id };
    },
    right: (a, r) => isSwap(a) && a.payload.ownCardId === r.give,
  },
  {
    id: 'call-cabo', players: 3, seed: 1111, phase: 'TURN_END',
    trick: 'call Cabo when your known total (5) is clearly lowest',
    build(t) {
      const h = t.hand(ME);
      t.set(t.deckTop(), '5'); t.set(h[0], 'A'); t.set(h[1], '2'); t.set(h[2], 'Kb'); t.set(h[3], '3');
      t.p0Knows(...h);
      drawAndDiscard(t);
      return {};
    },
    right: (a) => a.type === 'CALL_CABO',
  },
  {
    id: 'call-cabo-4p', players: 4, seed: 1414, phase: 'TURN_END',
    trick: 'call Cabo with a known total of 3 at a 4-player table',
    build(t) {
      const h = t.hand(ME);
      t.set(t.deckTop(), '6'); t.set(h[0], 'A'); t.set(h[1], '2'); t.set(h[2], 'A'); t.set(h[3], 'Kb');
      t.p0Knows(...h);
      drawAndDiscard(t);
      return {};
    },
    right: (a) => a.type === 'CALL_CABO',
  },
  {
    id: 'no-cabo-known-lower', players: 3, seed: 1212, phase: 'TURN_END',
    trick: 'do NOT call Cabo on 10 when you know an opponent holds 5',
    build(t) {
      const h = t.hand(ME), a = t.hand('p1');
      t.set(t.deckTop(), '6');
      t.set(h[0], '4'); t.set(h[1], '3'); t.set(h[2], '2'); t.set(h[3], 'A');
      t.set(a[0], 'A'); t.set(a[1], '2'); t.set(a[2], 'Kb'); t.set(a[3], '3');
      t.p0Knows(...h, ...a);
      drawAndDiscard(t);
      return {};
    },
    right: (a) => a.type === 'END_TURN',
  },
  // ---- table memory (prompt version 2 shows this history; version 1 does not) ----
  {
    id: 'swap-into-kept-slot', players: 3, seed: 2101, phase: 'POWER_PENDING', memory: true, needThrows: { p1: 1 },
    trick: 'J/Q swap: take the slot an opponent just kept a drawn card in (likely low)',
    build(t) {
      const h = t.hand(ME), a = t.hand('p1');
      t.set(t.deckTop(), 'J'); t.set(h[0], 'A'); t.set(h[1], 'Q'); t.set(h[2], '3'); t.set(a[2], '2');
      t.keptInto('p1', a[2]);
      t.p0Knows(h[0], h[1], h[2]);
      drawAndDiscard(t);
      return { give: h[1].id, take: a[2].id };
    },
    prior: (w, r, rng) => constrainLow(w, [r.take], 4, rng),
    right: (a, r) => isSwap(a) && a.payload.ownCardId === r.give && a.payload.targetCardId === r.take,
  },
  {
    id: 'card-counting', players: 3, seed: 2202, phase: 'DRAW_DECISION', memory: true, minDiscard: 15,
    trick: 'low cards are used up (unseen mean ~8): put a drawn 5 on an unknown card, not on your known 6',
    build(t) {
      const h = t.hand(ME);
      t.set(t.deckTop(), '5'); t.set(t.top(), '10'); t.set(h[0], '6'); t.set(h[2], '4');
      for (const sp of ['A', 'A', 'A', 'A', '2', '2', '2', '2', '3', '3', '3', 'Kb', 'Kb']) t.toDiscard(sp);
      t.p0Knows(h[0], h[2]);
      draw(t);
      return {};
    },
    right: (a) => a.type === 'KEEP_DRAWN' && (a.handIndex === 1 || a.handIndex === 3),
  },
  {
    id: 'dead-rank', players: 2, seed: 2303, phase: 'DRAW_DECISION', memory: true, minDiscard: 6,
    trick: 'all other 8s are gone (your 8 can never be flushed): replace the 8, keep the flushable 9',
    build(t) {
      const h = t.hand(ME);
      t.set(t.deckTop(), '3'); t.set(t.top(), '5');
      t.set(h[0], '9'); t.set(h[1], '8'); t.set(h[2], '2'); t.set(h[3], 'A');
      for (let i = 0; i < 3; i++) t.toDiscard('8');
      t.p0Knows(...h);
      draw(t);
      return {};
    },
    right: (a) => a.type === 'KEEP_DRAWN' && a.handIndex === 1,
  },
  {
    id: 'no-cabo-kept-low', players: 3, seed: 2404, phase: 'TURN_END', memory: true, minDiscard: 10, needThrows: { p1: 4 },
    trick: 'do NOT call Cabo on 10: an opponent has kept a drawn card in all four slots',
    build(t) {
      const h = t.hand(ME), a = t.hand('p1');
      t.set(t.deckTop(), '6');
      t.set(h[0], '4'); t.set(h[1], '3'); t.set(h[2], '2'); t.set(h[3], 'A');
      t.set(a[0], 'A'); t.set(a[1], '2'); t.set(a[2], '3'); t.set(a[3], 'Kb');
      for (const c of a) t.keptInto('p1', c);
      t.p0Knows(...h);
      drawAndDiscard(t);
      return { ada: a.map((c) => c.id) };
    },
    prior: (w, r, rng) => constrainLow(w, r.ada, 3, rng),
    right: (a) => a.type === 'END_TURN',
  },
  {
    id: 'give-peeked-card', players: 3, seed: 2505, phase: 'TRANSFER_PENDING', memory: true,
    trick: 'transfer: of two equal 6s, give the one an opponent has peeked (it could be flushed on you)',
    build(t) {
      const h = t.hand(ME), b = t.hand('p2');
      t.set(t.top(), '8'); t.set(b[1], '8');
      t.set(h[0], 'A'); t.set(h[1], '6'); t.set(h[2], '2'); t.set(h[3], '6');
      t.inject('POWER_RESOLVED', { playerId: 'p1', power: 'PEEK_OTHER', targetPlayerId: ME, cardId: h[3].id, viewerId: 'p1' });
      t.know('p1', h[3]);
      t.p0Knows(...h, b[1]);
      t.act(ME, { type: 'FLUSH_OTHER', targetPlayerId: 'p2', cardId: b[1].id });
      return { peeked: h[3].id };
    },
    right: (a, r) => a.type === 'TRANSFER_CARD' && a.cardId === r.peeked,
  },
];

export function buildScenario(sc) {
  const { state } = baseState(sc.players, sc.seed, sc.minDiscard ?? 4, sc.needThrows ?? {});
  const t = new Table(state);
  const refs = sc.build(t) ?? {};
  const final = t.finish();
  return { state: final, refs };
}

// ---------------------------------------------------------------------------------------------------------------
// Rollout validation
// ---------------------------------------------------------------------------------------------------------------
/**
 * Rollout policy for validation: the heuristic bot, except that whenever it picks a card it has not seen (its own
 * unknown slot to replace or give, or an opponent's unseen card to peek or swap) the slot is drawn at random among the
 * equally unknown ones. The plain bot always takes the FIRST unknown slot (e.g. a J/Q swap always hits the victim's
 * #1), which rollouts would otherwise learn to exploit (park a red K in #1 and let the opponent take it).
 * The deciding seat also calls Cabo more carefully: the plain bot calls whenever its estimate is 2 below every
 * opponent's, i.e. at almost every turn end when it knows nothing about them, so a move's value would mostly
 * measure "this move, then an early Cabo". Here p0 calls only at an estimated total <= CABO_MAX.
 */
export let CABO_MAX = 10;
export function fairBots(players) {
  const inner = heuristicBots(players);
  const unknownOf = (view, pid) => (view.handCardIds[pid] ?? []).filter((id) => !id.startsWith('__slot__') && !view.knownCards[id]);
  const est = (view, pid) => (view.handCardIds[pid] ?? []).filter((id) => !id.startsWith('__slot__'))
    .reduce((t, id) => t + (view.knownCards[id] ? value(view.knownCards[id]) : 5.6), 0);
  /** The bot picks the highest-estimated opponent and breaks ties by seat order, so p0 (seat 0) would be every
   *  tied swap's and peek's victim; pick among the tied opponents at random instead. */
  const victim = (view, self, target, rng) => {
    const e = est(view, target);
    const tied = view.players.filter((p) => p.id !== self && p.cardCount > 0 && Math.abs(est(view, p.id) - e) < 1e-9).map((p) => p.id);
    return tied.length > 1 ? tied[Math.floor(rng.next() * tied.length)] : target;
  };
  const cardOf = (view, pid, rng) => {
    const pool = unknownOf(view, pid);
    if (pool.length) return pool[Math.floor(rng.next() * pool.length)];
    return (view.handCardIds[pid] ?? []).filter((id) => !id.startsWith('__slot__'))
      .sort((x, y) => value(view.knownCards[y]) - value(view.knownCards[x]))[0];
  };
  const reroll = (view, pid, id, rng) => {
    const pool = unknownOf(view, pid);
    return pool.includes(id) ? pool[Math.floor(rng.next() * pool.length)] : id;
  };
  return Object.fromEntries(Object.entries(inner).map(([pid, bot]) => [pid, {
    decide(obs, ctx) {
      const d = bot.decide(obs, ctx);
      const a = d.action, v = obs.view, rng = ctx.rng;
      if (a.type === 'CALL_CABO' && pid === ME) {
        const est = v.handCardIds[pid].filter((id) => !id.startsWith('__slot__'))
          .reduce((t, id) => t + (v.knownCards[id] ? value(v.knownCards[id]) : 5.6), 0);
        if (est > CABO_MAX) return { ...d, action: { type: 'END_TURN', playerId: pid } };
      }
      if (a.type === 'KEEP_DRAWN') {
        const id = v.handCardIds[pid][a.handIndex];
        return { ...d, action: { ...a, handIndex: v.handCardIds[pid].indexOf(reroll(v, pid, id, rng)) } };
      }
      if (a.type === 'TRANSFER_CARD') return { ...d, action: { ...a, cardId: reroll(v, pid, a.cardId, rng) } };
      if (a.type === 'POWER_APPLY') {
        const p = a.payload;
        if (p.power === 'PEEK_OWN') return { ...d, action: { ...a, payload: { ...p, cardId: reroll(v, pid, p.cardId, rng) } } };
        if (p.power === 'PEEK_OTHER' || p.power === 'BLIND_SWAP') {
          const t = victim(v, pid, p.targetPlayerId, rng);
          const card = t === p.targetPlayerId ? reroll(v, t, p.power === 'PEEK_OTHER' ? p.cardId : p.targetCardId, rng) : cardOf(v, t, rng);
          if (p.power === 'PEEK_OTHER') return { ...d, action: { ...a, payload: { ...p, targetPlayerId: t, cardId: card } } };
          return { ...d, action: { ...a, payload: { ...p, ownCardId: reroll(v, pid, p.ownCardId, rng), targetPlayerId: t, targetCardId: card } } };
        }
      }
      return d;
    },
  }]));
}

/** Per-rollout payoffs of every move (common random numbers). `bots`: fairBots (validation) or heuristicBots (teacher). */
function rolloutValues(state, moves, n, rng, prior, bots = fairBots) {
  const vals = [];
  for (let r = 0; r < n; r++) {
    const world = determinize(state, ME, rng);
    if (prior) prior(world, rng);
    const seed = Math.floor(rng.next() * 2 ** 31);
    vals.push(moves.map((m) => {
      const e = engineFrom(world);
      if (!e.handleAction({ ...m, playerId: ME }).ok) return NaN;
      playOut(e, bots(e.getState().players), createAgentRng(seed));
      return payoff(e.getState(), ME);
    }));
  }
  const q = moves.map((_, i) => vals.reduce((a, v) => a + v[i], 0) / n);
  return { vals, q };
}

function validate(sc, built, moves, n) {
  const rng = createAgentRng(sc.seed * 31 + 5);
  const prior = sc.prior ? (w, g) => sc.prior(w, built.refs, g) : null;
  const { vals, q } = rolloutValues(built.state, moves, n, rng, prior);
  const right = moves.map((m) => sc.right(m, built.refs));
  const argmax = (idx) => idx.reduce((b, i) => (b < 0 || q[i] > q[b] ? i : b), -1);
  const all = moves.map((_, i) => i);
  const bestRight = argmax(all.filter((i) => right[i]));
  const bestWrong = argmax(all.filter((i) => !right[i]));
  const best = argmax(all);
  if (bestRight < 0 || bestWrong < 0) return { status: 'invalid', q, best, bestRight, bestWrong, margin: 0, se: 0 };
  const d = vals.map((v) => v[bestRight] - v[bestWrong]);
  const margin = d.reduce((a, b) => a + b, 0) / n;
  const se = Math.sqrt(d.reduce((a, b) => a + (b - margin) ** 2, 0) / (n - 1) / n);
  const status = margin > 2 * se ? 'agree' : margin >= -2 * se ? 'weak' : 'disagree';
  return { status, q, best, bestRight, bestWrong, margin, se };
}

// ---------------------------------------------------------------------------------------------------------------
// Agents
// ---------------------------------------------------------------------------------------------------------------
const strip = ({ playerId, ...rest }) => rest;
const canon = (a) => JSON.stringify(strip(a), (k, v) => (v && typeof v === 'object' && !Array.isArray(v)
  ? Object.fromEntries(Object.keys(v).sort().map((x) => [x, v[x]])) : v));

/** P(move i) from Laya's per-question probabilities, by decoding every label combination. */
function moveProbs(questions, probs, decode, moves) {
  const keys = Object.keys(questions);
  const out = new Array(moves.length).fill(0);
  const rec = (k, labels, p) => {
    if (p === 0) return;
    if (k === keys.length) {
      const i = moves.indexOf(decode(labels));
      if (i >= 0) out[i] += p;
      return;
    }
    for (const lab of Object.keys(questions[keys[k]].criteria)) rec(k + 1, { ...labels, [keys[k]]: lab }, p * (probs[keys[k]]?.[lab] ?? 0));
  };
  rec(0, {}, 1);
  return out;
}

async function askLaya(spec, items, batch) {
  const [url, tag] = spec.replace(/^laya:/, '').split('#');
  const version = tag === 'p2' ? 2 : 1;
  const reqs = items.map((it) => {
    const named = layaRelabelView(it.view, ME);
    const dec = buildDecision(it.moves, named, ME);
    return { dec, body: { state: decisionText(named, ME, version), questions: dec.questions } };
  });
  let results;
  if (batch) {
    const res = await fetch(`${url}/batch`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ items: reqs.map((r) => r.body) }),
    });
    results = (await res.json()).results;
  } else {
    results = [];
    for (const r of reqs) {
      const res = await fetch(`${url}/decide`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(r.body) });
      results.push(await res.json());
    }
  }
  return results.map((res, k) => {
    if (res.error) throw new Error(`server: ${res.error}`);
    const { dec } = reqs[k];
    const action = dec.decode(res.answers);
    return { idx: action ? items[k].moves.indexOf(action) : -1, probs: moveProbs(dec.questions, res.probabilities, dec.decode, items[k].moves) };
  });
}

function heuristicPick(view, moves, seed) {
  const bot = new CaboHeuristicBot({ persona: 'balanced', idSuffix: '-p0' });
  const a = bot.decide({ gameId: 'cabo', selfId: ME, view, step: 0 }, { rng: createAgentRng(seed) }).action;
  return { idx: moves.findIndex((m) => canon(m) === canon({ ...a, playerId: ME })), action: a };
}

function teacherPick(state, moves, n, seed) {
  const { q } = rolloutValues(state, moves, n, createAgentRng(seed), null, heuristicBots);
  let best = 0;
  for (let i = 1; i < moves.length; i++) if (q[i] > q[best]) best = i;
  return { idx: best };
}

// ---------------------------------------------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------------------------------------------
const pct = (x) => `${(100 * x).toFixed(0)}%`;
const pad = (s, n) => String(s).slice(0, n).padEnd(n);

async function main() {
  const argv = process.argv.slice(2);
  const flag = (f) => argv.includes(f);
  const opt = (f, d) => { const i = argv.indexOf(f); return i >= 0 ? argv[i + 1] : d; };
  const check = flag('--check');
  const agent = check ? null : argv.find((a, i) => !a.startsWith('--') && !['--json', '--rollouts', '--only'].includes(argv[i - 1]));
  if (!check && !agent) {
    console.error('usage: node tricks.mjs <heuristic|teacher:N|[laya:]http://host:port[#p2]> [--batch] [--json out] [--rollouts N] [--show] [--only ids]\n       node tricks.mjs --check');
    process.exit(2);
  }
  const rollouts = Number(opt('--rollouts', 1024));
  CABO_MAX = Number(opt('--cabo-max', CABO_MAX));
  const only = opt('--only', null)?.split(',');
  const list = SCENARIOS.filter((s) => !only || only.includes(s.id));

  // build + construction checks + validation
  const rows = [];
  let problems = 0;
  for (const sc of list) {
    const row = { id: sc.id, trick: sc.trick, players: sc.players, memory: !!sc.memory };
    try {
      const built = buildScenario(sc);
      const s = built.state;
      const errs = [];
      if (actorOf(s) !== ME) errs.push(`actor is ${actorOf(s)}`);
      if (s.phase !== sc.phase) errs.push(`phase ${s.phase}, expected ${sc.phase}`);
      checkDeck(s);
      const view = engineFrom(s).getPlayerState(ME);
      const moves = candidateMoves(view, ME, createAgentRng(sc.seed));
      for (const m of moves) if (!engineFrom(s).handleAction({ ...m, playerId: ME }).ok) errs.push(`illegal move ${m.type}`);
      const nRight = moves.filter((m) => sc.right(m, built.refs)).length;
      if (nRight === 0) errs.push('no right move among the candidates');
      if (nRight === moves.length) errs.push('every move is right');
      Object.assign(row, { built, view, moves, nRight, errors: errs });
      if (errs.length) problems += 1;
      else {
        const t0 = Date.now();
        row.validation = validate(sc, built, moves, rollouts);
        row.validation.seconds = (Date.now() - t0) / 1000;
      }
    } catch (e) {
      row.errors = [String(e.message ?? e)];
      problems += 1;
    }
    rows.push(row);
  }

  const named = (r, i) => (i >= 0 ? describeAction(r.moves[i], layaRelabelView(r.view, ME), ME) : '(none)');
  if (flag('--show')) {
    for (const r of rows) {
      if (!r.view) continue;
      const nv = layaRelabelView(r.view, ME);
      console.log(`\n=== ${r.id} (${r.players}p${r.memory ? ', memory' : ''}) — ${r.trick}\n${decisionText(nv, ME, 2)}`);
      r.moves.forEach((m, i) => console.log(`  ${r.built && SCENARIOS.find((s) => s.id === r.id).right(m, r.built.refs) ? '*' : ' '} ${describeAction(m, nv, ME)}${r.validation ? `  Q=${r.validation.q[i].toFixed(3)}` : ''}`));
    }
    console.log();
  }

  if (check) {
    console.log(`${pad('scenario', 22)} ${pad('pl', 3)} ${pad('mem', 4)} ${pad('moves', 6)} ${pad('right', 6)} ${pad('rollout best', 34)} ${pad('margin±se', 14)} status`);
    for (const r of rows) {
      if (r.errors?.length) { console.log(`${pad(r.id, 22)} ERROR: ${r.errors.join('; ')}`); continue; }
      const v = r.validation;
      console.log(`${pad(r.id, 22)} ${pad(r.players, 3)} ${pad(r.memory ? 'yes' : '', 4)} ${pad(r.moves.length, 6)} ${pad(r.nRight, 6)} ${pad(named(r, v.best), 34)} ${pad(`${v.margin.toFixed(3)}±${v.se.toFixed(3)}`, 14)} ${v.status}`);
    }
    console.log(`\n${rows.length} scenarios, ${problems} construction problems, ${rows.filter((r) => r.validation?.status === 'disagree').length} disagree with ${rollouts} rollouts`);
    if (opt('--json')) writeFileSync(opt('--json'), JSON.stringify(rows.map(jsonRow), null, 1));
    process.exit(problems ? 1 : 0);
  }

  // the agent
  const kept = rows.filter((r) => r.validation && r.validation.status !== 'disagree' && r.validation.status !== 'invalid');
  const [kind, arg] = agent.split(/:(.*)/s);
  let picks;
  if (kind === 'heuristic') picks = kept.map((r) => heuristicPick(r.view, r.moves, r.built.state.revision));
  else if (kind === 'teacher') picks = kept.map((r, k) => teacherPick(r.built.state, r.moves, Number(arg || 256), 9001 + k));
  else picks = await askLaya(agent, kept.map((r) => ({ view: r.view, moves: r.moves })), flag('--batch'));
  kept.forEach((r, k) => {
    const sc = SCENARIOS.find((s) => s.id === r.id);
    r.pick = picks[k];
    r.correct = r.pick.idx >= 0 && sc.right(r.moves[r.pick.idx], r.built.refs);
    r.pRight = r.pick.probs ? r.pick.probs.reduce((a, p, i) => a + (sc.right(r.moves[i], r.built.refs) ? p : 0), 0) : null;
  });

  console.log(`agent ${agent}   (validation: ${rollouts} rollouts per move)\n`);
  console.log(`${pad('scenario', 22)} ${pad('trick', 58)} ${pad('pl', 3)} ${pad('chosen move', 36)} ${pad('right', 6)} P(right)`);
  for (const r of rows) {
    if (!kept.includes(r)) {
      console.log(`${pad(r.id, 22)} ${pad(r.trick, 58)} ${pad(r.players, 3)} -- skipped: ${r.errors?.length ? r.errors.join('; ') : `rollouts ${r.validation.status} (best: ${named(r, r.validation.best)})`}`);
      continue;
    }
    const mark = r.memory ? ' [mem]' : '';
    console.log(`${pad(r.id + mark, 22)} ${pad(r.trick, 58)} ${pad(r.players, 3)} ${pad(named(r, r.pick.idx), 36)} ${pad(r.correct ? 'yes' : 'NO', 6)} ${r.pRight == null ? '' : pct(r.pRight)}${r.validation.status === 'weak' ? '  (weak)' : ''}`);
  }
  const total = (rs) => {
    const n = rs.length;
    const c = rs.filter((r) => r.correct).length;
    const p = rs.every((r) => r.pRight != null) && n ? ` mean P(right) ${pct(rs.reduce((a, r) => a + r.pRight, 0) / n)}` : '';
    return { n, c, text: `${c}/${n}${p}` };
  };
  const all = total(kept), mem = total(kept.filter((r) => r.memory)), plain = total(kept.filter((r) => !r.memory));
  console.log(`\ntotal ${all.text}   non-memory ${plain.text}   memory ${mem.text}`);
  if (opt('--json')) {
    writeFileSync(opt('--json'), JSON.stringify({
      agent, rollouts, totals: { all: [all.c, all.n], nonMemory: [plain.c, plain.n], memory: [mem.c, mem.n] },
      scenarios: rows.map(jsonRow),
    }, null, 1));
  }
}

function jsonRow(r) {
  const nv = r.view ? layaRelabelView(r.view, ME) : null;
  return {
    id: r.id, trick: r.trick, players: r.players, memory: r.memory, errors: r.errors ?? [],
    moves: r.moves?.map((m) => describeAction(m, nv, ME)),
    right: r.moves?.map((m) => SCENARIOS.find((s) => s.id === r.id).right(m, r.built.refs)),
    validation: r.validation && { ...r.validation, q: r.validation.q.map((v) => +v.toFixed(4)) },
    chosen: r.pick ? r.pick.idx : undefined, correct: r.correct, pRight: r.pRight,
    probs: r.pick?.probs?.map((p) => +p.toFixed(4)),
  };
}

if (import.meta.url === `file://${process.argv[1]}`) await main();
