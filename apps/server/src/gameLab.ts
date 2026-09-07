/**
 * Game Lab service client + routes (Phase 3A §2/§12).
 *
 * One shared `rulezero.service` subprocess answers stateless lab ops
 * (catalog / variant / simulate). Live game play still uses per-room
 * sessions through rulezeroEngine — this module is read-only research UI.
 */
import { randomUUID } from 'node:crypto';
import { Router, type Request, type Response } from 'express';
import { RuleZeroClient } from './rulezeroClient.js';

export interface GalleryCard {
  id: string;
  title: string;
  blurb: string;
  tags: string[];
  specHash: string;
  mutations: string[];
}

interface SimStats {
  episodes: number;
  unfinished: number;
  wins: Record<string, number>;
  tiesPct: number;
  avgReturns: Record<string, number>;
  meanGameLength: number;
  decisionsPerGame: number;
  wallSeconds: number;
}

const lab = new RuleZeroClient(15_000);

/**
 * One-shot tokens for launching a live RuleZero room with a gallery
 * (possibly mutated) spec. Tokens are consumed exactly once at deal time.
 */
const pendingSpecs = new Map<string, { spec: object; expires: number }>();

export function stageRulezeroSpec(spec: object): string {
  for (const [key, value] of pendingSpecs) if (value.expires < Date.now()) pendingSpecs.delete(key);
  if (pendingSpecs.size >= 1000) throw new Error('Too many pending launches');
  const token = randomUUID();
  pendingSpecs.set(token, { spec, expires: Date.now() + 600_000 });
  return token;
}

export function takeRulezeroSpec(token: string | undefined): object | undefined {
  if (!token) return undefined;
  const spec = pendingSpecs.get(token);
  pendingSpecs.delete(token);
  return spec && spec.expires > Date.now() ? spec.spec : undefined;
}

async function specFor(
  id: string,
  params: Record<string, unknown>,
): Promise<object> {
  const v = await lab.ask<{ spec: object }>({
    op: 'labVariant', id, params,
  });
  return v.spec;
}

function wrap(fn: (req: Request) => Promise<unknown>) {
  return async (req: Request, res: Response) => {
    try {
      res.json(await fn(req));
    } catch (err) {
      res.status(400).json({ error: String((err as Error).message ?? err) });
    }
  };
}

