/**
 * Server-authoritative Cabo engine.
 *
 * Pure state-machine over JSON state: no networking, no timers, no DOM.
 * All validation happens here — clients only ever send intentions.
 */

import {
  standardDeck,
  shuffle,
  createRng,
  type Card,
  type GameAction,
  type GameEvent,
  type GamePlayer,
  type Rng,
} from '@game-night/shared';
import { DEFAULT_CABO_RULES, cardValue, powerForRank, type CaboPower, type CaboRules } from './rules.js';
import type {
  CaboAction,
  CaboGameOptions,
  CaboState,
  PendingPower,
} from './types.js';
import { buildPlayerView } from './views.js';

export type { CaboState } from './types.js';

export class CaboEngineError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CaboEngineError';
  }
}

function INVALID(msg: string): never {
  throw new CaboEngineError(msg);
}

/** Lightweight structured warn (no card values / secrets). */
function logWarn(msg: string, fields?: Record<string, unknown>): void {
  // eslint-disable-next-line no-console
  console.warn(JSON.stringify({ ts: new Date().toISOString(), level: 'warn', msg, ...fields }));
}

function findCard(hand: Card[], cardId: string): number {
  return hand.findIndex((c) => c.id === cardId);
}

export class CaboEngine {
  readonly gameId = 'cabo';
  readonly stateVersion = 1 as const;

  private state: CaboState | null = null;
  private rules: CaboRules = { ...DEFAULT_CABO_RULES };
  private rng: Rng = createRng();

  getRules(): CaboRules {
    return this.rules;
  }

  getState(): CaboState {
    if (!this.state) INVALID('game not created');
    return this.state;
  }

  /** Restore a previously serialized state (reconnect / redis restore). */
  restoreState(state: CaboState, rules?: Partial<CaboRules>): void {
    if (state.stateVersion !== 1) INVALID('unsupported state version');
    this.state = state;
    this.rules = { ...DEFAULT_CABO_RULES, ...rules };
    this.rng = createRng();
  }

  // -------------------------------------------------------------------
  // Lifecycle
  // -------------------------------------------------------------------

  createGame(players: GamePlayer[], options: CaboGameOptions = {}): void {
    this.rules = { ...DEFAULT_CABO_RULES, ...options.rules };
    const rules = this.rules;
    if (players.length < rules.minPlayers || players.length > rules.maxPlayers) {
      INVALID(`cabo requires ${rules.minPlayers}-${rules.maxPlayers} players`);
    }
    const seats = [...players].sort((a, b) => a.seat - b.seat);
    this.rng = createRng(options.seed);

    const deck = options.forcedDeck ? options.forcedDeck.slice() : shuffle(standardDeck(), this.rng);

    const state: CaboState = {
      stateVersion: 1,
      gameId: 'cabo',
      phase: 'INITIAL_PEEK',
      players: seats,
      hands: {},
      knowledge: {},
      deck,
      discard: [],
      currentTurn: options.firstTurnSeat ?? 0,
      drawnCard: null,
      pendingPower: null,
      pendingTransfer: null,
      cabo: null,
      initialPeeksRemaining: seats.map((p) => p.id),
      scores: null,
      roundWinnerId: null,
      tiedWinnerIds: [],
      events: [],
      revision: 1,
      eventSeq: 0,
    };
    for (const p of seats) {
      state.hands[p.id] = [];
      state.knowledge[p.id] = [];
    }

    // Deal starting cards round-robin so positions feel physical.
    for (let round = 0; round < rules.startingCards; round++) {
      for (const p of seats) {
        const card = state.deck.pop();
        if (!card) INVALID('deck exhausted while dealing');
        state.hands[p.id]!.push(card);
      }
    }

    this.state = state;
    this.emit('ROUND_STARTED', { playerIds: seats.map((p) => p.id) });
    this.emit('CARDS_DEALT', {
      perPlayer: seats.map((p) => ({ playerId: p.id, cardCount: state.hands[p.id]!.length })),
    });
  }

  // -------------------------------------------------------------------
  // Queries
  // -------------------------------------------------------------------

