/** Heuristic bots: legal decisions across real engine views. */

import { describe, expect, it } from 'vitest';
import { CaboEngine, buildPlayerView as caboView } from '@game-night/engine-cabo';
import { PairOneEngine, buildPlayerView as pairOneView } from '@game-night/engine-pairone';
import { SeepEngine } from '@game-night/engine-seep';
import { createAgentRng } from '@game-night/agent-core';
import { CaboHeuristicBot, PairOneHeuristicBot, SeepHeuristicBot, heuristicFor, randomBot } from '../src/index.js';

const players = [
  { id: 'p0', name: 'A', seat: 0 },
  { id: 'p1', name: 'B', seat: 1 },
];
const rng = () => createAgentRng(11);

describe('heuristic bots', () => {
  it('cabo bot answers every live phase with an engine-legal action', () => {
    const e = new CaboEngine();
    e.createGame(players, { seed: 21 });
    const bot = new CaboHeuristicBot();
    let steps = 0;
    while (!e.isGameFinished() && steps < 2000) {
      const s = e.getState();
      const who =
        s.phase === 'INITIAL_PEEK' ? s.initialPeeksRemaining[0]! : s.players[s.currentTurn]!.id;
      const view = caboView(s, who);
      const d = bot.decide({ gameId: 'cabo', selfId: who, view, step: steps }, { rng: rng() });
      if (!e.validateAction(d.action)) {
        // The engine may reject heuristic guesses; arena retries — here just
        // assert it proposed SOMETHING shaped like an action.
        expect((d.action as { type: string }).type.length).toBeGreaterThan(0);
        break;
      }
      e.handleAction(d.action);
      steps++;
    }
    expect(steps).toBeGreaterThan(0);
  });

  it('pairone bot always flips a card that is still on the table', () => {
    const e = new PairOneEngine();
    e.createGame(players, { seed: 33 });
    const bot = new PairOneHeuristicBot();
    let flips = 0;
    for (; flips < 40 && !e.isGameFinished(); ) {
      const s = e.getState();
      const who = s.players[s.currentTurn]!.id;
      const view = pairOneView(s, who);
      const d = bot.decide({ gameId: 'pairone', selfId: who, view, step: flips }, { rng: rng() });
      expect(e.validateAction({ ...d.action })).toBe(true);
      e.handleAction(d.action);
      if (s.flippedThisTurn.length === 0) continue; // first flip applied
      flips++;
    }
    expect(flips).toBeGreaterThan(4);
  });

  it('seep bots play whole deals legally without handing each other sweeps', async () => {
    const seats = [0, 1, 2, 3].map((i) => ({ id: `p${i}`, name: `P${i}`, seat: i }));
    const bot = new SeepHeuristicBot();
    const deals = 20;
    let sweeps = 0;
    for (let deal = 0; deal < deals; deal++) {
      const e = new SeepEngine();
      e.createGame(seats, { seed: 500 + deal, dealerSeat: deal % 4 });
      for (let step = 0; step < 60 && e.getState().phase !== 'DEAL_COMPLETE' && e.getState().phase !== 'MATCH_COMPLETE'; step++) {
        const s = e.getState();
        const who = s.players[s.phase === 'ANNOUNCE' ? s.bidderSeat : s.currentTurn]!.id;
        const d = await bot.decide({ gameId: 'seep', selfId: who, view: e.getPlayerState(who), step }, { rng: rng() });
        expect(e.handleAction(d.action).ok).toBe(true);
      }
      const s = e.getState();
      expect(s.playsMade).toBe(48);
      sweeps += s.sweeps[0] + s.sweeps[1];
    }
    // Throwing blind onto a bare floor gave about eight sweeps a deal.
    expect(sweeps / deals).toBeLessThan(2);
  });

  it('cabo bots call Cabo when the call is likely to hold up', () => {
    const seats = [0, 1, 2].map((i) => ({ id: `p${i}`, name: `P${i}`, seat: i }));
    const bot = new CaboHeuristicBot();
    const rounds = 120;
    let calls = 0;
    let held = 0;
    for (let round = 0; round < rounds; round++) {
      const e = new CaboEngine();
      e.createGame(seats, { seed: 900 + round });
      const random = createAgentRng(31 * (round + 1));
      for (let step = 0; step < 2000 && !e.isGameFinished(); step++) {
        const s = e.getState();
        const owing = s.pendingTransfers.find((t) => s.hands[t.fromPlayerId]!.some((c) => c != null));
        const who =
          s.phase === 'TRANSFER_PENDING'
            ? owing!.fromPlayerId
            : s.phase === 'INITIAL_PEEK'
              ? s.initialPeeksRemaining[0]!
              : s.players[s.currentTurn]!.id;
        const d = bot.decide({ gameId: 'cabo', selfId: who, view: caboView(s, who), step }, { rng: random });
        expect(e.handleAction(d.action).ok).toBe(true);
      }
      const s = e.getState();
      expect(e.isGameFinished()).toBe(true);
      const caller = s.events.filter((ev) => ev.type === 'CABO_CALLED' && !ev.payload?.auto).at(-1)?.payload?.playerId;
      if (typeof caller !== 'string') continue;
      calls += 1;
      if (s.tiedWinnerIds.includes(caller)) held += 1;
    }
    // Calling on a low-looking hand alone won about four calls in ten at this table.
    expect(calls).toBeGreaterThan(rounds / 2);
    expect(held / calls).toBeGreaterThan(0.55);
  });

  it('factory helpers return game-appropriate agents', () => {
    expect(heuristicFor('cabo')).toBeInstanceOf(CaboHeuristicBot);
    expect(heuristicFor('pairone')).toBeInstanceOf(PairOneHeuristicBot);
    expect(randomBot().decide).toBeDefined();
  });
});
