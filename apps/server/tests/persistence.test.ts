import { describe, expect, it } from 'vitest';
import { Room } from '../src/room.js';
import { RoomManager } from '../src/roomManager.js';
import { MemoryRoomStore, serializeRoom } from '../src/persistence.js';

describe('room persistence', () => {
  it('round-trips a lobby room through snapshot + restore', async () => {
    const room = new Room({ roomId: 'PERSIST' });
    const { player: p1 } = room.addPlayer('Alice');
    const { player: p2 } = room.addPlayer('Bob');
    room.setName(p2.id, 'Bobby');
    room.setReady(p1.id, true);
    room.playerChat(p1.id, 'hello again');

    const store = new MemoryRoomStore();
    await store.save(room);

    // Simulate an app restart: fresh manager restores from the store.
    const mgr = new RoomManager(3_600_000);
    mgr.attachStore(store);
    expect(await mgr.restoreAll()).toBe(1);
    const restored = mgr.getRoom('PERSIST')!;
    expect(restored).toBeDefined();
    expect(restored.hostId).toBe(p1.id);
    const names = [...restored.players.values()].map((p) => p.name).sort();
    expect(names).toEqual(['Alice', 'Bobby']);
    // Secret tokens survived so both players can reconnect.
    expect([...restored.players.values()].some((p) => p.token === p1.token)).toBe(true);
    expect([...restored.players.values()].some((p) => p.token === p2.token)).toBe(true);
    // Chat history survived.
    expect(restored.chat.some((m) => m.text === 'hello again')).toBe(true);
    // Restored players are disconnected until they reconnect with tokens.
    expect([...restored.players.values()].every((p) => !p.connected)).toBe(true);
  });

  it('restores a mid-game room and the game is still playable', async () => {
    const room = new Room({ roomId: 'MIDGME' });
    const { player: p1 } = room.addPlayer('A');
    const { player: p2 } = room.addPlayer('B');
    room.startGame(room.hostId!);
    // The starting peek is automatic (bottom row); the opener is random.
    const firstTurnId = room.engine!.getState().players[room.engine!.getState().currentTurn]!.id;
    const otherId = firstTurnId === p1.id ? p2.id : p1.id;
    room.handleGameAction(firstTurnId, { type: 'DRAW', playerId: firstTurnId });

    const before = room.engine!.getState();
    const store = new MemoryRoomStore();
    await store.save(room);

    const mgr = new RoomManager(3_600_000);
    mgr.attachStore(store);
    await mgr.restoreAll();
    const restored = mgr.getRoom('MIDGME')!;
    expect(restored.engine).not.toBeNull();
    const after = restored.engine!.getState();
    expect(after.phase).toBe(before.phase);
    expect(after.revision).toBe(before.revision);
    expect(after.hands[firstTurnId]!.length).toBe(before.hands[firstTurnId]!.length);
    expect(after.deck.length).toBe(before.deck.length);

    // The restored game keeps accepting actions (KEEP_DRAWN, then resolve
    // any pending power / end the turn as the state requires).
    expect(() =>
      restored.handleGameAction(firstTurnId, { type: 'KEEP_DRAWN', playerId: firstTurnId, handIndex: 0 }),
    ).not.toThrow();
    const st = restored.engine!.getState();
    if (st.phase === 'POWER_PENDING') {
      // The replaced card carried a power — perform it (peek own first card).
      const own = st.hands[firstTurnId]!.find((c): c is NonNullable<typeof c> => !!c);
      if (st.pendingPower!.power === 'PEEK_OWN' && own) {
        restored.handleGameAction(firstTurnId, {
          type: 'POWER_APPLY',
          playerId: firstTurnId,
          payload: { power: 'PEEK_OWN', cardId: own.id },
        });
      }
    }
    if (restored.engine!.getState().phase === 'TURN_END') {
      restored.handleGameAction(firstTurnId, { type: 'END_TURN', playerId: firstTurnId });
    }
    const afterState = restored.engine!.getState();
    const currentId = afterState.players[afterState.currentTurn]!.id;
    // Either the turn advanced, or the discarded card legitimately triggered
    // a mandatory power that keeps it on the opener's move.
    expect(currentId === otherId || afterState.pendingPower?.playerId === firstTurnId).toBe(true);

    // Hidden-information filtering still works after restore.
    const view = restored.engine!.getPlayerState(otherId);
    const firstTurnCardIds = view.handCardIds[firstTurnId]!;
    const leaked = firstTurnCardIds.filter((id) => view.knownCards[id] !== undefined);
    expect(leaked).toEqual([]);
  });

  it('reconnects into a restored room with the original token', async () => {
    const room = new Room({ roomId: 'RECONE' });
    const { player } = room.addPlayer('Solo');
    const store = new MemoryRoomStore();
    await store.save(room);

    const mgr = new RoomManager(3_600_000);
    mgr.attachStore(store);
    await mgr.restoreAll();
    const restored = mgr.getRoom('RECONE')!;
    const { reconnected } = restored.addPlayer(undefined, player.token);
    expect(reconnected).toBe(true);
    expect(restored.players.get(player.id)!.connected).toBe(true);
  });

  it('skips snapshots with unknown versions instead of restoring garbage', async () => {
    const store = new MemoryRoomStore();
    const snap = serializeRoom(new Room({ roomId: 'FUTVER' }));
    // Directly inject an unknown-version payload under the hood.
    const raw = JSON.stringify({ ...snap, version: 999 });
    const anyStore = store as unknown as { map: Map<string, string> };
    anyStore.map.set('FUTVER', raw);

    const mgr = new RoomManager(3_600_000);
    mgr.attachStore(store);
    expect(await mgr.restoreAll()).toBe(0);
    expect(mgr.getRoom('FUTVER')).toBeUndefined();
  });
});
