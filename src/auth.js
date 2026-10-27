import crypto from 'node:crypto';
import { promisify } from 'node:util';
import jwt from 'jsonwebtoken';
import { AppError } from './errors.js';
import { resolveRegion } from './game-data.js';

const scryptAsync = promisify(crypto.scrypt);
const SCRYPT_KEY_LENGTH = 64;

function passwordError(message = 'Password must be between 8 and 128 characters.') {
  return new AppError(400, 'VALIDATION_ERROR', message);
}

function validatePassword(password, { registration = false } = {}) {
  if (typeof password !== 'string') throw passwordError();
  if (registration && (password.length < 8 || password.length > 128)) throw passwordError();
  if (!registration && (password.length === 0 || password.length > 128)) throw passwordError();
  return password;
}

function sanitizeNickname(nickname, uid) {
  if (typeof nickname !== 'string') return `Guest${uid.slice(-4)}`;
  const cleaned = nickname
    .normalize('NFKC')
    .replace(/[\u0000-\u001f\u007f]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 24);
  return cleaned || `Guest${uid.slice(-4)}`;
}

function opaqueJti() {
  return `at_${crypto.randomBytes(12).toString('base64url')}`;
}

export class AuthService {
  constructor({ config, store }) {
    this.config = config;
    this.store = store;
  }

  async hashPassword(password) {
    const salt = crypto.randomBytes(16).toString('base64url');
    const derived = await scryptAsync(password, salt, SCRYPT_KEY_LENGTH);
    return `scrypt$${salt}$${derived.toString('base64url')}`;
  }

  async verifyPassword(password, storedHash) {
    if (typeof password !== 'string' || typeof storedHash !== 'string') return false;
    const [scheme, salt, encoded] = storedHash.split('$');
    if (scheme !== 'scrypt' || !salt || !encoded) return false;

    try {
      const expected = Buffer.from(encoded, 'base64url');
      const actual = await scryptAsync(password, salt, expected.length);
      return expected.length === actual.length && crypto.timingSafeEqual(expected, actual);
    } catch {
      return false;
    }
  }

  async registerGuest(
    { password, appId, source, nickname, region, deviceId },
    context = {},
  ) {
    const validPassword = validatePassword(password, { registration: true });
    const passwordHash = await this.hashPassword(validPassword);
    const uid = this.store.generateUid();
    const user = this.store.createUser({
      uid,
      openId: `ff${uid}`,
      nickname: sanitizeNickname(nickname, uid),
      passwordHash,
      region: resolveRegion(region ?? context.region, this.config.game.defaultRegion).id,
      appId,
      source,
      deviceId,
    });

    return { user };
  }

  async grantGuestToken({ uid, password }, context = {}) {
    const user = this.store.getUserByUid(uid);
    const validPassword = validatePassword(password);
    const passwordMatches = user
      ? await this.verifyPassword(validPassword, user.passwordHash)
      : false;

    if (!user || !passwordMatches) {
      throw new AppError(401, 'INVALID_GRANT', 'Invalid uid or password.');
    }

    const session = this.store.createSession({
      uid: user.uid,
      ip: context.ip,
      userAgent: context.userAgent,
    });
    const tokens = this.issueTokenPair(user, session);
    user.lastLoginAt = new Date().toISOString();
    return { user, session, tokens };
  }

  async resolveLogin({ accessToken, uid, password }, context = {}) {
    if (typeof accessToken === 'string' && accessToken.trim()) {
      const verified = this.verifyAccessToken(accessToken.trim());
      return { ...verified, tokens: null };
    }

    if (uid !== undefined && uid !== null && password !== undefined) {
      return this.grantGuestToken({ uid, password }, context);
    }

    throw new AppError(
      400,
      'AUTH_REQUIRED',
      'Provide an accessToken, or provide uid and password to authenticate.',
    );
  }

