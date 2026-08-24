/**
 * HTTP + WebSocket entry point.
 *
 * - Serves the built web client (production) from /app/web.
 * - Exposes /healthz for Coolify checks.
 * - WebSocket via Socket.IO (works through the Coolify proxy).
 */

import { createServer } from 'node:http';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { dirname } from 'node:path';
import express from 'express';
import { gameLabRouter } from './gameLab.js';
import { Server as SocketServer } from 'socket.io';
import { config } from './config.js';
import { log } from './log.js';
import { RoomManager } from './roomManager.js';
import { registerSocketHandlers } from './socket.js';

const app = express();
app.disable('x-powered-by');
app.get('/healthz', (_req, res) => res.json({ ok: true }));

const rooms = new RoomManager(config.roomTtlMs);

// Persistence: Redis in production, in-memory fallback otherwise.
if (config.redisUrl) {
  const { Redis } = await import('ioredis');
  const { RedisRoomStore } = await import('./persistence.js');
  const redis = new Redis(config.redisUrl, { lazyConnect: false, maxRetriesPerRequest: 3 });
  redis.on('error', (err: Error) => log.error('redis_error', { error: err.message }));
  rooms.attachStore(new RedisRoomStore(redis, Math.ceil(config.roomTtlMs / 1000)));
  log.info('redis_attached', { url: redact(config.redisUrl) });
} else {
  const { MemoryRoomStore } = await import('./persistence.js');
  rooms.attachStore(new MemoryRoomStore());
}

// Restore persisted rooms before accepting traffic.
await rooms.restoreAll();
rooms.startSweeper();

if (config.debugEnabled) {
  // Dev-only debug endpoints. In production these do not exist at all.
  const { debugRouter } = await import('./debug.js');
  app.use(express.json());
  app.use('/api/lab', gameLabRouter());
  app.use('/debug', debugRouter(rooms));
  log.warn('debug_mode_enabled', { note: 'privileged endpoints active (non-production)' });
}

// Web client location is resolved relative to THIS module so the server
// works from any cwd (Docker WORKDIR /app, local dev, PM2, ...).
// dist/index.js → sibling ../web (i.e. apps/server/web).
const webDist = join(dirname(fileURLToPath(import.meta.url)), '..', 'web');
// Backwards compat for deployments that ran from inside apps/server.
const webDistLegacy = join(process.cwd(), 'web');
const webRoot = existsSync(webDist) ? webDist : existsSync(webDistLegacy) ? webDistLegacy : null;
if (webRoot) {
  app.use(express.static(webRoot));
  // Never let debug paths fall through to the SPA — they must plainly 404
  // in production rather than look like valid endpoints.
  app.get('/debug/*', (_req, res) => res.status(404).json({ error: 'not found' }));
  // SPA fallback: every non-socket route renders the client.
  app.get('*', (_req, res) => res.sendFile(join(webRoot, 'index.html')));
} else {
  app.get('/', (_req, res) => res.send('Game Night server — web client not bundled'));
}

const httpServer = createServer(app);
const io = new SocketServer(httpServer, {
  cors: { origin: true, credentials: true },
});

registerSocketHandlers(io, rooms);

httpServer.listen(config.port, () => {
  log.info('server_started', { port: config.port, env: config.nodeEnv, redis: !!config.redisUrl });
});

for (const signal of ['SIGTERM', 'SIGINT'] as const) {
  process.on(signal, () => {
    log.info('server_stopping', { signal });
    rooms.stopSweeper();
    io.close();
    httpServer.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 3000).unref();
  });
}

process.on('uncaughtException', (err) => {
  log.error('uncaught_exception', { error: err.message, stack: err.stack });
});
process.on('unhandledRejection', (reason) => {
  log.error('unhandled_rejection', { reason: String(reason) });
});

/** Hide credentials in logged Redis URLs. */
function redact(url: string): string {
  try {
    const u = new URL(url);
    if (u.password) u.password = '***';
    return u.toString();
  } catch {
    return '(invalid url)';
  }
}
