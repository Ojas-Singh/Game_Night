/** Server configuration from environment variables — never hardcode hosts. */

import { existsSync } from 'node:fs';
import { join, dirname } from 'node:path';

// Local development runs from either the repository root or apps/server. Node's
// built-in loader preserves explicitly exported variables, while making the
// checked-out .env useful for `pnpm dev` and diagnostic scripts. Production
// deployments continue to provide their environment through the process.
function loadLocalEnv(): void {
  const nodeEnv = process.env.NODE_ENV ?? 'development';
  if (nodeEnv === 'production' || nodeEnv === 'test' || process.env.VITEST === 'true' || typeof process.loadEnvFile !== 'function') return;
  let dir = process.cwd();
  for (let i = 0; i < 4; i += 1) {
    const candidate = join(dir, '.env');
    if (existsSync(candidate)) {
      try { process.loadEnvFile(candidate); } catch { /* a malformed local .env is ignored */ }
      return;
    }
    const parent = dirname(dir);
    if (parent === dir) return;
    dir = parent;
  }
}

loadLocalEnv();

function intEnv(name: string, def: number): number {
  const v = process.env[name];
  if (!v) return def;
  const n = Number.parseInt(v, 10);
  return Number.isFinite(n) ? n : def;
}

export const config = {
  nodeEnv: process.env.NODE_ENV ?? 'development',
  port: intEnv('PORT', 3000),
  publicUrl: process.env.PUBLIC_URL ?? '',
  redisUrl: process.env.REDIS_URL ?? '',
  sessionSecret: process.env.SESSION_SECRET ?? '',
  /** Room expiry (ms) — abandoned rooms auto-delete. Default: 6 hours. */
  roomTtlMs: intEnv('ROOM_TTL_MINUTES', 360) * 60_000,
  /** Reconnect grace period (ms) before a player is considered gone. Default: 2 minutes. */
  reconnectGraceMs: intEnv('RECONNECT_GRACE_MINUTES', 2) * 60_000,
  /**
   * Directory holding the trained player (`player.onnx`, `judge.onnx`,
   * `model.json`, from `python -m gamelab_train.export`). Empty: AI seats are
   * the heuristic bots.
   */
  modelDir: process.env.GAME_MODEL_DIR ?? '',
  /** Deals of the hidden cards the model tries for each move when looking ahead. */
  modelSamples: intEnv('GAME_MODEL_SAMPLES', 16),
  /**
   * Key for the game lab (/lab), whose runs use this server's processor. In
   * production the lab exists only when this is set; elsewhere it is open
   * unless a key is set.
   */
  labKey: process.env.GAME_LAB_KEY ?? '',
  /** Debug capabilities are only ever enabled outside production. */
  debugEnabled: (process.env.NODE_ENV ?? 'development') !== 'production',
};

export type AppConfig = typeof config;
