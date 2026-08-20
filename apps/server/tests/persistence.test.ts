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
    // Both peek, then p1 draws.
    room.handleGameAction(p1.id, { type: 'PEEK_STARTING', playerId: p1.id, cardIndexes: [0, 1] });
    room.handleGameAction(p2.id, { type: 'PEEK_STARTING', playerId: p2.id, cardIndexes: [0, 1] });
    room.handleGameAction(p1.id, { type: 'DRAW', playerId: p1.id });

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
    expect(after.hands[p1.id]!.length).toBe(before.hands[p1.id]!.length);
    expect(after.deck.length).toBe(before.deck.length);

    // The restored game keeps accepting actions.
    expect(() =>
      restored.handleGameAction(p1.id, { type: 'KEEP_DRAWN', playerId: p1.id, handIndex: 0 }),
    ).not.toThrow();
    const afterState = restored.engine!.getState();
    const currentId = afterState.players[afterState.currentTurn]!.id;
    // Either the turn advanced, or the discarded card legitimately triggered
    // a mandatory power that keeps it p1's move.
    expect(currentId === p2.id || afterState.pendingPower?.playerId === p1.id).toBe(true);

    // Hidden-information filtering still works after restore.
    const view = restored.engine!.getPlayerState(p2.id);
    const p1CardIds = view.handCardIds[p1.id]!;
    const leaked = p1CardIds.filter((id) => view.knownCards[id] !== undefined);
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
