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
import express from 'express';
import { Server as SocketServer } from 'socket.io';
import { config } from './config.js';
import { log } from './log.js';
import { RoomManager } from './roomManager.js';
import { registerSocketHandlers } from './socket.js';

const app = express();
app.disable('x-powered-by');
app.get('/healthz', (_req, res) => res.json({ ok: true }));

const webDist = join(process.cwd(), 'web');
if (existsSync(webDist)) {
  app.use(express.static(webDist));
  // SPA fallback: every non-socket route renders the client.
  app.get('*', (_req, res) => res.sendFile(join(webDist, 'index.html')));
} else {
  app.get('/', (_req, res) => res.send('Game Night server — web client not bundled'));
}

const httpServer = createServer(app);
const io = new SocketServer(httpServer, {
  cors: { origin: true, credentials: true },
});

const rooms = new RoomManager(config.roomTtlMs);
rooms.startSweeper();

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
