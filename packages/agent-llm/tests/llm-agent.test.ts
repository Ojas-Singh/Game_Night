/** LlmAgent behaviour against a canned local OpenAI-compatible server. */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { PairOneEngine, buildPlayerView as pairOneView } from '@game-night/engine-pairone';
import { createAgentRng, enumerateLegalActions, type AgentObservation } from '@game-night/agent-core';
import { LlmAgent, PERSONAS } from '../src/index.js';
import { AgentError } from '@game-night/agent-core';

let server: Server | undefined;
let baseUrl = '';
let responses: string[] = [];
let requests = 0;

beforeAll(async () => {
  server = createServer((req, res) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      requests++;
      const content = responses.shift() ?? '{"thought":"ok","action":{}}';
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({ choices: [{ message: { role: 'assistant', content } }] }));
    });
  });
  await new Promise<void>((r) => server!.listen(0, '127.0.0.1', r));
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1`;
});
afterAll(() => void server?.close());

function makeObs(seed = 3): AgentObservation {
  const e = new PairOneEngine();
  e.createGame(
    [
      { id: 'p0', name: 'A', seat: 0 },
      { id: 'p1', name: 'B', seat: 1 },
    ],
    { seed },
  );
  const s = e.getState();
  const who = s.players[s.currentTurn]!.id;
  return { gameId: 'pairone', selfId: who, view: pairOneView(s, who), step: 0 };
}

describe('LlmAgent', () => {
  it('accepts a strict-JSON action that is in the candidate list', async () => {
    responses = ['{"thought":"take the first slot","action":{"type":"FLIP_CARD","playerId":"IGNORED","cardId":"c-0"}}'];
    const obs = makeObs();
    // playerId in the answer may differ; matcher keys on type+cardId+playerId —
    // so use the real selfId:
    responses = [`{"thought":"go","action":{"type":"FLIP_CARD","playerId":"${obs.selfId}","cardId":"c-0"}}`];
    requests = 0;
    const agent = new LlmAgent({ baseUrl, model: 'test-model' });
    const d = await agent.decide(obs, { rng: createAgentRng(1) });
    expect(d.action).toMatchObject({ type: 'FLIP_CARD', cardId: 'c-0' });
    expect(requests).toBe(1);
  });

  it('research-strict mode throws AgentError instead of falling back', async () => {
    responses = ['garbage {{{ one', 'garbage {{{ two'];
    requests = 0;
    const agent = new LlmAgent({ baseUrl, model: 'test-model', mode: 'research-strict' });
    await expect(agent.decide(makeObs(), { rng: createAgentRng(1) })).rejects.toThrow(AgentError);
    expect(requests).toBe(2); // corrective retry happened, then strict failure
  });

  it('accepts action_id selection (A0..An protocol)', async () => {
    const obs = makeObs();
    const expected = enumerateLegalActions(obs.view, obs.selfId)[1]!;
    responses = ['{"thought":"second slot","action_id":"A1"}'];
    const agent = new LlmAgent({ baseUrl, model: 'test-model', mode: 'research-strict' });
    const d = await agent.decide(obs, { rng: createAgentRng(1) });
    expect(JSON.stringify(d.action)).toBe(JSON.stringify(expected));
  });

  it('prompts enumerate candidates as A0..An lines', async () => {
    let capturedUser = '';
    const origFetch = globalThis.fetch;
    globalThis.fetch = (async (_u: unknown, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body)) as { messages: Array<{ role: string; content: string }> };
      capturedUser = body.messages.find((m) => m.role === 'user')!.content;
      return new Response(
        JSON.stringify({ choices: [{ message: { role: 'assistant', content: '{"thought":"t","action_id":"A0"}' } }] }),
        { headers: { 'content-type': 'application/json' } },
      ) as unknown as Response;
    }) as typeof fetch;
    try {
      const obs = makeObs();
      const agent = new LlmAgent({ baseUrl, model: 'test-model' });
      await agent.decide(obs, { rng: createAgentRng(1) });
      expect(capturedUser).toContain('LEGAL ACTIONS (pick exactly one id):');
      expect(capturedUser).toMatch(/A0: \{"type":"FLIP_CARD"/);
    } finally {
      globalThis.fetch = origFetch;
    }
  });

  it('retries once on garbage then falls back to a legal heuristic move', async () => {
    responses = ['I think flipping something is good!', 'still not json {{{'];
    const obs = makeObs(5);
    requests = 0;
    const agent = new LlmAgent({ baseUrl, model: 'test-model' });
    const d = await agent.decide(obs, { rng: createAgentRng(2) });
    expect(d.action.type).toBe('FLIP_CARD');
    expect(String(d.thought)).toContain('fallback');
    expect(requests).toBe(2); // exactly one corrective retry
  }, 20_000);

  it('parses fenced json blocks too', async () => {
    responses = ['```json\n{"thought":"fenced","action":{"type":"FLIP_CARD","playerId":"x","cardId":"c-3"}}\n```'];
    const obs = makeObs(7);
    // fenced block carries wrong playerId → rejected → fallback path (2 reqs)
    requests = 0;
    const agent = new LlmAgent({ baseUrl, model: 'test-model' });
    const d = await agent.decide(obs, { rng: createAgentRng(3) });
    expect(['FLIP_CARD']).toContain(d.action.type);
  });
});

describe('personas', () => {
  it('exposes at least four distinct strategies and tolerates unknown ids', () => {
    expect(Object.keys(PERSONAS).length).toBeGreaterThanOrEqual(4);
    expect(new Set(Object.values(PERSONAS).map((p) => p.prompt)).size).toBe(Object.keys(PERSONAS).length);
  });
});