  isGameFinished(): boolean {
    const s = this.getState();
    return s.phase === 'ROUND_REVEAL' || s.phase === 'ROUND_COMPLETE';
  }

  calculateScore(): Record<string, number> {
    const s = this.getState();
    const out: Record<string, number> = {};
    for (const p of s.players) {
      out[p.id] = s.hands[p.id]!.reduce((sum, c) => sum + cardValue(c, this.rules), 0);
    }
    return out;
  }

  getPublicState(): unknown {
    const s = this.getState();
    return {
      phase: s.phase,
      currentTurnPlayerId: s.players[s.currentTurn]?.id ?? null,
      deckCount: s.deck.length,
      discardTop: s.discard[s.discard.length - 1] ?? null,
      playerCardCounts: Object.fromEntries(s.players.map((p) => [p.id, s.hands[p.id]!.length])),
      caboCallerId: s.cabo?.callerId ?? null,
      revision: s.revision,
    };
  }

  getPlayerState(viewerId: string): import('./views.js').CaboPlayerView {
    return buildPlayerView(this.getState(), viewerId);
  }

  // -------------------------------------------------------------------
  // Actions
  // -------------------------------------------------------------------

  validateAction(action: GameAction): boolean {
    try {
      this.checkAction(action as CaboAction);
      return true;
    } catch {
      return false;
    }
  }

  handleAction(action: GameAction): { ok: boolean; error?: string; events: GameEvent[] } {
    const before = this.getState().eventSeq;
    try {
      this.applyAction(action as CaboAction);
    } catch (err) {
      if (err instanceof CaboEngineError) {
        return { ok: false, error: err.message, events: [] };
      }
      // Malformed/unknown action shape: never leak a raw JS TypeError to the
      // client. Report it as a plain invalid action and log for debugging.
      logWarn('invalid_action_shape', { type: (action as { type?: string }).type, error: String(err) });
      return { ok: false, error: 'invalid action', events: [] };
    }
    const s = this.getState();
    return { ok: true, events: s.events.filter((e) => e.seq > before) };
  }

  private currentPlayerId(): string {
    const s = this.getState();
    return s.players[s.currentTurn]?.id ?? INVALID('no current player');
  }

