export { RandomBot } from './random-bot.js';
export { CaboHeuristicBot } from './cabo-heuristic-bot.js';
export type { CaboHeuristicOptions } from './cabo-heuristic-bot.js';
export { PairOneHeuristicBot } from './pairone-heuristic-bot.js';
export { MonteCarloBot } from './montecarlo-bot.js';
export type { SearchWorld, MonteCarloBotOptions } from './montecarlo-bot.js';

import type { GameId } from '@game-night/agent-core';
import type { GameAgent } from '@game-night/agent-core';
import { RandomBot } from './random-bot.js';
import { CaboHeuristicBot } from './cabo-heuristic-bot.js';
import { PairOneHeuristicBot } from './pairone-heuristic-bot.js';

/** Convenience: the default heuristic bot for a game. */
export function heuristicFor(gameId: GameId): GameAgent {
  return gameId === 'cabo' ? new CaboHeuristicBot() : new PairOneHeuristicBot();
}

/** The calibration floor. */
export function randomBot(): GameAgent {
  return new RandomBot();
}
