import { WebSocket, WebSocketServer } from 'ws';
import { AppError } from './errors.js';
import { getRecommendedRegions } from './game-data.js';
import { serializeProfile } from './lobby.js';
import {
  PROTOCOL_VERSION,
  SERVER_EVENT,
  protocolError,
  protocolResponse,
  resolveCommand,
} from './protocol.js';
import { getBaseUrl, toWebSocketUrl } from './urls.js';
import { bodyObject, optionalString, scalarString } from './validation.js';

function writeUpgradeError(socket, statusCode, reason) {
  const body = `${reason}\n`;
  socket.write(
    `HTTP/1.1 ${statusCode} ${reason}\r\nConnection: close\r\nContent-Type: text/plain\r\nContent-Length: ${Buffer.byteLength(body)}\r\n\r\n${body}`,
  );
  socket.destroy();
}

function originIsAllowed(origin, config) {
  if (!origin) return true;
  if (config.corsOrigins.includes('*')) return true;
  return config.corsOrigins.includes(origin);
}

function send(ws, payload) {
  if (ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify(payload));
  }
}

function parseEnvelope(message) {
  const rawCommand = message.cmdType ?? message.command ?? message.type;
  const command = resolveCommand(rawCommand);
  const requestId =
    typeof message.requestId === 'string' ? message.requestId.slice(0, 128) : null;
  const seq = Number.isInteger(message.seq) ? message.seq : 0;
  const subCmdType = Number.isInteger(message.subCmdType) ? message.subCmdType : 0;
  const regionID =
    typeof message.regionID === 'string' ? message.regionID.slice(0, 16) : null;
  const data = bodyObject(message.data ?? message.payload ?? {});
  return { command, rawCommand, requestId, seq, subCmdType, regionID, data };
}

function consumeMessageBudget(ws, config) {
  const now = Date.now();
  if (now - ws.messageBudget.startedAt >= config.websocket.messageWindowMs) {
    ws.messageBudget.startedAt = now;
    ws.messageBudget.count = 0;
  }
  ws.messageBudget.count += 1;
  return ws.messageBudget.count <= config.websocket.messageLimit;
}

function activeSocketAuth(ws, store) {
  if (!ws.auth) {
    throw new AppError(401, 'AUTH_REQUIRED', 'Log in over this WebSocket before using this command.');
  }
  const session = store.getSession(ws.auth.sessionId);
  if (!session || session.revokedAt) {
    ws.auth = null;
    throw new AppError(401, 'TOKEN_REVOKED', 'The session has been logged out.');
  }
  const user = store.getUserByUid(ws.auth.uid);
  if (!user) {
    ws.auth = null;
    throw new AppError(401, 'TOKEN_INVALID', 'The session user no longer exists.');
  }
  store.touchSession(session);
  return { user, session };
}

function authContext(ws, store) {
  return activeSocketAuth(ws, store);
}

function handshakeResponse(ws, ctx, { config, store, lobby }) {
  const data = ctx.data;
  const clientVersion =
    optionalString(data.clientVersion ?? data.client_version, 'clientVersion', {
      max: 32,
    }) ?? null;
  const platform = optionalString(data.platform, 'platform', { max: 24 }) ?? null;
  const deviceId = optionalString(data.deviceId ?? data.device_id, 'deviceId', {
    max: 128,
  });
  const region = lobby.getRegionOrThrow(
    optionalString(data.region ?? data.regionID, 'region', { max: 16 }) ??
      config.game.defaultRegion,
  );
  const handshake = store.createHandshake({
    region: region.id,
    clientVersion,
    platform,
    deviceId,
    ip: ws.context.remoteAddress,
  });
  ws.regionID = region.id;

  return {
    handshakeId: handshake.id,
    expiresAt: handshake.expiresAt,
    protocolVersion: PROTOCOL_VERSION,
    region: {
      region: region.id,
      region_id: region.zoneId,
      name: region.name,
      recommended_regions: getRecommendedRegions(region.id),
    },
    client: {
      version: clientVersion,
      expectedVersion: config.game.version,
      compatible: clientVersion === null || clientVersion === config.game.version,
      platform,
      deviceId,
    },
    endpoints: {
      websocket: toWebSocketUrl(ws.context.baseUrl, config.websocket.path),
      protocol: `${ws.context.baseUrl}/api/protocol`,
      server_list: `${ws.context.baseUrl}/live/serverList.json`,
    },
    serverTime: Date.now(),
  };
}

