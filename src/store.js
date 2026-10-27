import crypto from 'node:crypto';
import { AppError } from './errors.js';

const ROOM_CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';

function opaqueId(prefix, bytes = 18) {
  return `${prefix}_${crypto.randomBytes(bytes).toString('base64url')}`;
}

function roomCode() {
  let result = '';
  for (let index = 0; index < 6; index += 1) {
    result += ROOM_CODE_ALPHABET[crypto.randomInt(0, ROOM_CODE_ALPHABET.length)];
  }
  return result;
}

function roomMember(user) {
  const now = new Date().toISOString();
  return {
    uid: user.uid,
    nickname: user.nickname,
    level: user.level,
    ready: false,
    joinedAt: now,
  };
}

export class MemoryStore {
  constructor(config) {
    this.config = config;
    this.users = new Map();
    this.usersByOpenId = new Map();
    this.handshakes = new Map();
    this.sessions = new Map();
    this.rooms = new Map();
    this.startedAt = Date.now();
  }

  sweep(now = Date.now()) {
    for (const [id, handshake] of this.handshakes) {
      if (handshake.expiresAtMs <= now) this.handshakes.delete(id);
    }
    for (const [id, session] of this.sessions) {
      if (session.refreshExpiresAtMs <= now) this.sessions.delete(id);
    }
  }

  createHandshake(context = {}) {
    this.sweep();
    const now = Date.now();
    const handshake = {
      id: opaqueId('hs'),
      createdAt: new Date(now).toISOString(),
      expiresAt: new Date(now + this.config.auth.handshakeTtlSeconds * 1000).toISOString(),
      expiresAtMs: now + this.config.auth.handshakeTtlSeconds * 1000,
      region: context.region,
      clientVersion: context.clientVersion ?? null,
      platform: context.platform ?? null,
      deviceId: context.deviceId ?? null,
      ip: context.ip ?? null,
    };
    this.handshakes.set(handshake.id, handshake);
    return handshake;
  }

  consumeHandshake(id) {
    const handshake = this.handshakes.get(id);
    if (!handshake) {
      throw new AppError(
        401,
        'HANDSHAKE_INVALID',
        'Handshake not found, expired, or already used. Request a new handshake.',
      );
    }
    this.handshakes.delete(id);
    if (handshake.expiresAtMs <= Date.now()) {
      throw new AppError(401, 'HANDSHAKE_EXPIRED', 'Handshake has expired. Request a new one.');
    }
    return handshake;
  }

  generateUid() {
    for (let attempt = 0; attempt < 20; attempt += 1) {
      const uid = String(crypto.randomInt(100_000_000, 1_000_000_000));
      if (!this.users.has(uid)) return uid;
    }
    throw new AppError(503, 'UID_EXHAUSTED', 'Unable to allocate a new user id.');
  }

  createUser({ uid, openId, nickname, passwordHash, region, appId, source, deviceId }) {
    if (this.users.has(uid)) {
      throw new AppError(409, 'USER_EXISTS', 'A user with that uid already exists.');
    }
    if (this.usersByOpenId.has(openId)) {
      throw new AppError(409, 'OPEN_ID_EXISTS', 'A user with that open id already exists.');
    }

    const now = new Date().toISOString();
    const user = {
      uid,
      openId,
      nickname,
      passwordHash,
      region,
      appId: appId ?? this.config.game.appId,
      source: source ?? this.config.game.sourceId,
      deviceId: deviceId ?? null,
      level: 1,
      exp: 0,
      rankPoints: 0,
      peakRankPoints: 0,
      gold: 1000,
      diamonds: 100,
      avatar: {
        character: 'default',
        outfit: 'default',
        headPic: 'default',
      },
      stats: {
        matches: 0,
        wins: 0,
        kills: 0,
      },
      createdAt: now,
      lastLoginAt: null,
    };

    this.users.set(uid, user);
    this.usersByOpenId.set(openId, uid);
    return user;
  }

  getUserByUid(uid) {
    return this.users.get(String(uid)) ?? null;
  }

  getUserByOpenId(openId) {
    const uid = this.usersByOpenId.get(openId);
    return uid ? this.getUserByUid(uid) : null;
  }

  createSession({ uid, ip, userAgent }) {
    const now = Date.now();
    const session = {
      id: opaqueId('ses'),
      uid,
      createdAt: new Date(now).toISOString(),
      lastSeenAtMs: now,
      refreshExpiresAtMs: now + this.config.auth.refreshTtlSeconds * 1000,
      revokedAt: null,
      refreshJti: opaqueId('rtj', 12),
      ip: ip ?? null,
      userAgent: userAgent ?? null,
    };
    this.sessions.set(session.id, session);
    return session;
  }