export function gameLabRouter(): Router {
  const r = Router();
  r.get('/checkpoints', wrap(async () => lab.ask({ op: 'labCheckpoints' })));
  r.get('/learning/runs', wrap(async () => lab.ask({ op: 'labLearningRuns' })));
  const operator = (req: Request) => {
    const token = process.env.RULEZERO_OPERATOR_TOKEN;
    if (!token || req.headers.authorization !== `Bearer ${token}`) throw new Error('Operator access required');
  };
  r.post('/learning/runs', wrap(async (req) => { operator(req); return lab.ask({ op: 'labTrainStart', config: req.body }); }));
  r.post('/jobs/:id/cancel', wrap(async (req) => { operator(req); return lab.ask({ op: 'labJobCancel', id: req.params.id }); }));
  // GET /api/lab/games → gallery cards
  r.get('/games', wrap(async () => {
    const res = await lab.ask<{ games: GalleryCard[] }>({ op: 'labCatalog' });
    return { games: res.games };
  }));

  // GET /api/lab/games/:id → full metadata incl. mutation grid
  r.get('/games/:id', wrap(async (req) => {
    const res = await lab.ask<{ game: object }>({
      op: 'labGet', id: req.params.id,
    });
    return res.game;
  }));

  // POST /api/lab/variant { id, params } → mutated validated spec
  r.post('/variant', wrap(async (req) => {
    const { id, params } = req.body as { id: string; params?: Record<string, unknown> };
    const res = await lab.ask<{ spec: object; specHash: string }>({
      op: 'labVariant', id, params: params ?? {},
    });
    return res;
  }));

  // POST /api/lab/games/:id/room { params } → one-shot room-launch token
  r.post('/games/:id/room', wrap(async (req) => {
    const params = (req.body?.params ?? {}) as Record<string, unknown>;
    const v = await lab.ask<{ spec: object }>({
      op: 'labVariant', id: req.params.id as string, params,
    });
    const token = stageRulezeroSpec(v.spec);
    return { ok: true, token };
  }));

  r.post('/compile/jobs', wrap(async (req) => lab.ask({ op: 'labCompileStart', text: req.body?.text })));
  r.get('/jobs/:id', wrap(async (req) => lab.ask({ op: 'labJobGet', id: req.params.id })));
  r.post('/compile/jobs/:id/revise', wrap(async (req) => lab.ask({ op: 'labCompileRevise', id: req.params.id, text: req.body?.text, answers: req.body?.answers })));
  r.post('/compile/jobs/:id/accept', wrap(async (req) => lab.ask({ op: 'labCompileAccept', id: req.params.id, acknowledged: req.body?.acknowledged })));
  // Compatibility route starts the same asynchronous production compiler.
  r.post('/compile', wrap(async (req) => lab.ask({ op: 'labCompileStart', text: req.body?.text })));

  // POST /api/lab/shared { galleryId, params } → persistent share id
  r.post('/shared', wrap(async (req) => {
    const { galleryId, params } = req.body as {
      galleryId: string; params?: Record<string, unknown>;
    };
    const body = req.body as {
      galleryId?: string; spec?: object; compileJobId?: string; params?: Record<string, unknown>;
    };
    return await lab.ask<{ shareId: string; specHash: string }>({
      op: 'labShare',
      galleryId: body.galleryId,
      params: body.params ?? {},
      ...(body.compileJobId ? { compileJobId: body.compileJobId } : {}),
    });
  }));

  // GET /api/lab/shared/:shareId → resolved spec + hash (§38)
  r.get('/shared/:shareId', wrap(async (req) => {
    const res = await lab.ask<{
      spec: object; specHash: string; title?: string;
      params?: Record<string, unknown>;
    }>({ op: 'labResolveShared', shareId: req.params.shareId as string });
    return { specHash: res.specHash, title: res.title, params: res.params };
  }));

  // POST /api/lab/shared/:shareId/room → one-shot launch token
  r.post('/shared/:shareId/room', wrap(async (req) => {
    const res = await lab.ask<{ spec: object }>({
      op: 'labResolveShared', shareId: req.params.shareId as string,
    });
    const token = stageRulezeroSpec(res.spec);
    return { ok: true, token };
  }));

  // GET /api/lab/games/:id/strategy?iterations=300 → solver profile
  r.get('/games/:id/strategy', wrap(async (req) => {
    const iterations = Math.min(
      Math.max(50, Number(req.query.iterations ?? 300)), 20_000);
    const res = await lab.ask<{
      samples: {
        infoState: string;
        candidates: { label: string; prob: number }[];
      }[];
      meta: { nashConv?: number | null; states?: number };
    }>({ op: 'labStrategySamples',
         id: req.params.id as string,
         iterations, k: 4,
         spec: await specFor(req.params.id as string, {}) });
    return {
      nashConv: res.meta?.nashConv ?? null,
      states: res.meta?.states ?? 0,
      iterations,
      samples: res.samples,
    };
  }));

  // POST /api/lab/simulate { spec|id, agents, episodes, seed } → stats
  r.post('/simulate', wrap(async (req) => {
    const body = req.body as {
      spec?: object; id?: string; params?: Record<string, unknown>;
      agents?: { agent: string }[];
      episodes?: number; seed?: number;
    };
    let spec = body.spec;
    if (!spec && body.id) {
      // Variant with params, or the base spec when params are empty.
      spec = await specFor(body.id as string, body.params ?? {});
    }
    if (!spec) throw new Error('provide spec or id');
    const agents = body.agents ?? [
      { agent: 'random' }, { agent: 'first' },
    ];
    const res = await lab.ask<{ job: object }>({
      op: 'labSimulateStart',
      spec,
      agents,
      episodes: Math.min(Math.max(1, Number(body.episodes ?? 100)), 20_000),
      seed: Number(body.seed ?? 42),
    });
    return res;
  }));
  return r;
}
