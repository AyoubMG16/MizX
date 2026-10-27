import crypto from 'node:crypto';
import { AppError } from './errors.js';

export function requestContext(req, res, next) {
  const supplied = req.get('x-request-id');
  req.id =
    typeof supplied === 'string' && /^[A-Za-z0-9._:-]{1,120}$/.test(supplied)
      ? supplied
      : crypto.randomUUID();
  res.setHeader('x-request-id', req.id);
  next();
}

export function createRateLimiter({ windowMs, max, scope }) {
  const buckets = new Map();
  const cleanupTimer = setInterval(() => {
    const now = Date.now();
    for (const [key, bucket] of buckets) {
      if (bucket.resetAt <= now) buckets.delete(key);
    }
  }, Math.max(windowMs, 30_000));
  cleanupTimer.unref();

  return function rateLimiter(req, res, next) {
    const now = Date.now();
    const key = `${scope}:${req.ip ?? req.socket?.remoteAddress ?? 'unknown'}`;
    let bucket = buckets.get(key);
    if (!bucket || bucket.resetAt <= now) {
      bucket = { count: 0, resetAt: now + windowMs };
      buckets.set(key, bucket);
    }

    bucket.count += 1;
    const remaining = Math.max(0, max - bucket.count);
    res.setHeader('RateLimit-Limit', String(max));
    res.setHeader('RateLimit-Remaining', String(remaining));
    res.setHeader('RateLimit-Reset', String(Math.ceil(bucket.resetAt / 1000)));

    if (bucket.count > max) {
      const retryAfter = Math.max(1, Math.ceil((bucket.resetAt - now) / 1000));
      res.setHeader('Retry-After', String(retryAfter));
      next(
        new AppError(429, 'RATE_LIMITED', 'Too many requests. Retry after the indicated delay.', {
          retryAfterSeconds: retryAfter,
        }),
      );
      return;
    }
    next();
  };
}

export function extractAccessToken(req) {
  const header = req.get?.('authorization');
  if (typeof header === 'string') {
    const match = /^Bearer\s+(\S+)$/i.exec(header.trim());
    if (match) return match[1];
  }

  const body = req.body && typeof req.body === 'object' && !Array.isArray(req.body) ? req.body : {};
  if (typeof body.access_token === 'string') return body.access_token;
  if (typeof body.accessToken === 'string') return body.accessToken;
  if (typeof req.query?.access_token === 'string') return req.query.access_token;
  return null;
}

export function requireAuth(auth) {
  return function authenticate(req, _res, next) {
    const token = extractAccessToken(req);
    if (!token) {
      next(
        new AppError(
          401,
          'AUTH_REQUIRED',
          'Missing access token. Send Authorization: Bearer <access_token>.',
        ),
      );
      return;
    }

    try {
      req.auth = { token, ...auth.verifyAccessToken(token) };
      next();
    } catch (error) {
      next(error);
    }
  };
}

export function sendData(req, res, data, statusCode = 200) {
  return res.status(statusCode).json({
    ok: true,
    requestId: req.id ?? null,
    serverTime: Date.now(),
    data,
  });
}

export function sendOAuthError(
  res,
  { code = 'invalid_request', description = 'The request is invalid.', statusCode = 200 } = {},
) {
  return res.status(statusCode).json({
    error: code,
    error_description: description,
  });
}

export function mapErrorToOAuth(error) {
  if (!(error instanceof AppError)) {
    return { code: 'server_error', description: 'An unexpected server error occurred.', statusCode: 500 };
  }
  if (error.statusCode === 401) {
    return { code: 'invalid_grant', description: error.message, statusCode: 200 };
  }
  if (error.statusCode === 400 || error.statusCode === 409) {
    const oauthCodes = new Set([
      'invalid_request',
      'invalid_grant',
      'unsupported_response_type',
      'unsupported_grant_type',
    ]);
    return {
      code: oauthCodes.has(error.code) ? error.code : 'invalid_request',
      description: error.message,
      statusCode: 200,
    };
  }
  return {
    code: error.code.toLowerCase(),
    description: error.message,
    statusCode: error.statusCode >= 500 ? 500 : 200,
  };
}