  private checkAction(a: CaboAction): void {
    const s = this.getState();
    const ids = s.players.map((p) => p.id);
    if (!ids.includes(a.playerId)) INVALID('player not in this game');
    switch (a.type) {
      case 'PEEK_STARTING': {
        if (s.phase !== 'INITIAL_PEEK') INVALID('not in initial peek phase');
        if (!s.initialPeeksRemaining.includes(a.playerId)) INVALID('already peeked');
        const hand = s.hands[a.playerId]!;
        const uniq = new Set(a.cardIndexes);
        if (uniq.size !== a.cardIndexes.length) INVALID('duplicate peek indexes');
        if (a.cardIndexes.length !== this.rules.initialPeekCards) {
          INVALID(`must peek exactly ${this.rules.initialPeekCards} cards`);
        }
        for (const i of a.cardIndexes) {
          if (i < 0 || i >= hand.length) INVALID('peek index out of range');
        }
        return;
      }
      case 'DRAW': {
        if (s.phase !== 'TURN_DRAW') INVALID('not a draw moment');
        if (a.playerId !== this.currentPlayerId()) INVALID('not your turn');
        return;
      }
      case 'KEEP_DRAWN': {
        if (s.phase !== 'DRAW_DECISION') INVALID('no drawn card to resolve');
        if (a.playerId !== this.currentPlayerId()) INVALID('not your turn');
        if (a.handIndex < 0 || a.handIndex >= s.hands[a.playerId]!.length) {
          INVALID('hand index out of range');
        }
        return;
      }
      case 'DISCARD_DRAWN': {
        if (s.phase !== 'DRAW_DECISION') INVALID('no drawn card to resolve');
        if (a.playerId !== this.currentPlayerId()) INVALID('not your turn');
        return;
      }
      case 'POWER_APPLY': {
        this.checkPowerApply(a);
        return;
      }
      case 'FLUSH_OWN': {
        if (s.phase === 'INITIAL_PEEK' || s.phase === 'ROUND_REVEAL' || s.phase === 'ROUND_COMPLETE') {
          INVALID('flushing not allowed now');
        }
        if (a.cardIds.length === 0) INVALID('no cards selected');
        const hand = s.hands[a.playerId]!;
        const seen = new Set<string>();
        for (const id of a.cardIds) {
          if (seen.has(id)) INVALID('duplicate card in flush');
          seen.add(id);
          if (findCard(hand, id) < 0) INVALID('card not in your hand');
        }
        return;
      }
      case 'FLUSH_OTHER': {
        if (s.phase === 'INITIAL_PEEK' || s.phase === 'ROUND_REVEAL' || s.phase === 'ROUND_COMPLETE') {
          INVALID('flushing not allowed now');
        }
        if (s.pendingTransfer) INVALID('a card transfer must be completed first');
        if (a.playerId === a.targetPlayerId) INVALID('target must be another player');
        if (!ids.includes(a.targetPlayerId)) INVALID('target not in game');
        const targetHand = s.hands[a.targetPlayerId]!;
        if (findCard(targetHand, a.cardId) < 0) INVALID('card not in target hand');
        return;
      }
      case 'TRANSFER_CARD': {
        if (s.phase !== 'TRANSFER_PENDING') INVALID('no pending transfer');
        const t = s.pendingTransfer!;
        if (a.playerId !== t.fromPlayerId) INVALID('you are not the flusher');
        if (findCard(s.hands[a.playerId]!, a.cardId) < 0) INVALID('card not in your hand');
        return;
      }
      case 'CALL_CABO': {
        if (!this.rules.cabo.enabled) INVALID('cabo calling disabled');
        if (s.phase !== 'TURN_DRAW') INVALID('cabo can only be called at the start of your turn');
        if (a.playerId !== this.currentPlayerId()) INVALID('not your turn');
        if (s.cabo) INVALID('cabo already called');
        return;
      }
      default:
        INVALID(`unknown action type: ${(a as { type: string }).type}`);
    }
  }

  private checkPowerApply(a: Extract<CaboAction, { type: 'POWER_APPLY' }>): void {
    const s = this.getState();
    const pending = s.pendingPower;
    if (!pending) INVALID('no power pending');
    if (a.playerId !== pending.playerId) INVALID('you do not owe a power action');
    const payload = a.payload;
    if (payload.power !== pending.power) INVALID('wrong power action');
    const others = s.players.filter((p) => p.id !== a.playerId);
    switch (payload.power) {
      case 'SWAP_OTHERS': {
        const ownerA = others.find((p) => findCard(s.hands[p.id]!, payload.cardIdA) >= 0);
        const ownerB = others.find((p) => findCard(s.hands[p.id]!, payload.cardIdB) >= 0);
        if (!ownerA || !ownerB) INVALID('both cards must belong to other players');
        if (payload.cardIdA === payload.cardIdB) INVALID('cannot swap a card with itself');
        return;
      }
      case 'PEEK_OWN': {
        if (findCard(s.hands[a.playerId]!, payload.cardId) < 0) INVALID('card not in your hand');
        return;
      }
      case 'PEEK_OTHER': {
        if (payload.targetPlayerId === a.playerId) INVALID('must target another player');
        const target = s.players.find((p) => p.id === payload.targetPlayerId);
        if (!target) INVALID('target not in game');
        if (findCard(s.hands[payload.targetPlayerId]!, payload.cardId) < 0) {
          INVALID('card not in target hand');
        }
        return;
      }
      case 'BLIND_SWAP': {
        if (findCard(s.hands[a.playerId]!, payload.ownCardId) < 0) INVALID('own card not in hand');
        const target = s.players.find((p) => p.id === payload.targetPlayerId);
        if (!target || target.id === a.playerId) INVALID('must target another player');
        if (findCard(s.hands[payload.targetPlayerId]!, payload.targetCardId) < 0) {
          INVALID('target card not in target hand');
        }
        return;
      }
    }
  }

