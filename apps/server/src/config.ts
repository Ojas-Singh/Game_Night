/** Server configuration from environment variables — never hardcode hosts. */

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
  agentApiUrl: process.env.AGENT_API_URL ?? '',
  agentApiKey: process.env.AGENT_API_KEY ?? '',
  agentModel: process.env.AGENT_MODEL ?? 'qwen3-8b',
};

export type AppConfig = typeof config;