async function loginResponse(ws, ctx, { auth, store, lobby, config }) {
  const data = ctx.data;
  const accessToken =
    data.accessToken ?? data.access_token ?? data.token ?? ws.lastAccessToken ?? null;
  const uid =
    data.uid === undefined || data.uid === null
      ? undefined
      : scalarString(data.uid, 'uid', { max: 32 });

  let handshake = null;
  if (data.handshakeId !== undefined && data.handshakeId !== null && data.handshakeId !== '') {
    handshake = store.consumeHandshake(
      scalarString(data.handshakeId, 'handshakeId', { max: 128 }),
    );
  }

  const resolved = await auth.resolveLogin(
    { accessToken, uid, password: data.password },
    { ip: ws.context.remoteAddress, userAgent: ws.context.userAgent },
  );
  const region = lobby.getRegionOrThrow(
    handshake?.region && !data.region && !data.regionID
      ? handshake.region
      : optionalString(data.region ?? data.regionID, 'region', { max: 16 }) ??
          resolved.user.region,
  );

  resolved.user.region = region.id;
  resolved.user.lastLoginAt = new Date().toISOString();
  ws.auth = { uid: resolved.user.uid, sessionId: resolved.session.id };
  ws.regionID = region.id;
  ws.lastAccessToken = resolved.tokens?.accessToken ?? (accessToken || null);

  return {
    authenticated: true,
    login: lobby.buildLoginPayload(resolved.user, region.id, ws.context.baseUrl),
    profile: serializeProfile(resolved.user),
    session: {
      id: resolved.session.id,
      expires_at: new Date(resolved.session.refreshExpiresAtMs).toISOString(),
      ...(resolved.tokens
        ? {
            access_token: resolved.tokens.accessToken,
            refresh_token: resolved.tokens.refreshToken,
            token_type: resolved.tokens.tokenType,
            expires_in: resolved.tokens.expiresIn,
          }
        : {}),
    },
    handshake: handshake ? { id: handshake.id, used: true, region: handshake.region } : null,
  };
}

async function executeCommand(ws, ctx, services) {
  const { command, data } = ctx;
  const { config, store, auth, lobby } = services;

  switch (command.name) {
    case 'HANDSHAKE': {
      const payload = handshakeResponse(ws, ctx, services);
      send(ws, protocolResponse(command, { ...ctx, regionID: payload.region.region, data: payload }));
      return;
    }
    case 'LOGIN': {
      const payload = await loginResponse(ws, ctx, services);
      send(
        ws,
        protocolResponse(command, {
          ...ctx,
          regionID: payload.login.new_active_region,
          data: payload,
        }),
      );
      return;
    }
    case 'LOBBY_GET': {
      const { user, session } = authContext(ws, store);
      const snapshot = lobby.getSnapshot(user, session, {
        baseUrl: ws.context.baseUrl,
        req: null,
      });
      send(ws, protocolResponse(command, { ...ctx, regionID: user.region, data: snapshot }));
      return;
    }
    case 'ROOM_CREATE': {
      const { user } = authContext(ws, store);
      const room = lobby.createRoom(user, data);
      send(ws, protocolResponse(command, { ...ctx, regionID: room.region, data: { room } }));
      return;
    }
    case 'ROOM_JOIN': {
      const { user } = authContext(ws, store);
      const roomId = data.roomId ?? data.room_id;
      const room = lobby.joinRoom(user, roomId);
      send(ws, protocolResponse(command, { ...ctx, regionID: room.region, data: { room } }));
      return;
    }
    case 'ROOM_LEAVE': {
      const { user } = authContext(ws, store);
      const roomId = data.roomId ?? data.room_id;
      const result = lobby.leaveRoom(user, roomId);
      send(ws, protocolResponse(command, { ...ctx, regionID: user.region, data: result }));
      return;
    }
    case 'PING': {
      send(
        ws,
        protocolResponse(command, {
          ...ctx,
          data: {
            pong: true,
            clientTime: data.clientTime ?? data.client_time ?? null,
            serverTime: Date.now(),
          },
        }),
      );
      return;
    }
    case 'LOGOUT': {
      const { session } = authContext(ws, store);
      store.revokeSession(session.id);
      ws.auth = null;
      send(ws, protocolResponse(command, { ...ctx, data: { loggedOut: true } }));
      return;
    }
    default: {
      throw new AppError(400, 'UNSUPPORTED_COMMAND', 'Unsupported command.');
    }
  }
}

function handleSocketFailure(ws, ctx, error, logger = console) {
  if (!(error instanceof AppError)) {
    logger.error('[websocket] unhandled command error', error);
  }
  const command = ctx?.command ?? SERVER_EVENT;
  const message =
    error instanceof AppError ? error : new Error('An unexpected server error occurred.');
  send(
    ws,
    protocolError(
      command,
      {
        requestId: ctx?.requestId ?? null,
        seq: ctx?.seq ?? 0,
        subCmdType: ctx?.subCmdType ?? 0,
        regionID: ctx?.regionID ?? null,
      },
      message,
    ),
  );
}

