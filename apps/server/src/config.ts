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
      try { process.loadEnvFile(candidate); } catch { /* malformed local env is reported by provider diagnostics */ }
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
  /** Debug capabilities are only ever enabled outside production. */
  debugEnabled: (process.env.NODE_ENV ?? 'development') !== 'production',
  /** LLM agent backend (OpenAI-compatible: vLLM / Ollama / cloud). When unset,
   *  AI seats play with built-in heuristic bots. */
  agentApiUrl: process.env.AGENT_API_URL ||
    (process.env.OPENCODE_API_KEY
      ? (process.env.OPENCODE_GO_BASE_URL || 'https://opencode.ai/zen/go/v1')
      : ''),
  agentApiKey: process.env.AGENT_API_KEY || process.env.OPENCODE_API_KEY || '',
  agentModel: process.env.AGENT_MODEL ||
    (process.env.OPENCODE_API_KEY ? (process.env.OPENCODE_GO_MODEL || 'mimo-v2.5') : 'qwen3-8b'),
  agentProvider: process.env.AGENT_PROVIDER ||
    (process.env.OPENCODE_API_KEY || (process.env.AGENT_API_URL ?? '').includes('opencode.ai/zen/go')
      ? 'opencode-go'
      : 'endpoint'),
  agentTimeoutMs: intEnv('AGENT_TIMEOUT_MS', 30_000),
  // Cabo prompts include the full filtered observation and every legal flush
  // candidate. Leave enough response budget for a short rationale plus the
  // required JSON; operators can still lower this with AGENT_MAX_TOKENS.
  agentMaxTokens: intEnv('AGENT_MAX_TOKENS', 4_096),
  agentMaxCandidates: intEnv('AGENT_MAX_CANDIDATES', 0) || undefined,
};

export type AppConfig = typeof config;
