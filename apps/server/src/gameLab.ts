/**
 * Game Lab service client + routes (Phase 3A §2/§12).
 *
 * One shared `rulezero.service` subprocess answers stateless lab ops
 * (catalog / variant / simulate). Live game play still uses per-room
 * sessions through rulezeroEngine — this module is read-only research UI.
 */
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { createInterface } from 'node:readline';
import { Router, type Request, type Response } from 'express';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const HOME = process.env.RULEZERO_HOME ??
  path.resolve(here, '../../../research/rulezero');
const PY = process.env.RULEZERO_PYTHON ??
  path.resolve(HOME, '.venv/bin/python');

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

class LabClient {
  private proc: ChildProcessWithoutNullStreams | null = null;
  private rl: ReturnType<typeof createInterface> | null = null;
  private queue: Promise<unknown> = Promise.resolve();
  private failures = 0;

  private ensure(): ChildProcessWithoutNullStreams {
    if (!this.proc) {
      const proc = spawn(PY, ['-m', 'rulezero.service'], {
        cwd: HOME,
        env: { ...process.env, PYTHONPATH: HOME },
      }) as ChildProcessWithoutNullStreams;
      // CRITICAL: an unhandled 'error' event (e.g. ENOENT when the python
      // service is unavailable in a deployment) would throw and take down
      // the whole game server. Record it and let in-flight asks reject.
      proc.on('error', (err: Error) => {
        console.error('[lab-service] spawn/pipe error:', err.message);
        this.failures++;
      });
      this.rl = createInterface(proc.stdout);
      proc.stderr.on('data', (d: Buffer) =>
        console.error('[lab-service]', d.toString().trim()));
      proc.on('exit', () => {
        this.proc = null;
        this.rl = null;
      });
      this.proc = proc;
    }
    return this.proc;
  }

  /** Strictly-ordered request/response; restarts once on a dead pipe. */
  ask<T>(msg: Record<string, unknown>): Promise<T> {
    const run = async (): Promise<T> => {
      const proc = this.ensure();
      return await new Promise<T>((resolve, reject) => {
        const timeout = setTimeout(
          () => reject(new Error('lab service timeout')), 120_000);
        const rl = this.rl!;
        const fail = (e: Error) => {
          clearTimeout(timeout);
          rl.off('line', onLine);
          proc.off('error', fail);
          reject(e);
        };
        proc.on('error', fail);
        const onLine = (line: string) => {
          clearTimeout(timeout);
          rl.off('line', onLine);
          proc.off('error', fail);
          try {
            const parsed = JSON.parse(line);
            if (parsed.ok === false) reject(new Error(parsed.error ?? 'error'));
            else resolve(parsed as T);
          } catch (e) {
            reject(e as Error);
          }
        };
        rl.on('line', onLine);
        proc.stdin.write(JSON.stringify(msg) + '\n');
      });
    };
    const next = this.queue.then(run, run);
    this.queue = next.catch(() => {});
    next.catch(() => { this.failures++; });
    return next;
  }
}

const lab = new LabClient();

/**
 * One-shot tokens for launching a live RuleZero room with a gallery
 * (possibly mutated) spec. Tokens are consumed exactly once at deal time.
 */
const pendingSpecs = new Map<string, object>();

export function stageRulezeroSpec(spec: object): string {
  const token = Math.random().toString(36).slice(2) + Date.now().toString(36);
  pendingSpecs.set(token, spec);
  return token;
}

export function takeRulezeroSpec(token: string | undefined): object | undefined {
  if (!token) return undefined;
  const spec = pendingSpecs.get(token);
  pendingSpecs.delete(token);
  return spec;
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

  // POST /api/lab/shared { galleryId, params } → persistent share id
  r.post('/shared', wrap(async (req) => {
    const { galleryId, params } = req.body as {
      galleryId: string; params?: Record<string, unknown>;
    };
    return await lab.ask<{ shareId: string; specHash: string }>({
      op: 'labShare', galleryId, params: params ?? {},
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
    const res = await lab.ask<{ stats: SimStats }>({
      op: 'labSimulate',
      spec,
      agents,
      episodes: Math.min(Math.max(1, Number(body.episodes ?? 100)), 20_000),
      seed: Number(body.seed ?? 42),
    });
    return res.stats;
  }));
  return r;
}