  // -------------------------------------------------------------------
  // Mutations
  // -------------------------------------------------------------------

  private applyAction(a: CaboAction): void {
    this.checkAction(a);
    const s = this.getState();
    switch (a.type) {
      case 'PEEK_STARTING': {
        for (const i of a.cardIndexes) {
          const card = s.hands[a.playerId]![i]!;
          this.learn(a.playerId, card.id);
        }
        s.initialPeeksRemaining = s.initialPeeksRemaining.filter((id) => id !== a.playerId);
        this.emit('INITIAL_PEEKED', { playerId: a.playerId, count: a.cardIndexes.length });
        if (s.initialPeeksRemaining.length === 0) {
          s.phase = 'TURN_DRAW';
          this.emit('TURN_STARTED', { playerId: this.currentPlayerId() });
        }
        return;
      }
      case 'DRAW': {
        this.drawCard(a.playerId);
        return;
      }
      case 'KEEP_DRAWN': {
        this.keepDrawn(a.playerId, a.handIndex);
        return;
      }
      case 'DISCARD_DRAWN': {
        const card = s.drawnCard;
        if (!card) INVALID('no drawn card');
        s.drawnCard = null;
        this.forgetAll(card.id);
        s.discard.push(card);
        this.emit('CARD_DISCARDED', { playerId: a.playerId, cardId: card.id, rank: card.rank });
        this.afterDiscard(a.playerId, card);
        return;
      }
      case 'POWER_APPLY': {
        this.applyPower(a.playerId, a.payload);
        return;
      }
      case 'FLUSH_OWN': {
        const sNow = s;
        const hand = sNow.hands[a.playerId]!;
        const cards = a.cardIds
          .map((id) => hand.find((c) => c.id === id)!)
          .sort((x, y) => findCard(hand, x.id) - findCard(hand, y.id));
        const top = sNow.discard[sNow.discard.length - 1];
        const mismatches = top ? cards.filter((c) => c.rank !== top.rank) : [];
        if (mismatches.length > 0) {
          // Misflush: a visible mistake. Everyone sees the wrong card(s), the
          // cards stay in hand, and the player draws a penalty card.
          for (const card of mismatches) this.revealToAll(card);
          this.emit('FAILED_FLUSH_OWN', {
            playerId: a.playerId,
            cardIds: mismatches.map((c) => c.id),
            ranks: mismatches.map((c) => c.rank),
          });
          this.applyWrongFlushPenalty(a.playerId);
          return;
        }
        for (const card of cards) {
          hand.splice(findCard(hand, card.id), 1);
          this.forgetAll(card.id);
          sNow.discard.push(card);
          this.emit('CARD_FLUSHED', { playerId: a.playerId, sourcePlayerId: a.playerId, cardId: card.id, rank: card.rank });
        }
        this.checkPlayerOutOrAdvance(a.playerId);
        return;
      }
      case 'FLUSH_OTHER': {
        const targetHand = s.hands[a.targetPlayerId]!;
        const idx = findCard(targetHand, a.cardId);
        const card = targetHand[idx]!;
        const top = s.discard[s.discard.length - 1];
        if (top && card.rank === top.rank) {
          targetHand.splice(idx, 1);
          this.forgetAll(card.id);
          s.discard.push(card);
          this.emit('CARD_FLUSHED', {
            playerId: a.playerId,
            sourcePlayerId: a.targetPlayerId,
            cardId: card.id,
            rank: card.rank,
          });
          s.pendingTransfer = {
            fromPlayerId: a.playerId,
            toPlayerId: a.targetPlayerId,
            phaseBefore: s.phase,
          };
          s.phase = 'TRANSFER_PENDING';
          this.emit('TRANSFER_REQUIRED', { fromPlayerId: a.playerId, toPlayerId: a.targetPlayerId });
          this.checkPlayerOut(a.targetPlayerId);
        } else {
          // Wrong guess at another player's card: a visible, embarrassing
          // mistake. The invalid card stays with its owner, but everyone sees
          // its identity, and the guesser draws a penalty card.
          this.revealToAll(card);
          this.emit('FAILED_FLUSH_OTHER', {
            playerId: a.playerId,
            targetPlayerId: a.targetPlayerId,
            cardId: card.id,
            rank: card.rank,
          });
          this.applyWrongFlushPenalty(a.playerId);
        }
        return;
      }
      case 'TRANSFER_CARD': {
        const t = s.pendingTransfer!;
        const hand = s.hands[t.fromPlayerId]!;
        const idx = findCard(hand, a.cardId);
        const card = hand[idx]!;
        hand.splice(idx, 1);
        s.hands[t.toPlayerId]!.push(card);
        s.pendingTransfer = null;
        s.phase = t.phaseBefore;
        this.emit('CARD_TRANSFERRED', {
          fromPlayerId: t.fromPlayerId,
          toPlayerId: t.toPlayerId,
          cardId: card.id,
        });
        this.checkPlayerOutOrAdvance(t.fromPlayerId);
        return;
      }
      case 'CALL_CABO': {
        s.cabo = { callerId: a.playerId, takenFinalTurn: [] };
        this.emit('CABO_CALLED', { playerId: a.playerId });
        this.advanceTurn();
        return;
      }
    }
  }

