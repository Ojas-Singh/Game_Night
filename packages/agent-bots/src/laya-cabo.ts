/**
 * How a Cabo decision is put to Laya (a ModernBERT decision model: state text
 * + typed questions -> option probabilities). Training data (apps/arena/laya)
 * and live play both use this module, so the model always sees the same text.
 * Changing any string here changes the model's input: retrain afterwards.
 */
import { enumerateLegalActions, type AnyGameAction, type RngLike } from '@game-night/agent-core';
import type { CaboPlayerView } from '@game-night/engine-cabo';
import type { Card } from '@game-night/shared';

export const LAYA_MAX_OPTIONS = 20;
export const LAYA_INSTRUCTIONS = 'Cabo: pick the move most likely to win (lowest total wins, black K = -1).';
const GIVE_INSTRUCTIONS = 'Cabo J/Q swap: which of YOUR cards to give away?';
const TAKE_INSTRUCTIONS = 'Cabo J/Q swap: which card to take in return?';
const OTHER_NAMES = ['Ada', 'Byron', 'Cora', 'Dov', 'Esme'];

type CaboMove = Extract<AnyGameAction, { type: string }> & Record<string, unknown>;
type SwapPayload = { power: 'BLIND_SWAP'; ownCardId: string; targetPlayerId: string; targetCardId: string };

export interface LayaQuestion {
  type: 'choice';
  instructions: string;
  criteria: Record<string, string>;
}
export type LayaQuestions = Record<string, LayaQuestion>;
export type LayaGold = Record<string, { probabilities: Record<string, number> }>;

const RL: Record<number, string> = { 1: 'A', 11: 'J', 12: 'Q', 13: 'K' };
const SUIT: Record<string, string> = { hearts: '♥', diamonds: '♦', spades: '♠', clubs: '♣' };
export const cardText = (c: Card | null | undefined): string => (c ? `${RL[c.rank] ?? c.rank}${SUIT[c.suit]}` : 'unknown');
const value = (c: Card): number => (c.rank === 13 ? (c.suit === 'hearts' || c.suit === 'diamonds' ? 13 : -1) : c.rank);

/** The deciding seat is "You"; the others are named by table order. */
export function relabelView(view: CaboPlayerView, me: string): CaboPlayerView {
  const others = view.players.filter((p) => p.id !== me);
  const names = new Map<string, string>([[me, 'You'], ...others.map((p, i) => [p.id, OTHER_NAMES[i] ?? `P${i}`] as [string, string])]);
  return { ...view, players: view.players.map((p) => ({ ...p, name: names.get(p.id) ?? p.name })) };
}

function slotText(view: CaboPlayerView, me: string, pid: string, cid: string): string {
  const name = pid === me ? 'my' : view.players.find((p) => p.id === pid)?.name ?? pid;
  const i = (view.handCardIds[pid] ?? []).indexOf(cid);
  const c = view.knownCards[cid];
  return `${name} #${i + 1} (${c ? cardText(c) : '?'})`;
}

/** Short move text (Laya shares ~256 tokens across all options). */
export function describeMove(a: AnyGameAction, view: CaboPlayerView, me: string): string {
  const m = a as CaboMove;
  switch (m.type) {
    case 'DRAW': return 'Draw';
    case 'KEEP_DRAWN': {
      const cid = view.handCardIds[me]![m.handIndex as number]!;
      const old = view.knownCards[cid];
      const d = old && view.drawnCard ? value(view.drawnCard) - value(old) : null;
      return `Keep ${cardText(view.drawnCard)} → ${slotText(view, me, me, cid)}${d === null ? '' : ` Δ${d >= 0 ? '+' : ''}${d}`}`;
    }
    case 'DISCARD_DRAWN': return `Discard drawn ${cardText(view.drawnCard)}`;
    case 'FLUSH_OWN': return `Flush ${(m.cardIds as string[]).map((c) => slotText(view, me, me, c)).join(' + ')}`;
    case 'FLUSH_OTHER': return `Flush ${slotText(view, me, m.targetPlayerId as string, m.cardId as string)}`;
    case 'TRANSFER_CARD': return `Give ${slotText(view, me, me, m.cardId as string)}`;
    case 'CALL_CABO': return 'Call Cabo';
    case 'END_TURN': return 'End turn';
    case 'POWER_APPLY': {
      const p = m.payload as Record<string, string>;
      if (p.power === 'PEEK_OWN') return `Peek ${slotText(view, me, me, p.cardId!)}`;
      if (p.power === 'PEEK_OTHER') return `Peek ${slotText(view, me, p.targetPlayerId!, p.cardId!)}`;
      return `Swap ${slotText(view, me, me, p.ownCardId!)} ↔ ${slotText(view, me, p.targetPlayerId!, p.targetCardId!)}`;
    }
    default: return m.type;
  }
}