  issueTokenPair(user, session) {
    const common = {
      sub: user.uid,
      sid: session.id,
      open_id: user.openId,
    };
    const accessToken = jwt.sign(
      { ...common, type: 'access' },
      this.config.jwt.secret,
      {
        algorithm: this.config.jwt.algorithm,
        issuer: this.config.jwt.issuer,
        audience: this.config.jwt.audience,
        expiresIn: this.config.auth.accessTtlSeconds,
        jwtid: opaqueJti(),
      },
    );
    const refreshToken = jwt.sign(
      { ...common, type: 'refresh' },
      this.config.jwt.secret,
      {
        algorithm: this.config.jwt.algorithm,
        issuer: this.config.jwt.issuer,
        audience: this.config.jwt.audience,
        expiresIn: this.config.auth.refreshTtlSeconds,
        jwtid: session.refreshJti,
      },
    );

    const expiresAt = new Date(
      Date.now() + this.config.auth.accessTtlSeconds * 1000,
    ).toISOString();

    return {
      accessToken,
      refreshToken,
      tokenType: 'Bearer',
      expiresIn: this.config.auth.accessTtlSeconds,
      expiresAt,
      expiryTime: Math.floor(Date.parse(expiresAt) / 1000),
      sessionId: session.id,
      openId: user.openId,
      uid: user.uid,
    };
  }

  verifyToken(token, expectedType) {
    if (typeof token !== 'string' || token.length === 0 || token.length > 4096) {
      throw new AppError(401, 'TOKEN_INVALID', 'A valid access token is required.');
    }

    let payload;
    try {
      payload = jwt.verify(token, this.config.jwt.secret, {
        algorithms: [this.config.jwt.algorithm],
        issuer: this.config.jwt.issuer,
        audience: this.config.jwt.audience,
      });
    } catch (error) {
      if (error?.name === 'TokenExpiredError') {
        throw new AppError(401, 'TOKEN_EXPIRED', 'The access token has expired.');
      }
      throw new AppError(401, 'TOKEN_INVALID', 'The access token is invalid.');
    }

    if (typeof payload !== 'object' || payload.type !== expectedType) {
      throw new AppError(401, 'TOKEN_INVALID', 'The token type is invalid.');
    }
    if (typeof payload.sid !== 'string' || typeof payload.sub !== 'string') {
      throw new AppError(401, 'TOKEN_INVALID', 'The token is missing its session.');
    }

    const session = this.store.getSession(payload.sid);
    if (!session) {
      throw new AppError(401, 'TOKEN_REVOKED', 'The session is no longer valid.');
    }
    if (session.revokedAt) {
      throw new AppError(401, 'TOKEN_REVOKED', 'The session has been logged out.');
    }
    if (session.uid !== payload.sub) {
      throw new AppError(401, 'TOKEN_INVALID', 'The token does not match its session.');
    }

    const user = this.store.getUserByUid(payload.sub);
    if (!user) {
      throw new AppError(401, 'TOKEN_INVALID', 'The token user no longer exists.');
    }

    this.store.touchSession(session);
    return { payload, session, user };
  }

  verifyAccessToken(token) {
    return this.verifyToken(token, 'access');
  }

  verifyRefreshToken(token) {
    const verified = this.verifyToken(token, 'refresh');
    if (
      !verified.session.refreshJti ||
      !verified.payload.jti ||
      verified.payload.jti !== verified.session.refreshJti
    ) {
      throw new AppError(401, 'TOKEN_REVOKED', 'The refresh token has been rotated.');
    }
    return verified;
  }

  refreshSession(refreshToken) {
    const verified = this.verifyRefreshToken(refreshToken);
    this.store.rotateRefreshToken(verified.session);
    const tokens = this.issueTokenPair(verified.user, verified.session);
    return { ...verified, tokens };
  }

  inspectToken(token) {
    try {
      const verified = this.verifyAccessToken(token);
      return {
        active: true,
        token_type: 'access',
        uid: verified.user.uid,
        open_id: verified.user.openId,
        session_id: verified.session.id,
        expires_at: verified.payload.exp
          ? new Date(verified.payload.exp * 1000).toISOString()
          : null,
        scope: 'guest',
      };
    } catch (accessError) {
      try {
        const verified = this.verifyRefreshToken(token);
        return {
          active: true,
          token_type: 'refresh',
          uid: verified.user.uid,
          open_id: verified.user.openId,
          session_id: verified.session.id,
          expires_at: verified.payload.exp
            ? new Date(verified.payload.exp * 1000).toISOString()
            : null,
          scope: 'guest',
        };
      } catch {
        return {
          active: false,
          error: accessError.code ?? 'TOKEN_INVALID',
        };
      }
    }
  }

  revokeToken(token) {
    let verified;
    try {
      verified = this.verifyAccessToken(token);
    } catch (accessError) {
      try {
        verified = this.verifyRefreshToken(token);
      } catch {
        throw accessError;
      }
    }

    this.store.revokeSession(verified.session.id);
    return { revoked: true, uid: verified.user.uid, sessionId: verified.session.id };
  }
}