export function attachWebSocket({ server, config, store, auth, lobby }) {
  const wss = new WebSocketServer({
    noServer: true,
    maxPayload: config.websocket.maxPayloadBytes,
    perMessageDeflate: false,
  });
  const services = { config, store, auth, lobby };

  server.on('upgrade', (req, socket, head) => {
    let pathname;
    try {
      pathname = new URL(req.url, 'http://localhost').pathname;
    } catch {
      writeUpgradeError(socket, 400, 'Bad Request');
      return;
    }

    if (pathname !== config.websocket.path) {
      writeUpgradeError(socket, 404, 'Not Found');
      return;
    }
    if (!originIsAllowed(req.headers.origin, config)) {
      writeUpgradeError(socket, 403, 'Forbidden');
      return;
    }

    wss.handleUpgrade(req, socket, head, (ws) => {
      wss.emit('connection', ws, req);
    });
  });

  wss.on('connection', (ws, req) => {
    ws.isAlive = true;
    ws.auth = null;
    ws.regionID = config.game.defaultRegion;
    ws.lastAccessToken = null;
    ws.messageChain = Promise.resolve();
    ws.messageBudget = {
      startedAt: Date.now(),
      count: 0,
    };
    ws.context = {
      baseUrl: getBaseUrl(req, config),
      remoteAddress: req.socket?.remoteAddress ?? null,
      userAgent: req.headers?.['user-agent'] ?? null,
    };

    ws.on('pong', () => {
      ws.isAlive = true;
    });

    ws.on('message', (raw) => {
      ws.messageChain = ws.messageChain
        .then(async () => {
          let text;
          if (Buffer.isBuffer(raw)) text = raw.toString('utf8');
          else if (Array.isArray(raw)) text = Buffer.concat(raw).toString('utf8');
          else if (raw instanceof ArrayBuffer) text = Buffer.from(raw).toString('utf8');
          else text = String(raw);

          let message;
          try {
            message = JSON.parse(text);
          } catch {
            throw new AppError(400, 'INVALID_JSON', 'WebSocket messages must be valid JSON.');
          }
          if (!message || typeof message !== 'object' || Array.isArray(message)) {
            throw new AppError(400, 'INVALID_MESSAGE', 'WebSocket messages must be JSON objects.');
          }

          const ctx = parseEnvelope(message);
          if (!ctx.command) {
            send(
              ws,
              protocolError(
                SERVER_EVENT,
                ctx,
                new AppError(
                  400,
                  'UNSUPPORTED_COMMAND',
                  'Unknown command. Read /api/protocol for the supported command list.',
                ),
              ),
            );
            return;
          }

          if (!consumeMessageBudget(ws, config)) {
            send(
              ws,
              protocolError(
                ctx.command,
                ctx,
                new AppError(429, 'WS_RATE_LIMITED', 'Too many WebSocket messages. Reconnect later.'),
              ),
            );
            ws.close(1008, 'Message rate limit exceeded');
            return;
          }

          try {
            await executeCommand(ws, ctx, services);
          } catch (error) {
            handleSocketFailure(ws, ctx, error);
          }
        })
        .catch((error) => {
          handleSocketFailure(ws, null, error);
        });
    });

    ws.on('error', (error) => {
      console.error('[websocket] socket error', error);
    });

    send(
      ws,
      protocolResponse(SERVER_EVENT, {
        regionID: ws.regionID,
        data: {
          event: 'connected',
          protocolVersion: PROTOCOL_VERSION,
          protocol: 'freefire-mock-json',
          requiresLoginForLobby: true,
          heartbeatMs: config.websocket.heartbeatMs,
          maxPayloadBytes: config.websocket.maxPayloadBytes,
          messageWindowMs: config.websocket.messageWindowMs,
          messageLimit: config.websocket.messageLimit,
          endpoints: {
            protocol: `${ws.context.baseUrl}/api/protocol`,
            handshake: `${ws.context.baseUrl}/api/handshake`,
            login: `${ws.context.baseUrl}/api/login`,
          },
        },
      }),
    );
  });

  const heartbeatTimer = setInterval(() => {
    for (const ws of wss.clients) {
      if (ws.isAlive === false) {
        ws.terminate();
        continue;
      }
      ws.isAlive = false;
      try {
        ws.ping();
      } catch {
        ws.terminate();
      }
    }
  }, config.websocket.heartbeatMs);
  heartbeatTimer.unref();

  wss.on('close', () => {
    clearInterval(heartbeatTimer);
  });

  return { wss, heartbeatTimer };
}