/** Compact table text with suits and pre-computed totals. */
export function stateText(view: CaboPlayerView, me: string): string {
  const lines: string[] = [];
  const top = view.discardTop;
  lines.push(`Phase ${view.phase}. Deck ${view.deckCount}. Discard top ${top ? cardText(top) : 'none'}.`);
  const order = [...view.players.filter((p) => p.id === me), ...view.players.filter((p) => p.id !== me)];
  for (const p of order) {
    const ids = view.handCardIds[p.id] ?? [];
    let sum = 0;
    let unknown = 0;
    const cells = ids.map((id, i) => {
      if (id.startsWith('__slot__')) return `#${i + 1} -`;
      const c = view.knownCards[id];
      if (c) sum += value(c);
      else unknown += 1;
      return `#${i + 1} ${c ? cardText(c) : '?'}`;
    });
    const name = p.id === me ? 'You' : p.name;
    lines.push(`${name}${p.isCurrentTurn ? ' (to play)' : ''}: ${cells.join(', ')} | known ${sum}, unknown ${unknown}`);
  }
  if (view.drawnCard) lines.push(`You drew ${cardText(view.drawnCard)} (value ${value(view.drawnCard)}).`);
  if (view.pendingPower) lines.push(`Power to use: ${view.pendingPower.power}.`);
  if (view.pendingTransfer) lines.push('You owe one of your cards to the player you flushed.');
  if (view.cabo) {
    const caller = view.cabo.callerId === me ? 'You' : view.players.find((p) => p.id === view.cabo!.callerId)?.name;
    lines.push(`Cabo called by ${caller}: final round.`);
  }
  return lines.join('\n');
}

const isSwap = (m: AnyGameAction): boolean =>
  m.type === 'POWER_APPLY' && (m as CaboMove & { payload: { power: string } }).payload.power === 'BLIND_SWAP';
const swapOf = (m: AnyGameAction): SwapPayload => (m as unknown as { payload: SwapPayload }).payload;

export const isSwapDecision = (moves: AnyGameAction[]): boolean => moves.length > 0 && moves.every(isSwap);

function isBlindFlush(a: AnyGameAction, view: CaboPlayerView): boolean {
  const m = a as CaboMove;
  if (m.type === 'FLUSH_OWN') return (m.cardIds as string[]).some((c) => !view.knownCards[c]);
  if (m.type === 'FLUSH_OTHER') return !view.knownCards[m.cardId as string];
  return false;
}

/**
 * Legal moves, capped at LAYA_MAX_OPTIONS: everything except blind flushes
 * (guessing an unknown card) is kept; blind flushes fill the rest in a seeded
 * random order. Swap decisions are not capped (asked as give/take).
 */
export function candidateMoves(view: CaboPlayerView, me: string, rng: RngLike): AnyGameAction[] {
  const all = enumerateLegalActions(view, me);
  if (all.length <= LAYA_MAX_OPTIONS || isSwapDecision(all)) return all;
  const keep = all.filter((a) => !isBlindFlush(a, view));
  const blind = rng.shuffle(all.filter((a) => isBlindFlush(a, view)));
  return [...keep, ...blind].slice(0, Math.max(LAYA_MAX_OPTIONS, keep.length));
}

export function softmax(q: number[], tau: number): number[] {
  const m = Math.max(...q);
  const ex = q.map((v) => Math.exp((v - m) / tau));
  const z = ex.reduce((a, b) => a + b, 0);
  return ex.map((v) => v / z);
}

export interface LayaDecision {
  questions: LayaQuestions;
  /** Per-move values -> soft targets (training). */
  gold: (q: number[], tau: number) => LayaGold;
  /** Laya's chosen labels -> the engine action, or null. */
  decode: (labels: Record<string, string | null | undefined>) => AnyGameAction | null;
}

