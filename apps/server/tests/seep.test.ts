import { describe, expect, it } from 'vitest';
import { Room, RoomError } from '../src/room.js';
import { MemoryRoomStore, serializeRoom } from '../src/persistence.js';
import {
  DEFAULT_SEEP_RULES,
  cardPoints,
  captureValue,
  type SeepPlayerView,
  type SeepState,
} from '@game-night/engine-seep';
import type { GameAction } from '@game-night/shared';

/**
 * Legal greedy driver (same policy as the engine tests): capture whenever any
 * card can capture, otherwise lay. Every candidate is engine-validated before
 * it is returned, so the driver never proposes an illegal action.
 */
function bestAction(room: Room, state: SeepState, pid: string): GameAction {
  // Opening step: announce the highest biddable card in hand.
  if (state.phase === 'ANNOUNCE') {
    const hand = state.hands[pid] ?? [];
    const best = [...hand].sort((a, b) => b.rank - a.rank).find((x) => x.rank >= 9);
    if (!best) throw new Error('no biddable card after redeal');
    return { type: 'ANNOUNCE', playerId: pid, value: best.rank } as unknown as GameAction;
  }

  const hand = state.hands[pid] ?? [];
  const loose = state.tableLoose;
  const tryCapture = (cardId: string): GameAction | null => {
    const v = captureValue(hand.find((x) => x.id === cardId)!);
    // All matching houses are compulsory in one capture (Pagat: pick up ALL
    // matching items; maximal collections only).
    const matchingHouses = state.houses.filter((h) => h.total === v).map((h) => h.id);
    // A capture takes groups totalling a multiple of v — the engine keeps
    // only maximal, non-overlapping collections, so just let it judge masks.
    for (let mask = 1; mask < 1 << loose.length; mask++) {
      const ids: string[] = [];
      let sum = 0;
      for (let i = 0; i < loose.length; i++) {
        if (mask & (1 << i)) {
          ids.push(loose[i]!.id);
          sum += captureValue(loose[i]!);
        }
      }
      if (sum % v !== 0 || sum === 0) continue;
      const act = {
        type: 'PLAY_CARD',
        playerId: pid,
        cardId,
        intent: { kind: 'CAPTURE', tableCardIds: ids, houseIds: matchingHouses },
      } as unknown as GameAction;
      if (room.engine!.validateAction(act)) return act;
    }
    if (matchingHouses.length > 0) {
      const act = {
        type: 'PLAY_CARD',
        playerId: pid,
        cardId,
        intent: { kind: 'CAPTURE', tableCardIds: [], houseIds: matchingHouses },
      } as unknown as GameAction;
      if (room.engine!.validateAction(act)) return act;
    }
    return null;
  };

  // Must-capture: the first card with any legal capture wins.
  for (const card of hand) {
    const act = tryCapture(card.id);
    if (act) return act;
  }
  // Opening play: the bid card itself (throw it if nothing better).
  if (state.bid !== null && state.playsMade === 0) {
    const bidCard = hand.find((x) => x.rank === state.bid);
    if (bidCard) {
      const act = { type: 'PLAY_CARD', playerId: pid, cardId: bidCard.id, intent: { kind: 'LAY_DOWN' } } as unknown as GameAction;
      if (room.engine!.validateAction(act)) return act;
    }
  }
  for (const card of hand) {
    const act = { type: 'PLAY_CARD', playerId: pid, cardId: card.id, intent: { kind: 'LAY_DOWN' } } as unknown as GameAction;
    if (room.engine!.validateAction(act)) return act;
  }
  throw new Error(`no legal action for ${pid}`);
}

function seepRoom() {
  const room = new Room({ roomId: 'SEEP01' });
  const p1 = room.addPlayer('North');
  const p2 = room.addPlayer('East');
  const p3 = room.addPlayer('South');
  const p4 = room.addPlayer('West');
  room.selectGame(room.hostId!, 'seep');
  return { room, players: [p1.player, p2.player, p3.player, p4.player] };
}

