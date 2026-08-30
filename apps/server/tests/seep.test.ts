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

/** Legal greedy driver (same policy as the engine tests): capture first. */
function bestAction(state: SeepState, pid: string): GameAction {
  const hand = state.hands[pid] ?? [];
  const card = hand[0];
  if (!card) throw new Error(`no cards for ${pid}`);
  const v = captureValue(card);
  const loose = state.tableLoose;
  const single = loose.find((t) => captureValue(t) === v);
  if (single) {
    return { type: 'PLAY_CARD', playerId: pid, cardId: card.id, intent: { kind: 'CAPTURE', tableCardIds: [single.id] } } as unknown as GameAction;
  }
  for (let mask = 1; mask < 1 << loose.length; mask++) {
    const ids: string[] = [];
    let sum = 0;
    for (let i = 0; i < loose.length; i++) {
      if (mask & (1 << i)) {
        ids.push(loose[i]!.id);
        sum += captureValue(loose[i]!);
      }
    }
    if (sum === v) {
      return { type: 'PLAY_CARD', playerId: pid, cardId: card.id, intent: { kind: 'CAPTURE', tableCardIds: ids } } as unknown as GameAction;
    }
  }
  const house = state.houses.find((h) => h.total === v);
  if (house) {
    return { type: 'PLAY_CARD', playerId: pid, cardId: card.id, intent: { kind: 'CAPTURE_HOUSE', houseId: house.id } } as unknown as GameAction;
  }
  return { type: 'PLAY_CARD', playerId: pid, cardId: card.id, intent: { kind: 'LAY_DOWN' } } as unknown as GameAction;
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
    while (room.engine && !room.engine.isGameFinished() && guard++ < 80) {
      const state = room.engine.getState() as SeepState;
      const pid = state.players[state.currentTurn]!.id;
      expect(() => room.handleGameAction(pid, bestAction(state, pid))).not.toThrow();
    }
    expect(room.engine!.isGameFinished()).toBe(true);

    const state = room.engine!.getState() as SeepState;
    expect(state.phase).toBe('ROUND_COMPLETE');
    expect(state.teamScores).not.toBeNull();
    const tp = state.teamScores!;
    // Scoreboard: partners share the team score (seats 0/2 = team 0).
    const ids = [...room.players.keys()];
    expect(room.scoreboard[ids[0]!]).toBe(tp[0]);
    expect(room.scoreboard[ids[2]!]).toBe(tp[0]);
    expect(room.scoreboard[ids[1]!]).toBe(tp[1]);
    expect(room.scoreboard[ids[3]!]).toBe(tp[1]);
    // Conservation: card points + sweep bonuses across the whole 52-card deck.
    const captured = ids.flatMap((pid) => state.captures[pid] ?? []);
    expect(captured).toHaveLength(52);
    const pts = captured.reduce((sum, card) => sum + cardPoints(card, DEFAULT_SEEP_RULES), 0);
    expect(tp[0] + tp[1]).toBe(pts + 50 * (state.sweeps[0] + state.sweeps[1]));
  });

  it('plays a full deal driven by the real SeepHeuristicBot (live AI path)', async () => {
    const { SeepHeuristicBot } = await import('@game-night/agent-bots');
    const { createAgentRng } = await import('@game-night/agent-core');
    const { room } = seepRoom();
    room.startGame(room.hostId!);
    const rng = createAgentRng(1234);

    let guard = 0;
    while (room.engine && !room.engine.isGameFinished() && guard++ < 120) {
      const state = room.engine.getState() as SeepState;
      const pid = state.players[state.currentTurn]!.id;
      const view = room.engine.getPlayerState(pid) as unknown as SeepPlayerView;
      const agent = new SeepHeuristicBot({ persona: ['balanced', 'baiter', 'scholar', 'conservative'][guard % 4] });
      const decision = await agent.decide(
        { gameId: 'seep', selfId: pid, view, step: guard },
        { rng },
      );
      expect(room.engine.validateAction(decision.action as GameAction)).toBe(true);
      room.handleGameAction(pid, decision.action as GameAction);
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
    // Opponent hand values hidden.
    for (const id of viewN.handCardIds[ids[1]!] ?? []) {
      expect(viewN.knownCards[id]).toBeUndefined();
    }
    // Own hand visible; table visible.
    for (const id of viewN.handCardIds[ids[0]!] ?? []) {
      expect(viewN.knownCards[id]).toBeDefined();
    }
    expect(viewN.tableLoose.length).toBe(4);
  });
});

describe('Seep persistence', () => {
  it('round-trips a mid-deal room through a snapshot', async () => {
    const { room } = seepRoom();
    room.startGame(room.hostId!);
    // A couple of legal plays so the state is mid-deal.
    for (let i = 0; i < 3; i++) {
      const state = room.engine!.getState() as SeepState;
      const pid = state.players[state.currentTurn]!.id;
      room.handleGameAction(pid, bestAction(state, pid));
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
    expect(() => restored.handleGameAction(pid, bestAction(state, pid))).not.toThrow();
  });
});
