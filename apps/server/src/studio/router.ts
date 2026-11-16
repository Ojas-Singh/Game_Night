/**
 * HTTP side of the studio: uploading pictures and flattened layers, and
 * serving them back. Uploads need the player token of someone in the room.
 */

import express, { Router } from 'express';
import { STUDIO_LIMITS } from '@game-night/shared';
import type { RoomManager } from '../roomManager.js';
import { sniffImage, type AssetStore } from './assets.js';
import { log } from '../log.js';

export function studioRouter(rooms: RoomManager, assets: AssetStore): Router {
  const router = Router();

  router.post(
    '/:roomId/asset',
    express.raw({ type: ['image/png', 'image/jpeg', 'image/webp'], limit: STUDIO_LIMITS.maxAssetBytes }),
    async (req, res) => {
      const room = rooms.getRoom(String(req.params.roomId).toUpperCase());
      const token = req.get('x-player-token') ?? '';
      if (!room || !token || !room.participants.some((p) => p.token === token)) {
        res.status(403).json({ error: 'not in this room' });
        return;
      }
      const data = req.body;
      if (!Buffer.isBuffer(data) || !sniffImage(data)) {
        res.status(400).json({ error: 'send a PNG, JPEG or WebP image' });
        return;
      }
      try {
        const id = await assets.put(room.id, data);
        res.json({ id });
      } catch (err) {
        log.error('asset_save_failed', { roomId: room.id, error: String(err) });
        res.status(500).json({ error: 'could not store the image' });
      }
    },
  );

  router.get('/:roomId/asset/:id', async (req, res) => {
    const data = await assets.get(String(req.params.roomId).toUpperCase(), String(req.params.id));
    const type = data ? sniffImage(data) : null;
    if (!data || !type) {
      res.status(404).json({ error: 'not found' });
      return;
    }
    // Ids are random and never reused, so the bytes behind one never change.
    res.set('Cache-Control', 'private, max-age=86400, immutable');
    res.type(type).send(data);
  });

  return router;
}