describe('Seep room integration', () => {
  it('requires exactly four players to start', () => {
    const room = new Room({ roomId: 'SEEP02' });
    room.addPlayer('A');
    room.addPlayer('B');
    room.addPlayer('C');
    room.selectGame(room.hostId!, 'seep');
    expect(() => room.startGame(room.hostId!)).toThrow(/4/);
  });

  it('caps the lobby at four seats once Seep is selected', () => {
    const { room } = seepRoom();
    expect(() => room.addPlayer('Late')).toThrow(RoomError);
  });

  it('plays a full deal through the room; partners share the team score', () => {
    const { room } = seepRoom();
    room.startGame(room.hostId!);
    expect(room.engine?.gameId).toBe('seep');

    let guard = 0;
    while (room.engine && !room.engine.isGameFinished() && guard++ < 600) {
      const state = room.engine.getState() as SeepState;
      // A completed deal with the baazi still live is not a finished MATCH —
      // the host deals the next hand instead of driving a turn.
      if (state.phase === 'DEAL_COMPLETE') {
        room.playAgain(room.hostId!);
        continue;
      }
      const pid = state.players[state.currentTurn]!.id;
      expect(() => room.handleGameAction(pid, bestAction(room, state, pid))).not.toThrow();
    }
    expect(room.engine!.isGameFinished()).toBe(true);

    const state = room.engine!.getState() as SeepState;
    expect(['DEAL_COMPLETE', 'MATCH_COMPLETE']).toContain(state.phase);
    expect(state.teamScores).not.toBeNull();
    const tp = state.teamScores!;
    // Scoreboard = baazis won, shared by each partnership (seats 0/2 = team 0).
    const ids = [...room.players.keys()];
    expect(room.scoreboard[ids[0]!]).toBe(state.baazisWon[0]);
    expect(room.scoreboard[ids[2]!]).toBe(state.baazisWon[0]);
    expect(room.scoreboard[ids[1]!]).toBe(state.baazisWon[1]);
    expect(room.scoreboard[ids[3]!]).toBe(state.baazisWon[1]);
    // Conservation: card points + sweep bonuses across the whole 52-card deck.
    const captured = ids.flatMap((pid) => state.captures[pid] ?? []);
    expect(captured).toHaveLength(52);
    const pts = captured.reduce((sum, card) => sum + cardPoints(card, DEFAULT_SEEP_RULES), 0);
    const sweepTotal = state.sweepPoints[0] + state.sweepPoints[1];
    expect(tp[0] + tp[1]).toBe(pts + sweepTotal);
  });

  it('plays a full deal driven by the real SeepHeuristicBot (live AI path)', async () => {
    const { SeepHeuristicBot } = await import('@game-night/agent-bots');
    const { createAgentRng } = await import('@game-night/agent-core');
    const { room } = seepRoom();
    room.startGame(room.hostId!);
    const rng = createAgentRng(1234);

    let guard = 0;
    while (room.engine && !room.engine.isGameFinished() && guard++ < 1200) {
      const state = room.engine.getState() as SeepState;
      if (state.phase === 'DEAL_COMPLETE') {
        room.playAgain(room.hostId!);
        continue;
      }
      const pid = state.players[state.currentTurn]!.id;
      const view = room.engine.getPlayerState(pid) as unknown as SeepPlayerView;
      const agent = new SeepHeuristicBot({ persona: ['balanced', 'baiter', 'scholar', 'conservative'][guard % 4] });
      const decision = await agent.decide(
        { gameId: 'seep', selfId: pid, view, step: guard },
        { rng },
      );
      let action = decision.action as GameAction;
      if (!room.engine.validateAction(action)) {
        // The heuristic over-approximates: fall back to an engine-validated one.
        const { enumerateLegalActions } = await import('@game-night/agent-core');
        const legal = enumerateLegalActions(view, pid).filter((a) => room.engine!.validateAction(a as GameAction));
        expect(legal.length).toBeGreaterThan(0);
        action = rng.pick(legal) as GameAction;
      }
      expect(() => room.handleGameAction(pid, action)).not.toThrow();
    }
    expect(room.engine!.isGameFinished()).toBe(true);
    const state = room.engine!.getState() as SeepState;
    expect(state.teamScores).not.toBeNull();
  });

  it('keeps per-player views filtered mid-deal', () => {
    const { room } = seepRoom();
    room.startGame(room.hostId!);
    const ids = [...room.players.keys()];
    const viewN = room.engine!.getPlayerState(ids[0]!) as unknown as SeepPlayerView;
    // Before the announce the table is still face down.
    expect(viewN.phase).toBe('ANNOUNCE');
    expect(viewN.tableLoose).toHaveLength(0);
    expect(viewN.tableFaceDownCount).toBe(4);
    expect(viewN.bid).toBeNull();
    // Opponent hand values hidden.
    for (const id of viewN.handCardIds[ids[1]!] ?? []) {
      expect(viewN.knownCards[id]).toBeUndefined();
    }
    // Own hand visible.
    for (const id of viewN.handCardIds[ids[0]!] ?? []) {
      expect(viewN.knownCards[id]).toBeDefined();
    }
    // After the announce the table turns up.
    const state = room.engine!.getState() as SeepState;
    const opener = state.players[state.currentTurn]!.id;
    const bid = [...(state.hands[opener] ?? [])].sort((a, b) => b.rank - a.rank).find((x) => x.rank >= 9)!.rank;
    room.handleGameAction(opener, { type: 'ANNOUNCE', playerId: opener, value: bid } as unknown as GameAction);
    const view2 = room.engine!.getPlayerState(ids[0]!) as unknown as SeepPlayerView;
    expect(view2.tableLoose).toHaveLength(4);
    expect(view2.bid).toBe(bid);
  });
});

describe('Seep persistence', () => {
  it('round-trips a mid-deal room through a snapshot', async () => {
    const { room } = seepRoom();
    room.startGame(room.hostId!);
    // A few legal steps so the state is mid-deal.
    for (let i = 0; i < 4; i++) {
      const state = room.engine!.getState() as SeepState;
      const pid = state.players[state.currentTurn]!.id;
      room.handleGameAction(pid, bestAction(room, state, pid));
    }
    const snap = serializeRoom(room);
    expect(snap.gameId).toBe('seep');

    const store = new MemoryRoomStore();
    await store.save(room);
    const raw = JSON.parse((store as unknown as { map: Map<string, string> }).map.get('SEEP01')!) as typeof snap;
    expect(raw.engineState).not.toBeNull();
    expect((raw.engineState as { gameId: string }).gameId).toBe('seep');

    const restored = Room.fromSnapshot(snap);
    expect(restored.engine?.gameId).toBe('seep');
    expect(JSON.stringify(restored.engine!.getState())).toEqual(
      JSON.stringify(room.engine!.getState()),
    );
    // And the restored room keeps playing.
    const state = restored.engine!.getState() as SeepState;
    const pid = state.players[state.currentTurn]!.id;
    expect(() => restored.handleGameAction(pid, bestAction(restored as Room, state, pid))).not.toThrow();
  });
});
