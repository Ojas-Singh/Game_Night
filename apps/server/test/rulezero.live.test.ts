/**
 * Integration gate (Milestone 4 §32): a GameSpec game is created and played
 * LIVE through the server's RuleZeroEngine adapter against the REAL python
 * service subprocess. Skipped when the research venv is unavailable so CI
 * without open_spiel still passes.
 */
import { describe, it, expect, afterAll } from 'vitest';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { RuleZeroEngine } from '../src/rulezeroEngine.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const VENV = process.env.RULEZERO_PYTHON ??
  path.resolve(here, '../../../research/rulezero/.venv/bin/python');

const hasPython = existsSync(VENV);

describe.skipIf(!hasPython)('RuleZeroEngine live adapter', () => {
  const engines: RuleZeroEngine[] = [];
  const mk = async () => {
    const e = new RuleZeroEngine();
    engines.push(e);
    await e.createGame([
      { id: 'pA', name: 'Alice', seat: 0 },
      { id: 'pB', name: 'Bob', seat: 1 },
    ]);
    return e;
  };

  afterAll(() => {
    for (const e of engines) e.dispose();
  });

  it('plays kuhnish to terminal through the real service', async () => {
    const e = await mk();
    expect(e.specHashValue).toMatch(/^[0-9a-f]{64}$/);
    let view = await e.getPlayerStateAsync('pA');
    expect(view.gameId).toBe('rulezero');
    expect(view.rz.isTerminal).toBe(false);
    // hand0 must be visible ONLY in p0's view
    const mine = view.rz.zones.find((z) => z.id === 'hand0');
    expect(mine?.cards?.length).toBe(1);
    const theirs = await e.getPlayerStateAsync('pB');
    const hiddenMine = theirs.rz.zones.find((z) => z.id === 'hand0');
    expect(hiddenMine?.cards).toBeUndefined();
    expect(hiddenMine?.count).toBe(1);

    // drive to terminal with random-but-legal actions
    let guard = 0;
    let current = 'pA';
    while (!e.isGameFinished() && guard++ < 40) {
      const v = await e.getPlayerStateAsync(current);
      if (v.rz.isTerminal) break;
      if (v.rz.currentActor !== v.rz.player) {
        // not this seat's decision — flip driver
        current = current === 'pA' ? 'pB' : 'pA';
        continue;
      }
      const pick =
        v.rz.candidates[Math.floor(Math.random() * v.rz.candidates.length)];
      const r = await e.handleActionAsync(current, pick.environmentActionId);
      expect(r.ok).toBe(true);
    }
    expect(e.isGameFinished()).toBe(true);
    const scores = e.calculateScore();
    expect(Object.keys(scores).sort()).toEqual(['pA', 'pB']);
    expect(scores.pA + scores.pB).toBe(0); // zero-sum
  }, 30_000);

  it('rejects actions from unseated players', async () => {
    const e = engines[0] ?? (await mk());
    const r = await e.handleActionAsync('ghost', 0);
    expect(r.ok).toBe(false);
  });
});
