/**
 * Anonymous browser identity: playerId + secret playerSessionToken are kept
 * per-room in localStorage so refreshes/reconnects restore the same seat.
 */

const KEY_PREFIX = 'game-night:room:';

export interface StoredSession {
  roomId: string;
  playerId: string;
  playerToken: string;
  name: string;
}

export function loadSession(roomId: string): StoredSession | null {
  try {
    const raw = localStorage.getItem(KEY_PREFIX + roomId);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as StoredSession;
    if (parsed.roomId !== roomId || !parsed.playerToken) return null;
    return parsed;
  } catch {
    return null;
  }
}

export function saveSession(session: StoredSession): void {
  try {
    localStorage.setItem(KEY_PREFIX + session.roomId, JSON.stringify(session));
  } catch {
    /* private mode etc. */
  }
}

export function clearSession(roomId: string): void {
  try {
    localStorage.removeItem(KEY_PREFIX + roomId);
  } catch {
    /* ignore */
  }
}

/** Preferred display name, remembered across rooms. */
export function loadName(): string {
  try {
    return localStorage.getItem('game-night:name') ?? '';
  } catch {
    return '';
  }
}

export function saveName(name: string): void {
  try {
    localStorage.setItem('game-night:name', name);
  } catch {
    /* ignore */
  }
}