  /** Draw a card into the active player's hand-slot (held, not yet kept). */
  private drawCard(playerId: string): void {
    const s = this.getState();
    if (s.deck.length === 0) {
      if (this.rules.emptyDeckBehavior === 'end_round') {
        this.endRound('DECK_EXHAUSTED');
        return;
      }
      // Reshuffle the discard pile (keeping its top) into a fresh deck.
      const top = s.discard.pop();
      s.deck = shuffle(s.discard, this.rng);
      s.discard = top ? [top] : [];
      this.emit('DECK_RESHUFFLED', { newDeckCount: s.deck.length });
    }
    const card = s.deck.pop()!;
    s.drawnCard = card;
    this.learn(playerId, card.id);
    s.phase = 'DRAW_DECISION';
    this.emit('CARD_DRAWN', { playerId, deckCount: s.deck.length });
  }

  /** Keep the drawn card, replacing hand[handIndex]; the replaced card is
   *  discarded and ITS power (if any) is what triggers. */
  private keepDrawn(playerId: string, handIndex: number): void {
    const s = this.getState();
    const drawn = s.drawnCard!;
    const hand = s.hands[playerId]!;
    const replaced = hand[handIndex]!;
    hand[handIndex] = drawn;
    s.drawnCard = null;
    this.forgetAll(replaced.id);
    s.discard.push(replaced);
    this.emit('CARD_REPLACED', {
      playerId,
      keptCardId: drawn.id,
      replacedCardId: replaced.id,
      rank: replaced.rank,
    });
    this.afterDiscard(playerId, replaced);
  }

  /** After any discard: trigger the discarded card's power if it has one,
   *  otherwise end the turn. Mandatory — the turn cannot advance past a
   *  pending power. */
  private afterDiscard(playerId: string, card: Card): void {
    let power = powerForRank(card.rank, this.rules);
    // 5–6 swap-others is a host-selectable optional power in our house rules.
    if (power === 'SWAP_OTHERS' && !this.rules.swapOthersEnabled) power = null;
    if (power) {
      this.getState().pendingPower = { playerId, power, sourceCardId: card.id };
      this.getState().phase = 'POWER_PENDING';
      this.emit('POWER_TRIGGERED', { playerId, power, sourceCardId: card.id, rank: card.rank });
    } else {
      this.endTurnIfActive(playerId);
    }
  }

