import { Router } from 'express';
import { AppError, asyncHandler } from '../errors.js';
import { serializeProfile } from '../lobby.js';
import {
  extractAccessToken,
  mapErrorToOAuth,
  sendOAuthError,
} from '../middleware.js';
import {
  bodyObject,
  optionalInteger,
  optionalString,
  requiredString,
  scalarString,
} from '../validation.js';

function requestInput(req) {
  return { ...req.query, ...bodyObject(req.body) };
}

function oauthHandler(handler) {
  return asyncHandler(async (req, res) => {
    try {
      await handler(req, res);
    } catch (error) {
      if (!(error instanceof AppError)) throw error;
      sendOAuthError(res, mapErrorToOAuth(error));
    }
  });
}

function tokenFromRequest(req) {
  const fromHeaderOrBody = extractAccessToken(req);
  if (fromHeaderOrBody) return fromHeaderOrBody;
  const body = bodyObject(req.body);
  if (typeof body.token === 'string') return body.token;
  if (typeof req.query.token === 'string') return req.query.token;
  return null;
}

export function createGarenaRouter({ config, auth }) {
  const router = Router();

  // GuestRegistrationHandler -> GuestAccountRegRequest
  router.post(
    '/guest/register',
    oauthHandler(async (req, res) => {
      const body = requestInput(req);
      const password = requiredString(body.password, 'password', {
        max: 128,
        trim: false,
      });
      const appId =
        body.app_id === undefined
          ? config.game.appId
          : scalarString(body.app_id, 'app_id', { max: 32 });
      const source = optionalInteger(body.source, 'source', {
        min: 0,
        max: 9999,
        fallback: config.game.sourceId,
      });
      const region = optionalString(body.region, 'region', { max: 16 });
      const nickname = optionalString(body.nickname, 'nickname', { max: 24 });

      const { user } = await auth.registerGuest({
        password,
        appId,
        source,
        region: region ?? config.game.defaultRegion,
        nickname,
      });

      res.json({ uid: Number(user.uid) });
    }),
  );

  // GuestRegistrationHandler -> GuestGrandTokenRequest
  router.post(
    '/guest/token/grant',
    oauthHandler(async (req, res) => {
      const body = requestInput(req);
      const uid = scalarString(body.uid, 'uid', { max: 32 });
      const password = requiredString(body.password, 'password', {
        max: 128,
        trim: false,
      });
      const responseType = optionalString(body.response_type, 'response_type', {
        max: 32,
      });
      if (responseType && responseType !== 'token') {
        throw new AppError(
          400,
          'unsupported_response_type',
          'Only response_type=token is supported.',
        );
      }
      optionalInteger(body.client_type, 'client_type', { min: 0, max: 32, fallback: null });
      optionalString(body.client_id, 'client_id', { max: 64 });

      const { user, tokens } = await auth.grantGuestToken(
        { uid, password },
        { ip: req.ip, userAgent: req.get('user-agent') ?? null },
      );

      res.json({
        open_id: user.openId,
        access_token: tokens.accessToken,
        refresh_token: tokens.refreshToken,
        expiry_time: tokens.expiryTime,
        token_type: tokens.tokenType,
        expires_in: tokens.expiresIn,
        uid: Number(user.uid),
      });
    }),
  );

  // Refresh-token grant. Rotates the refresh token on every successful use.
  router.post(
    '/token',
    oauthHandler(async (req, res) => {
      const body = requestInput(req);
      const grantType = optionalString(body.grant_type, 'grant_type', { max: 64 });
      if (grantType && grantType !== 'refresh_token') {
        throw new AppError(
          400,
          'unsupported_grant_type',
          'Only grant_type=refresh_token is supported.',
        );
      }
      const refreshToken = requiredString(body.refresh_token, 'refresh_token', {
        max: 4096,
        trim: false,
      });
      const { user, tokens } = auth.refreshSession(refreshToken);

      res.json({
        open_id: user.openId,
        access_token: tokens.accessToken,
        refresh_token: tokens.refreshToken,
        expiry_time: tokens.expiryTime,
        token_type: tokens.tokenType,
        expires_in: tokens.expiresIn,
        uid: Number(user.uid),
      });
    }),
  );

  const inspect = (req, res) => {
    const token = tokenFromRequest(req);
    if (!token) {
      sendOAuthError(res, {
        code: 'invalid_request',
        description: 'A token is required.',
      });
      return;
    }
    res.json(auth.inspectToken(token));
  };

  router.get('/token/inspect', inspect);
  router.post('/token/inspect', inspect);

  const userInfo = (req, res) => {
    const token = tokenFromRequest(req);
    if (!token) {
      sendOAuthError(res, {
        code: 'invalid_request',
        description: 'A token is required.',
      });
      return;
    }
    try {
      const { user } = auth.verifyAccessToken(token);
      const profile = serializeProfile(user);
      res.json({
        uid: Number(user.uid),
        open_id: user.openId,
        nickname: user.nickname,
        region: user.region,
        level: user.level,
        profile,
      });
    } catch (error) {
      if (!(error instanceof AppError)) throw error;
      sendOAuthError(res, mapErrorToOAuth(error));
    }
  };

  router.get('/user/info/get', userInfo);
  router.post('/user/info/get', userInfo);

  router.post(
    '/logout',
    oauthHandler(async (req, res) => {
      const token = tokenFromRequest(req);
      if (!token) {
        throw new AppError(400, 'invalid_request', 'A token is required.');
      }
      auth.revokeToken(token);
      res.json({ success: true });
    }),
  );

  return router;
}
