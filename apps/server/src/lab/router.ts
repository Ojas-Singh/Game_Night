/**
 * The game lab's HTTP API, under /api/lab.
 *
 * Runs use this server's processor, so in production the lab exists only
 * when GAME_LAB_KEY is set, and every request must carry that key.
 */
import { timingSafeEqual } from 'node:crypto';
import { Router } from 'express';
import { games } from '@game-night/core';
import { LAB_LIMITS, LabRefusal, type LabRuns } from './runs.js';

export function labRouter(runs: LabRuns, key: string): Router {
  const r = Router();
  r.use((req, res, next) => {
    res.set('Cache-Control', 'no-store');
    if (!key) return next();
    const given = Buffer.from(String(req.get('x-lab-key') ?? ''));
    const wanted = Buffer.from(key);
    if (given.length === wanted.length && timingSafeEqual(given, wanted)) return next();
    res.status(401).json({ error: 'the lab needs its key' });
  });

  r.get('/', (_req, res) => {
    const all = games();
    res.json({
      games: all,
      modelGames: runs.modelGames(all.map((g) => g.id)),
      modelSamples: runs.modelSamples,
      limits: LAB_LIMITS,
    });
  });

  r.post('/runs', (req, res) => {
    try {
      res.json({ id: runs.start(req.body) });
    } catch (err) {
      if (err instanceof LabRefusal) res.status(err.status).json({ error: err.message });
      else throw err;
    }
  });

  r.get('/runs/:id', (req, res) => {
    const status = runs.status(req.params.id);
    if (status) res.json(status);
    else res.status(404).json({ error: 'no such run' });
  });

  r.delete('/runs/:id', (req, res) => {
    if (runs.cancel(req.params.id)) res.json({ ok: true });
    else res.status(404).json({ error: 'no such run' });
  });

  return r;
}