/** One decision as Laya questions (J/Q swaps over the cap become move/give/take). */
export function buildDecision(moves: AnyGameAction[], view: CaboPlayerView, me: string): LayaDecision {
  const swaps = moves.filter(isSwap);
  if (swaps.length > 0 && moves.length > LAYA_MAX_OPTIONS) {
    const others = moves.filter((m) => !isSwap(m));
    const give = [...new Set(swaps.map((m) => swapOf(m).ownCardId))];
    const take = [...new Map(swaps.map((m) => [`${swapOf(m).targetPlayerId}|${swapOf(m).targetCardId}`, swapOf(m)])).values()];
    const keyOf = (m: AnyGameAction) => `${swapOf(m).ownCardId}|${swapOf(m).targetPlayerId}|${swapOf(m).targetCardId}`;
    const index = new Map(moves.map((m, i) => [isSwap(m) ? keyOf(m) : `x${i}`, i]));
    const otherIdx = moves.map((_, i) => i).filter((i) => !isSwap(moves[i]!));
    const questions: LayaQuestions = {};
    if (others.length > 0) {
      questions.move = {
        type: 'choice',
        instructions: LAYA_INSTRUCTIONS,
        criteria: Object.fromEntries([...others.map((m, k) => [`o${k}`, describeMove(m, view, me)]), ['swap', 'Use the J/Q swap']]),
      };
    }
    questions.give = {
      type: 'choice',
      instructions: GIVE_INSTRUCTIONS,
      criteria: Object.fromEntries(give.map((cid, i) => [`g${i}`, `Give ${slotText(view, me, me, cid)}`])),
    };
    questions.take = {
      type: 'choice',
      instructions: TAKE_INSTRUCTIONS,
      criteria: Object.fromEntries(take.map((t, i) => [`t${i}`, `Take ${slotText(view, me, t.targetPlayerId, t.targetCardId)}`])),
    };
    const swapIndex = (gi: number, ti: number) => index.get(`${give[gi]}|${take[ti]?.targetPlayerId}|${take[ti]?.targetCardId}`);
    const probs = (p: number[], prefix: (i: number) => string) =>
      ({ probabilities: Object.fromEntries(p.map((v, i) => [prefix(i), +v.toFixed(5)])) });
    const gold = (q: number[], tau: number): LayaGold => {
      const qv = (gi: number, ti: number) => {
        const i = swapIndex(gi, ti);
        return i == null ? -Infinity : q[i]!;
      };
      const out: LayaGold = {
        give: probs(softmax(give.map((_, gi) => Math.max(...take.map((__, ti) => qv(gi, ti)))), tau), (i) => `g${i}`),
        take: probs(softmax(take.map((_, ti) => Math.max(...give.map((__, gi) => qv(gi, ti)))), tau), (i) => `t${i}`),
      };
      if (others.length > 0) {
        const best = Math.max(...swaps.map((m) => q[index.get(keyOf(m))!]!));
        out.move = probs(softmax([...otherIdx.map((i) => q[i]!), best], tau), (k) => (k < others.length ? `o${k}` : 'swap'));
      }
      return out;
    };
    const decode = (labels: Record<string, string | null | undefined>) => {
      if (others.length > 0 && labels.move !== 'swap') {
        const k = otherIdx[Number(String(labels.move).slice(1))];
        return k == null ? null : moves[k]!;
      }
      const i = swapIndex(Number(String(labels.give).slice(1)), Number(String(labels.take).slice(1)));
      return i == null ? null : moves[i]!;
    };
    return { questions, gold, decode };
  }
  const questions: LayaQuestions = {
    move: {
      type: 'choice',
      instructions: LAYA_INSTRUCTIONS,
      criteria: Object.fromEntries(moves.map((m, i) => [`o${i}`, describeMove(m, view, me)])),
    },
  };
  const gold = (q: number[], tau: number): LayaGold => ({
    move: { probabilities: Object.fromEntries(softmax(q, tau).map((v, i) => [`o${i}`, +v.toFixed(5)])) },
  });
  const decode = (labels: Record<string, string | null | undefined>) => moves[Number(String(labels.move).slice(1))] ?? null;
  return { questions, gold, decode };
}
