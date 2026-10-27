import 'dotenv/config';
import { REGION_BY_ID } from './game-data.js';

const DEVELOPMENT_SECRET =
  'dev-only-freefire-mock-secret-change-me-before-production-1234567890';

function parseInteger(value, name, { min, max, fallback } = {}) {
  if (value === undefined || value === null || String(value).trim() === '') {
    return fallback;
  }

  const parsed = Number(String(value).trim());
  if (!Number.isInteger(parsed) || parsed < min || parsed > max) {
    throw new Error(`${name} must be an integer between ${min} and ${max}.`);
  }
  return parsed;
}

function parseTrustProxy(value, fallback) {
  if (value === undefined || value === null || String(value).trim() === '') {
    return fallback;
  }

  const normalized = String(value).trim().toLowerCase();
  if (normalized === 'true') return 1;
  if (normalized === 'false') return false;
  if (/^\d+$/.test(normalized)) return Number(normalized);
  throw new Error('TRUST_PROXY must be true, false, or a hop count.');
}

function normalizePublicUrl(value) {
  const publicUrl = (value ?? '').trim().replace(/\/+$/, '');
  if (!publicUrl) return '';

  let parsed;
  try {
    parsed = new URL(publicUrl);
  } catch {
    throw new Error('PUBLIC_URL must be an absolute http:// or https:// URL.');
  }

  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new Error('PUBLIC_URL must use http:// or https://.');
  }
  if (parsed.search || parsed.hash) {
    throw new Error('PUBLIC_URL must not contain a query string or fragment.');
  }
  if (parsed.pathname !== '/' && parsed.pathname !== '') {
    throw new Error('PUBLIC_URL must be an origin without a path.');
  }
  return publicUrl;
}

function parseOrigins(value) {
  const raw = (value ?? '*').trim();
  if (!raw) return ['*'];
  return [...new Set(raw.split(',').map((origin) => origin.trim()).filter(Boolean))];
}

/**
 * Load and validate runtime configuration.
 * Exported separately so tests can provide an explicit environment object.
 */
export function loadConfig(env = process.env) {
  const nodeEnv = (env.NODE_ENV ?? 'development').trim();
  const isProduction = nodeEnv === 'production';

  let jwtSecret = (env.JWT_SECRET ?? '').trim();
  if (!jwtSecret) {
    if (isProduction) {
      throw new Error(
        'JWT_SECRET is required when NODE_ENV=production. Generate one with: openssl rand -hex 48',
      );
    }
    jwtSecret = DEVELOPMENT_SECRET;
  }
  if (jwtSecret.length < 32) {
    throw new Error('JWT_SECRET must be at least 32 characters long.');
  }

  const port = parseInteger(env.PORT, 'PORT', { min: 0, max: 65535, fallback: 3000 });
  const defaultRegion = ((env.DEFAULT_REGION ?? 'sg').trim() || 'sg').toLowerCase();
  if (!REGION_BY_ID.has(defaultRegion)) {
    throw new Error(
      `DEFAULT_REGION must be one of: ${[...REGION_BY_ID.keys()].join(', ')}.`,
    );
  }
  const appId = (env.GARENA_APP_ID ?? '100067').trim() || '100067';

  return Object.freeze({
    env: nodeEnv,
    isProduction,
    port,
    host: (env.HOST ?? '0.0.0.0').trim() || '0.0.0.0',
    publicUrl: normalizePublicUrl(env.PUBLIC_URL),
    corsOrigins: parseOrigins(env.CORS_ORIGIN),
    trustProxy: parseTrustProxy(env.TRUST_PROXY, isProduction ? 1 : false),
    jwt: Object.freeze({
      secret: jwtSecret,
      issuer: 'freefire-mock-backend',
      audience: 'freefire-mock-client',
      algorithm: 'HS256',
    }),
    auth: Object.freeze({
      accessTtlSeconds: parseInteger(env.ACCESS_TOKEN_TTL_SECONDS, 'ACCESS_TOKEN_TTL_SECONDS', {
        min: 60,
        max: 604800,
        fallback: 3600,
      }),
      refreshTtlSeconds: parseInteger(env.REFRESH_TOKEN_TTL_SECONDS, 'REFRESH_TOKEN_TTL_SECONDS', {
        min: 300,
        max: 31536000,
        fallback: 2592000,
      }),
      handshakeTtlSeconds: parseInteger(env.HANDSHAKE_TTL_SECONDS, 'HANDSHAKE_TTL_SECONDS', {
        min: 30,
        max: 86400,
        fallback: 600,
      }),
    }),
    rateLimit: Object.freeze({
      windowMs: parseInteger(env.RATE_LIMIT_WINDOW_MS, 'RATE_LIMIT_WINDOW_MS', {
        min: 1000,
        max: 3600000,
        fallback: 60000,
      }),
      max: parseInteger(env.RATE_LIMIT_MAX, 'RATE_LIMIT_MAX', {
        min: 1,
        max: 1_000_000,
        fallback: 300,
      }),
      authWindowMs: parseInteger(env.AUTH_RATE_LIMIT_WINDOW_MS, 'AUTH_RATE_LIMIT_WINDOW_MS', {
        min: 1000,
        max: 86_400_000,
        fallback: 600000,
      }),
      authMax: parseInteger(env.AUTH_RATE_LIMIT_MAX, 'AUTH_RATE_LIMIT_MAX', {
        min: 1,
        max: 1_000_000,
        fallback: 60,
      }),
    }),
    game: Object.freeze({
      version: (env.GAME_VERSION ?? '1.38.2').trim() || '1.38.2',
      versionCode: parseInteger(env.GAME_VERSION_CODE, 'GAME_VERSION_CODE', {
        min: 1,
        max: Number.MAX_SAFE_INTEGER,
        fallback: 2019071114,
      }),
      appId,
      sourceId: parseInteger(env.GARENA_SOURCE_ID, 'GARENA_SOURCE_ID', {
        min: 0,
        max: 9999,
        fallback: 2,
      }),
      defaultRegion,
      maxRooms: parseInteger(env.MAX_ROOMS, 'MAX_ROOMS', {
        min: 1,
        max: 10000,
        fallback: 100,
      }),
    }),
    websocket: Object.freeze({
      path: '/ws',
      maxPayloadBytes: parseInteger(env.WS_MAX_PAYLOAD_BYTES, 'WS_MAX_PAYLOAD_BYTES', {
        min: 1024,
        max: 1048576,
        fallback: 65536,
      }),
      heartbeatMs: parseInteger(env.WS_HEARTBEAT_MS, 'WS_HEARTBEAT_MS', {
        min: 5000,
        max: 120000,
        fallback: 30000,
      }),
      messageWindowMs: parseInteger(env.WS_MESSAGE_WINDOW_MS, 'WS_MESSAGE_WINDOW_MS', {
        min: 1000,
        max: 60000,
        fallback: 10000,
      }),
      messageLimit: parseInteger(env.WS_MESSAGE_LIMIT, 'WS_MESSAGE_LIMIT', {
        min: 1,
        max: 1000,
        fallback: 40,
      }),
    }),
  });
}
