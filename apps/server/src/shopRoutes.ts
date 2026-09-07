/**
 * HTTP surface for the shop: a stateless catalog/checkout REST fallback (used
 * by the standalone Shop page even outside a room) and the Stripe webhook.
 * The webhook is mounted with express.raw BEFORE the global express.json()
 * body parser — signature verification needs the exact raw bytes.
 */

import express, { Router, type Request, type Response } from 'express';
import { ShopService, type CatalogEntry, type PlayerProfile } from './shop.js';

function bearerToken(req: Request): string | null {
  const header = req.headers.authorization;
  if (header?.startsWith('Bearer ')) return header.slice(7);
  const q = req.query.token;
  return typeof q === 'string' && q.length > 0 ? q : null;
}

export function shopRouter(shop: ShopService, opts: { webhookSecret?: string }): Router {
  const router = Router();

  router.get('/catalog', async (req: Request, res: Response) => {
    const token = bearerToken(req);
    const resolved = await shop.resolveProfile(token);
    const catalog = shop.catalogFor(resolved.profile);
    res.json({
      ok: true,
      token: resolved.token,
      profile: publicProfile(resolved.profile),
      catalog,
      stripeEnabled: shop.stripeEnabled,
    });
  });

  router.post('/checkout', async (req: Request, res: Response) => {
    const token = bearerToken(req);
    if (!token) {
      res.status(401).json({ ok: false, error: 'token_required' });
      return;
    }
    const profile = await shop.profileForToken(token);
    if (!profile) {
      res.status(401).json({ ok: false, error: 'unknown_token' });
      return;
    }
    const sku = typeof req.body?.sku === 'string' ? req.body.sku : '';
    const result = await shop.purchase(profile.userId, sku);
    res.status(result.ok ? 200 : 400).json(result);
  });

  router.post(
    '/webhook',
    // Raw body: Stripe's signature covers the exact payload bytes.
    express.raw({ type: 'application/json', limit: '256kb' }),
    async (req: Request, res: Response) => {
      if (!opts.webhookSecret || !shop.stripeEnabled) {
        res.status(503).json({ ok: false, error: 'store_unavailable' });
        return;
      }
      const signature = req.headers['stripe-signature'];
      if (typeof signature !== 'string') {
        res.status(400).json({ ok: false, error: 'missing_signature' });
        return;
      }
      const raw = req.body as string | Buffer;
      const result = await shop.handleWebhook(
        Buffer.isBuffer(raw) ? raw.toString('utf8') : raw,
        signature,
        opts.webhookSecret,
      );
      if (!result.handled) {
        res.status(400).json({ ok: false, error: 'bad_signature' });
        return;
      }
      res.json({ ok: true, received: true });
    },
  );

  return router;
}

function publicProfile(profile: PlayerProfile): {
  userId: string;
  gamesPlayed: number;
  owned: string[];
  equipped: PlayerProfile['equipped'];
} {
  return {
    userId: profile.userId,
    gamesPlayed: profile.gamesPlayed,
    owned: profile.owned,
    equipped: profile.equipped,
  };
}

export type { CatalogEntry };