  getSession(id) {
    const session = this.sessions.get(id);
    if (!session) return null;
    if (session.refreshExpiresAtMs <= Date.now()) {
      this.sessions.delete(id);
      return null;
    }
    return session;
  }

  touchSession(session) {
    session.lastSeenAtMs = Date.now();
  }

  rotateRefreshToken(session) {
    const now = Date.now();
    session.refreshJti = opaqueId('rtj', 12);
    session.refreshExpiresAtMs = now + this.config.auth.refreshTtlSeconds * 1000;
    session.lastSeenAtMs = now;
    return session;
  }

  revokeSession(id) {
    const session = this.sessions.get(id);
    if (!session) return false;
    session.revokedAt = new Date().toISOString();
    session.refreshJti = null;
    return true;
  }

  countActiveSessions() {
    const now = Date.now();
    let count = 0;
    for (const session of this.sessions.values()) {
      if (!session.revokedAt && session.refreshExpiresAtMs > now) count += 1;
    }
    return count;
  }

  countActiveUsers() {
    const now = Date.now();
    const users = new Set();
    for (const session of this.sessions.values()) {
      if (!session.revokedAt && session.refreshExpiresAtMs > now) {
        users.add(session.uid);
      }
    }
    return users.size;
  }

  createRoom({ host, region, name, mode, map, maxPlayers, visibility }) {
    if (this.rooms.size >= this.config.game.maxRooms) {
      throw new AppError(409, 'ROOM_LIMIT_REACHED', 'The lobby has reached its room limit.');
    }

    let code = roomCode();
    for (let attempt = 0; attempt < 20; attempt += 1) {
      if (![...this.rooms.values()].some((room) => room.code === code)) break;
      code = roomCode();
    }

    const now = new Date().toISOString();
    const room = {
      id: opaqueId('rm', 12),
      code,
      name,
      region,
      mode,
      map,
      maxPlayers,
      visibility,
      hostUid: host.uid,
      members: [roomMember(host)],
      status: 'waiting',
      createdAt: now,
      updatedAt: now,
    };
    this.rooms.set(room.id, room);
    return room;
  }

  getRoom(roomId) {
    return this.rooms.get(roomId) ?? null;
  }

  findRoomForUser(uid) {
    for (const room of this.rooms.values()) {
      if (room.members.some((member) => member.uid === uid)) return room;
    }
    return null;
  }

  listRooms({ region, viewerUid } = {}) {
    return [...this.rooms.values()]
      .filter((room) => (region ? room.region === region : true))
      .filter(
        (room) =>
          room.visibility === 'public' ||
          room.members.some((member) => member.uid === viewerUid),
      )
      .sort((left, right) => right.createdAt.localeCompare(left.createdAt));
  }

  joinRoom(room, user) {
    if (room.members.some((member) => member.uid === user.uid)) return room;
    if (room.members.length >= room.maxPlayers) {
      throw new AppError(409, 'ROOM_FULL', 'The room is full.');
    }
    room.members.push(roomMember(user));
    room.updatedAt = new Date().toISOString();
    return room;
  }

  leaveRoom(room, uid) {
    const before = room.members.length;
    room.members = room.members.filter((member) => member.uid !== uid);
    if (room.members.length === before) return { room, deleted: false };

    room.updatedAt = new Date().toISOString();
    if (room.members.length === 0) {
      this.rooms.delete(room.id);
      return { room: null, deleted: true };
    }
    if (room.hostUid === uid) {
      room.hostUid = room.members[0].uid;
    }
    return { room, deleted: false };
  }

  stats() {
    return {
      users: this.users.size,
      sessions: this.countActiveSessions(),
      onlineUsers: this.countActiveUsers(),
      rooms: this.rooms.size,
      handshakes: this.handshakes.size,
      uptimeSeconds: Math.floor((Date.now() - this.startedAt) / 1000),
    };
  }
}

export function serializeRoom(room) {
  if (!room) return null;
  const host = room.members.find((member) => member.uid === room.hostUid) ?? null;
  return {
    id: room.id,
    code: room.code,
    name: room.name,
    region: room.region,
    mode: room.mode,
    map: room.map,
    visibility: room.visibility,
    max_players: room.maxPlayers,
    member_count: room.members.length,
    is_full: room.members.length >= room.maxPlayers,
    status: room.status,
    host_uid: room.hostUid,
    host_nickname: host?.nickname ?? null,
    members: room.members.map((member) => ({
      uid: member.uid,
      nickname: member.nickname,
      level: member.level,
      ready: member.ready,
      is_host: member.uid === room.hostUid,
      joined_at: member.joinedAt,
    })),
    created_at: room.createdAt,
    updated_at: room.updatedAt,
  };
}
