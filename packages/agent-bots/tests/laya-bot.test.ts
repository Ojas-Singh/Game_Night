import { createServer, type Server } from 'node:http';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { CaboEngine } from '@game-night/engine-cabo';
import { createAgentRng, enumerateLegalActions } from '@game-night/agent-core';
import { LayaCaboBot } from '../src/index.js';

/** A Cabo position where p0 holds a drawn card (several legal moves). */
function drawDecision() {
  const e = new CaboEngine();
  e.createGame(
    [0, 1, 2].map((i) => ({ id: `p${i}`, name: `P${i}`, seat: i })),
    { seed: 3, firstTurnSeat: 0 },
  );
  for (const id of ['p0', 'p1', 'p2']) e.handleAction({ type: 'PEEK_STARTING', playerId: id, cardIndexes: [0, 1] });
  e.handleAction({ type: 'DRAW', playerId: 'p0' });
  return e.getPlayerState('p0');
}

describe('LayaCaboBot', () => {
  let server: Server;
  let url = '';
  let lastBody: { state: string; questions: Record<string, { criteria: Record<string, string> }> } | null = null;

  beforeAll(async () => {
    server = createServer((req, res) => {
      let raw = '';
      req.on('data', (c) => (raw += c));
      req.on('end', () => {
        lastBody = JSON.parse(raw);
        // Always choose the last option: the discard (it is listed last).
        const criteria = lastBody!.questions.move!.criteria;
        const last = Object.keys(criteria).at(-1)!;
        res.setHeader('content-type', 'application/json');
        res.end(JSON.stringify({ answers: { move: last } }));
      });
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    const addr = server.address();
    url = `http://127.0.0.1:${typeof addr === 'object' && addr ? addr.port : 0}`;
  });
  afterAll(() => new Promise<void>((r) => server.close(() => r())));

  it('maps the service answer back to the matching legal move', async () => {
    const view = drawDecision();
    const bot = new LayaCaboBot({ url });
    const d = await bot.decide({ gameId: 'cabo', selfId: 'p0', view, step: 0 }, { rng: createAgentRng(1) });
    expect(d.meta?.source).toBe('model');
    expect(d.action.type).toBe('DISCARD_DRAWN');
    expect(lastBody!.state).toContain('You (to play)');
    expect(Object.values(lastBody!.questions.move!.criteria)).toContain(`Discard drawn ${lastBody!.state.match(/You drew (\S+)/)![1]}`);
  });

  it('falls back to the heuristic bot when the service is unreachable', async () => {
    const view = drawDecision();
    const bot = new LayaCaboBot({ url: 'http://127.0.0.1:9', timeoutMs: 500 });
    const d = await bot.decide({ gameId: 'cabo', selfId: 'p0', view, step: 0 }, { rng: createAgentRng(1) });
    expect(d.meta?.source).toBe('fallback');
    const legalTypes = enumerateLegalActions(view, 'p0').map((a) => a.type);
    expect(legalTypes).toContain(d.action.type);
  });
});