  private applyPower(
    playerId: string,
    payload: Extract<CaboAction, { type: 'POWER_APPLY' }>['payload'],
  ): void {
    const s = this.getState();
    const pending = s.pendingPower!;
    switch (payload.power) {
      case 'SWAP_OTHERS': {
        // Swap positions of two cards belonging to other players; values stay hidden.
        for (const pid of Object.keys(s.hands)) {
          const i = findCard(s.hands[pid]!, payload.cardIdA);
          if (i >= 0) {
            const j = findCard(s.hands[pid]!, payload.cardIdB);
            if (j >= 0) {
              const tmp = s.hands[pid]![i]!;
              s.hands[pid]![i] = s.hands[pid]![j]!;
              s.hands[pid]![j] = tmp;
            } else {
              this.swapAcrossPlayers(payload.cardIdA, payload.cardIdB);
            }
            break;
          }
        }
        break;
      }
      case 'PEEK_OWN': {
        this.learn(playerId, payload.cardId);
        this.emit('POWER_RESOLVED', { playerId, power: 'PEEK_OWN', cardId: payload.cardId, viewerId: playerId });
        break;
      }
      case 'PEEK_OTHER': {
        this.learn(playerId, payload.cardId);
        this.emit('POWER_RESOLVED', {
          playerId,
          power: 'PEEK_OTHER',
          targetPlayerId: payload.targetPlayerId,
          cardId: payload.cardId,
          viewerId: playerId,
        });
        break;
      }
      case 'BLIND_SWAP': {
        const own = s.hands[playerId]!;
        const target = s.hands[payload.targetPlayerId]!;
        const i = findCard(own, payload.ownCardId);
        const j = findCard(target, payload.targetCardId);
        const tmp = own[i]!;
        own[i] = target[j]!;
        target[j] = tmp;
        this.emit('POWER_RESOLVED', {
          playerId,
          power: 'BLIND_SWAP',
          ownCardId: payload.ownCardId,
          targetPlayerId: payload.targetPlayerId,
          targetCardId: payload.targetCardId,
        });
        break;
      }
    }
    if (payload.power !== 'PEEK_OWN' && payload.power !== 'PEEK_OTHER') {
      this.emit('POWER_RESOLVED', { playerId, power: payload.power });
    }
    s.pendingPower = null;
    s.phase = 'TURN_DRAW';
    this.endTurnIfActive(playerId);
  }

  private swapAcrossPlayers(cardIdA: string, cardIdB: string): void {
    const s = this.getState();
    let pa: Card | null = null;
    let pb: Card | null = null;
    for (const pid of Object.keys(s.hands)) {
      const i = findCard(s.hands[pid]!, cardIdA);
      if (i >= 0) pa = s.hands[pid]![i]!;
      const j = findCard(s.hands[pid]!, cardIdB);
      if (j >= 0) pb = s.hands[pid]![j]!;
    }
    if (!pa || !pb) INVALID('swap cards not found');
    for (const pid of Object.keys(s.hands)) {
      const hand = s.hands[pid]!;
      const i = findCard(hand, cardIdA);
      const j = findCard(hand, cardIdB);
      if (i >= 0) hand[i] = pb;
      if (j >= 0) hand[j] = pa;
      if (j >= 0) hand[j] = pa;
    }
  }

  private applyWrongFlushPenalty(playerId: string): void {
    const s = this.getState();
    const penalty = this.rules.wrongFlushPenalty;
    const drawCount = penalty === 'draw_one' ? 1 : penalty === 'draw_two' ? 2 : 0;
    for (let n = 0; n < drawCount; n++) {
      if (s.deck.length === 0) break;
      const card = s.deck.pop()!;
      s.hands[playerId]!.push(card);
      // Deliberately NOT learned: the extra penalty card is placed face-down
      // and is a secret to everyone, including the player who drew it.
    }
    if (drawCount > 0) {
      this.emit('PENALTY_DRAWN', { playerId, count: drawCount });
    }
  }

  // -------------------------------------------------------------------
  // Turn / round progression
  // -------------------------------------------------------------------

  /** If the acting player is the current player, advance the turn. */
  private endTurnIfActive(playerId: string): void {
    const s = this.getState();
    if (s.players[s.currentTurn]?.id === playerId) {
      this.advanceTurn();
    }
  }

