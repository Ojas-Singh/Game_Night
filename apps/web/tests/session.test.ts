import { beforeEach, describe, expect, it } from 'vitest';

/** Minimal localStorage shim for Node. */
const store = new Map<string, string>();
const localStorageShim = {
  getItem: (k: string) => store.get(k) ?? null,
  setItem: (k: string, v: string) => void store.set(k, v),
  removeItem: (k: string) => void store.delete(k),
};
Object.defineProperty(globalThis, 'localStorage', { value: localStorageShim, configurable: true });

describe('session persistence (playerSessionToken)', () => {
  beforeEach(() => store.clear());

  it('round-trips a session for a room', async () => {
    const { loadSession, saveSession, clearSession } = await import('../src/session.js');
    saveSession({ roomId: 'ABC123', playerId: 'p1', playerToken: 'secret-token', name: 'Ojas' });
    const loaded = loadSession('ABC123');
    expect(loaded).toMatchObject({ playerId: 'p1', playerToken: 'secret-token' });
    clearSession('ABC123');
    expect(loadSession('ABC123')).toBeNull();
  });

  it('does not leak a session into another room', async () => {
    const { loadSession, saveSession } = await import('../src/session.js');
    saveSession({ roomId: 'ROOM01', playerId: 'p1', playerToken: 'tok', name: 'A' });
    expect(loadSession('OTHER9')).toBeNull();
  });

  it('rejects malformed stored data instead of crashing', async () => {
    const { loadSession } = await import('../src/session.js');
    store.set('game-night:room:BROKEN1', '{not json');
    expect(loadSession('BROKEN1')).toBeNull();
    // Session bound to a different room id is ignored.
    store.set('game-night:room:X', JSON.stringify({ roomId: 'Y', playerId: 'p', playerToken: 't' }));
    expect(loadSession('X')).toBeNull();
  });

  it('remembers the preferred display name across rooms', async () => {
    const { loadName, saveName } = await import('../src/session.js');
    expect(loadName()).toBe('');
    saveName('Subee');
    expect(loadName()).toBe('Subee');
  });
});
