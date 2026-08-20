/**
 * Development debug mode — NEVER enabled in production.
 *
 * Debug capabilities:
 *  - inspect authoritative state (full hidden state, dev only)
 *  - add fake players (bots that sit at the table)
 *  - force a specific deck order / RNG seed for the next game
 *  - force whose turn it is
 *
 * The express router is only mounted when config.debugEnabled (NODE_ENV
 * !== production). Coolify deploys run production, so these endpoints do
 * not exist there.
 */

import { Router } from 'express';
import type { RoomManager } from './roomManager.js';
import { log } from './log.js';

export function debugRouter(rooms: RoomManager): Router {
  const r = Router();

  // Inspect authoritative state for a room (includes hidden cards).
  r.get('/room/:roomId/state', (req, res) => {
    const room = rooms.getRoom(req.params.roomId);
    if (!room) return res.status(404).json({ error: 'not found' });
    res.json({
      roomId: room.id,
      players: [...room.players.values()].map((p) => ({
        id: p.id,
        name: p.name,
        connected: p.connected,
        ready: p.ready,
        // Token deliberately omitted — never expose secrets.
      })),
      engine: room.engine ? room.engine.getState() : null,
      scoreboard: room.scoreboard,
    });
  });

  // Add a fake player (dev only) — appears in the lobby, host can start.
  r.post('/room/:roomId/fake-player', (req, res) => {
    const room = rooms.getRoom(req.params.roomId);
    if (!room) return res.status(404).json({ error: 'not found' });
    try {
      const { player } = room.addPlayer(req.body?.name ?? `Bot ${room.players.size + 1}`);
      log.debug('fake_player_added', { roomId: room.id, playerId: player.id });
      res.json({ ok: true, playerId: player.id, name: player.name });
    } catch (err) {
      res.status(400).json({ error: err instanceof Error ? err.message : 'failed' });
    }
  });

  // Force RNG seed / deck for the next game.
  r.post('/room/:roomId/debug-options', (req, res) => {
    const room = rooms.getRoom(req.params.roomId);
    if (!room) return res.status(404).json({ error: 'not found' });
    const { seed } = req.body ?? {};
    room.debug = { ...(typeof seed === 'number' ? { seed } : {}) };
    res.json({ ok: true, debug: room.debug });
  });

  // List rooms with basic stats.
  r.get('/rooms', (_req, res) => {
    res.json({ count: rooms.size });
  });

  return r;
}
