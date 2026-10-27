import http from 'node:http';
import { createApp } from './app.js';
import { AuthService } from './auth.js';
import { loadConfig } from './config.js';
import { LobbyService } from './lobby.js';
import { attachWebSocket } from './realtime.js';
import { MemoryStore } from './store.js';

const config = loadConfig();
const store = new MemoryStore(config);
const auth = new AuthService({ config, store });
const lobby = new LobbyService({ config, store });
const app = createApp({ config, store, auth, lobby });
const server = http.createServer(app);
const { wss } = attachWebSocket({ server, config, store, auth, lobby });

let shuttingDown = false;

function shutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`[server] ${signal} received, shutting down`);

  for (const client of wss.clients) {
    try {
      client.close(1001, 'Server shutting down');
    } catch {
      client.terminate();
    }
  }
  wss.close();

  const forceExit = setTimeout(() => {
    console.error('[server] graceful shutdown timed out; closing active connections');
    server.closeAllConnections?.();
    process.exitCode = 1;
  }, 10_000);
  forceExit.unref();

  server.close((error) => {
    clearTimeout(forceExit);
    if (error) {
      console.error('[server] close error', error);
      process.exitCode = 1;
    } else {
      console.log('[server] stopped');
    }
  });
}

server.on('error', (error) => {
  console.error('[server] failed to start', error);
  process.exitCode = 1;
});

server.listen(config.port, config.host, () => {
  const address = server.address();
  const port = typeof address === 'object' && address ? address.port : config.port;
  const displayHost = config.host === '0.0.0.0' ? 'localhost' : config.host;
  const baseUrl = config.publicUrl || `http://${displayHost}:${port}`;
  const websocketUrl = baseUrl.replace(/^http/, 'ws') + config.websocket.path;

  console.log(`[server] Free Fire mock backend listening on ${config.host}:${port}`);
  console.log(`[server] HTTP      ${baseUrl}`);
  console.log(`[server] WebSocket ${websocketUrl}`);
  console.log(`[server] health    ${baseUrl}/healthz`);
  console.log(`[server] protocol  ${baseUrl}/api/protocol`);
});

process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));

process.on('unhandledRejection', (reason) => {
  console.error('[server] unhandled rejection', reason);
});

process.on('uncaughtException', (error) => {
  console.error('[server] uncaught exception', error);
  shutdown('uncaughtException');
});
