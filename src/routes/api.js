import { Router } from 'express';
import crypto from 'node:crypto';
import { asyncHandler } from '../errors.js';
import { getRecommendedRegions, serializeRegion } from '../game-data.js';
import { serializeProfile } from '../lobby.js';
import {
  extractAccessToken,
  requireAuth,
  sendData,
} from '../middleware.js';
import { PROTOCOL_VERSION, publicProtocolDescription } from '../protocol.js';
import { getBaseUrl, toWebSocketUrl } from '../urls.js';
import {
  bodyObject,
  optionalString,
  scalarString,
} from '../validation.js';

export function createApiRouter({ config, store, auth, lobby }) {
  const router = Router();
  const authenticate = requireAuth(auth);

  router.get('/protocol', (req, res) => {
    sendData(req, res, publicProtocolDescription());
  });

  router.post(
    '/handshake',
    asyncHandler(async (req, res) => {
      const body = bodyObject(req.body);
      const clientVersion =
        optionalString(body.clientVersion ?? body.client_version, 'clientVersion', {
          max: 32,
        }) ?? null;
      const platform = optionalString(body.platform, 'platform', { max: 24 }) ?? null;
      const deviceId = optionalString(body.deviceId ?? body.device_id, 'deviceId', {
        max: 128,
      });
      const region = lobby.getRegionOrThrow(
        optionalString(body.region ?? body.regionID, 'region', { max: 16 }) ??
          config.game.defaultRegion,
      );

      const handshake = store.createHandshake({
        region: region.id,
        clientVersion,
        platform,
        deviceId,
        ip: req.ip,
      });
      const baseUrl = getBaseUrl(req, config);

      sendData(req, res, {
        handshakeId: handshake.id,
        expiresAt: handshake.expiresAt,
        protocolVersion: PROTOCOL_VERSION,
        region: {
          ...serializeRegion(region),
          recommended_regions: getRecommendedRegions(region.id),
        },
        client: {
          version: clientVersion,
          expectedVersion: config.game.version,
          compatible: clientVersion === null || clientVersion === config.game.version,
          platform,
          deviceId,
        },
        capabilities: {
          handshake: true,
          guest_auth: true,
          lobby: true,
          rooms: true,
          matchmaking: false,
          battle: false,
        },
        endpoints: {
          websocket: toWebSocketUrl(baseUrl, config.websocket.path),
          version: `${baseUrl}/live/ver.php`,
          server_list: `${baseUrl}/live/serverList.json`,
          protocol: `${baseUrl}/api/protocol`,
        },
        serverTime: Date.now(),
      });
    }),
  );

  router.post(
    '/login',
    asyncHandler(async (req, res) => {
      const body = bodyObject(req.body);
      let handshake = null;
      if (body.handshakeId !== undefined && body.handshakeId !== null && body.handshakeId !== '') {
        handshake = store.consumeHandshake(
          scalarString(body.handshakeId, 'handshakeId', { max: 128 }),
        );
      }

      const accessToken = extractAccessToken(req);
      const uid =
        body.uid === undefined || body.uid === null
          ? undefined
          : scalarString(body.uid, 'uid', { max: 32 });
      const resolved = await auth.resolveLogin(
        {
          accessToken,
          uid,
          password: body.password,
        },
        {
          ip: req.ip,
          userAgent: req.get('user-agent') ?? null,
        },
      );

      const region = lobby.getRegionOrThrow(
        handshake?.region && !body.region && !body.regionID
          ? handshake.region
          : optionalString(body.region ?? body.regionID, 'region', { max: 16 }) ??
              resolved.user.region,
      );
      resolved.user.region = region.id;
      resolved.user.lastLoginAt = new Date().toISOString();

      const baseUrl = getBaseUrl(req, config);
      sendData(req, res, {
        login: lobby.buildLoginPayload(resolved.user, region.id, baseUrl),
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
        handshake: handshake
          ? { id: handshake.id, used: true, region: handshake.region }
          : null,
      });
    }),
  );

  router.post(
    '/logout',
    authenticate,
    asyncHandler(async (req, res) => {
      const result = auth.revokeToken(req.auth.token);
      sendData(req, res, result);
    }),
  );

  router.get('/profile', authenticate, (req, res) => {
    sendData(req, res, {
      profile: serializeProfile(req.auth.user),
      session: {
        id: req.auth.session.id,
        expires_at: new Date(req.auth.session.refreshExpiresAtMs).toISOString(),
        access_expires_at: req.auth.payload.exp
          ? new Date(req.auth.payload.exp * 1000).toISOString()
          : null,
      },
    });
  });

  router.get('/session', authenticate, (req, res) => {
    sendData(req, res, {
      id: req.auth.session.id,
      uid: req.auth.user.uid,
      open_id: req.auth.user.openId,
      issued_at: req.auth.session.createdAt,
      last_seen_at: new Date(req.auth.session.lastSeenAtMs).toISOString(),
      expires_at: new Date(req.auth.session.refreshExpiresAtMs).toISOString(),
      access_expires_at: req.auth.payload.exp
        ? new Date(req.auth.payload.exp * 1000).toISOString()
        : null,
      revoked: Boolean(req.auth.session.revokedAt),
    });
  });

  router.get('/lobby', authenticate, (req, res) => {
    const snapshot = lobby.getSnapshot(req.auth.user, req.auth.session, {
      baseUrl: getBaseUrl(req, config),
      req,
    });
    sendData(req, res, snapshot);
  });

  router.get('/lobby/rooms', authenticate, (req, res) => {
    const requestedRegion = optionalString(
      typeof req.query.region === 'string' ? req.query.region : null,
      'region',
      { max: 16 },
    );
    const region = requestedRegion
      ? lobby.getRegionOrThrow(requestedRegion)
      : lobby.getRegionOrThrow(req.auth.user.region);
    sendData(req, res, {
      region: region.id,
      rooms: lobby.listRooms(req.auth.user, region.id),
    });
  });

  router.post('/lobby/rooms', authenticate, (req, res) => {
    const room = lobby.createRoom(req.auth.user, bodyObject(req.body));
    sendData(req, res, { room }, 201);
  });

  router.post('/lobby/rooms/:roomId/join', authenticate, (req, res) => {
    const room = lobby.joinRoom(req.auth.user, req.params.roomId);
    sendData(req, res, { room });
  });

  router.post('/lobby/rooms/:roomId/leave', authenticate, (req, res) => {
    const result = lobby.leaveRoom(req.auth.user, req.params.roomId);
    sendData(req, res, result);
  });

  router.post('/events', (req, res) => {
    const body = bodyObject(req.body);
    const eventType = optionalString(body.event_type ?? body.eventType ?? body.type, 'event_type', {
      max: 64,
    });
    res.status(202).json({
      ok: true,
      requestId: req.id,
      serverTime: Date.now(),
      data: {
        accepted: true,
        event_id: crypto.randomUUID(),
        event_type: eventType ?? 'unknown',
        stored: false,
      },
    });
  });

  return router;
}