  /** After a flush: possibly end the round (player out of cards), otherwise
   *  keep the turn where it is — flushing never changes whose turn it is. */
  private checkPlayerOutOrAdvance(playerId: string): void {
    const s = this.getState();
    if (this.rules.endRoundWhenPlayerHasNoCards) {
      for (const p of s.players) {
        if (s.hands[p.id]!.length === 0) {
          this.endRound('PLAYER_OUT');
          return;
        }
      }
    }
    // Non-current players flushing mid- someone-else's turn keep flow intact.
    void playerId;
  }

  private checkPlayerOut(playerId: string): void {
    if (!this.rules.endRoundWhenPlayerHasNoCards) return;
    const s = this.getState();
    if (s.hands[playerId]!.length === 0) {
      this.endRound('PLAYER_OUT');
    }
  }

  private advanceTurn(): void {
    const s = this.getState();
    const n = s.players.length;
    const cabo = s.cabo;

    const isEligible = (idx: number): boolean => {
      const p = s.players[idx]!;
      if (s.hands[p.id]!.length === 0) return false; // out of cards — no turn
      if (!cabo) return true;
      if (p.id === cabo.callerId && !this.rules.cabo.callerGetsFinalTurn) return false;
      const taken = cabo.takenFinalTurn.filter((id) => id === p.id).length;
      return taken < this.rules.cabo.othersFinalTurns;
    };

    let idx = s.currentTurn;
    for (let step = 1; step <= n; step++) {
      const candidate = (s.currentTurn + step) % n;
      const p = s.players[candidate]!;
      if (isEligible(candidate)) {
        idx = candidate;
        s.currentTurn = idx;
        s.phase = 'TURN_DRAW';
        s.drawnCard = null;
        if (cabo) cabo.takenFinalTurn.push(p.id);
        this.emit('TURN_STARTED', { playerId: p.id, isFinalTurn: !!cabo });
        return;
      }
    }

    // Nobody eligible — round over (all final turns taken, or nobody has cards).
    if (cabo) {
      this.endRound('CABO_COMPLETE');
    } else {
      this.endRound('NO_ELIGIBLE_PLAYER');
    }
  }

  private endRound(reason: string): void {
    const s = this.getState();
    s.phase = 'ROUND_REVEAL';
    s.drawnCard = null;
    s.pendingPower = null;
    s.pendingTransfer = null;
    // Full reveal: everyone learns every remaining card on the table.
    for (const p of s.players) {
      for (const other of s.players) {
        for (const card of s.hands[other.id]!) this.learn(p.id, card.id);
      }
    }
    const scores = this.calculateScore();
    s.scores = scores;
    const best = Math.min(...Object.values(scores));
    const winners = s.players.filter((p) => scores[p.id] === best).map((p) => p.id);
    s.roundWinnerId = winners.length === 1 ? winners[0]! : null;
    s.tiedWinnerIds = winners;
    this.emit('ROUND_REVEALED', {
      reason,
      hands: s.players.map((p) => ({
        playerId: p.id,
        cards: s.hands[p.id]!,
      })),
    });
    this.emit('ROUND_SCORED', { scores, winners });
    s.phase = 'ROUND_COMPLETE';
  }

  // -------------------------------------------------------------------
  // Knowledge & events
  // -------------------------------------------------------------------

  private learn(playerId: string, cardId: string): void {
    const s = this.getState();
    const k = s.knowledge[playerId]!;
    if (!k.includes(cardId)) k.push(cardId);
  }

  private forgetAll(cardId: string): void {
    const s = this.getState();
    for (const pid of Object.keys(s.knowledge)) {
      s.knowledge[pid] = s.knowledge[pid]!.filter((id) => id !== cardId);
    }
  }

  /** Reveal a card's identity to every player (used for visible misflushes). */
  private revealToAll(card: Card): void {
    const s = this.getState();
    for (const p of s.players) this.learn(p.id, card.id);
  }

  private emit(type: string, payload?: Record<string, unknown>, playerId?: string): void {
    const s = this.getState();
    s.eventSeq += 1;
    s.events.push({
      seq: s.eventSeq,
      type,
      playerId,
      timestamp: new Date().toISOString(),
      payload,
    });
    s.revision += 1;
  }
}
