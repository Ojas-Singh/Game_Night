import { describe, expect, it } from 'vitest';
import { CaboEngine } from '@game-night/engine-cabo';
import { createAgentRng, enumerateLegalActions } from '@game-night/agent-core';
import { CaboHeuristicBot } from '../src/index.js';
import { relabelView } from '../src/laya-cabo.js';
import { memoryText, tableMemory } from '../src/laya-memory.js';

type Card = { id: string; rank: number; suit: string };

/**
 * The unseen pool of every player at every decision equals, rank by rank, the cards that player has not seen and
 * that are not public: it is exact, and it is computed from the player's own view only (no hidden card can leak,
 * since the view does not carry them).
 */
describe('Laya table memory', () => {
  for (const seed of [1, 2, 3, 4, 5, 6]) {
    it(`unseen pool is exact for every viewer (seed ${seed})`, () => {
      const n = 3 + (seed % 2);
      const e = new CaboEngine();
      e.createGame(Array.from({ length: n }, (_, i) => ({ id: `p${i}`, name: `P${i}`, seat: i })), { seed, firstTurnSeat: 0 });
      const bots = Object.fromEntries(Array.from({ length: n }, (_, i) => [`p${i}`, new CaboHeuristicBot({ persona: 'balanced', idSuffix: `${i}` })]));
      const rng = createAgentRng(seed);
      let checked = 0;
      for (let step = 0; step < 400; step++) {
        const s = e.getState() as unknown as {
          phase: string; deck: Card[]; discard: Card[]; drawnCard: Card | null; hands: Record<string, (Card | null)[]>;
          knowledge: Record<string, string[]>; players: { id: string }[]; currentTurn: number;
          pendingTransfers?: { fromPlayerId: string }[]; initialPeeksRemaining: string[];
        };
        if (s.phase === 'ROUND_REVEAL' || s.phase === 'ROUND_COMPLETE') break;
        for (const viewer of s.players.map((p) => p.id)) {
          const view = relabelView(e.getPlayerState(viewer), viewer);
          const m = tableMemory(view, viewer);
          const known = new Set(Object.keys(view.knownCards));
          const hidden = [...s.deck, ...Object.values(s.hands).flat().filter((c): c is Card => !!c),
            ...(s.drawnCard ? [s.drawnCard] : [])].filter((c) => !known.has(c.id));
          for (let r = 1; r <= 13; r++) expect(m.unseen.get(r), `rank ${r} for ${viewer}`).toBe(hidden.filter((c) => c.rank === r).length);
          expect(memoryText(view, viewer).length).toBeLessThan(900);
          checked += 1;
        }
        const who = s.initialPeeksRemaining.length ? s.initialPeeksRemaining[0]!
          : s.pendingTransfers?.length ? s.pendingTransfers[0]!.fromPlayerId : s.players[s.currentTurn]!.id;
        const view = e.getPlayerState(who);
        let action = bots[who]!.decide({ gameId: 'cabo', selfId: who, view, step }, { rng }).action;
        if (!e.handleAction({ ...action, playerId: who }).ok) {
          const legal = enumerateLegalActions(view, who);
          if (!legal.length) break;
          action = legal[0]!;
          e.handleAction({ ...action, playerId: who });
        }
      }
      expect(checked).toBeGreaterThan(20);
    });
  }
});
