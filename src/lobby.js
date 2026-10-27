import { AppError } from './errors.js';
import {
  ANNOUNCEMENTS,
  GAME_MODES,
  GAME_MODE_BY_ID,
  MAPS,
  MAP_BY_ID,
  REGION_ID_MAPPING,
  getRankForPoints,
  getRecommendedRegions,
  getRegion,
  resolveRegion,
  serializeRegion,
} from './game-data.js';
import { serializeRoom } from './store.js';
import { getBaseUrl, getHostAndPort, toWebSocketUrl } from './urls.js';
import {
  bodyObject,
  oneOf,
  optionalInteger,
  optionalString,
  scalarString,
} from './validation.js';

const ROOM_NAME_MAX = 40;
const ROOM_CAPACITY_MIN = 2;
const ROOM_CAPACITY_MAX = 50;

function roomName(value, fallback) {
  const name = optionalString(value, 'name', { max: ROOM_NAME_MAX });
  if (!name) return fallback;
  return name.replace(/[\u0000-\u001f\u007f]/g, '').trim() || fallback;
}

export function resolveLoginRegion(regionId, fallback) {
  if (regionId === undefined || regionId === null || regionId === '') {
    return resolveRegion(fallback).id;
  }
  const region = getRegion(regionId);
  if (!region) {
    throw new AppError(
      400,
      'UNKNOWN_REGION',
      `Unknown region. Supported values: ${[...REGION_ID_MAPPING.keys()].join(', ')}.`,
    );
  }
  return region.id;
}

export function serializeProfile(user) {
  const rank = getRankForPoints(user.rankPoints);
  return {
    uid: user.uid,
    open_id: user.openId,
    nickname: user.nickname,
    account_type: 'guest',
    region: user.region,
    level: user.level,
    exp: user.exp,
    avatar: { ...user.avatar },
    currencies: {
      gold: user.gold,
      diamonds: user.diamonds,
    },
    rank: {
      tier: rank.name,
      points: user.rankPoints,
      peak_points: user.peakRankPoints,
      season: 'mock-s1',
    },
    stats: { ...user.stats },
    created_at: user.createdAt,
    last_login_at: user.lastLoginAt,
  };
}

export function serializeSession(session, tokens = null) {
  const payload = {
    id: session.id,
    expires_at: new Date(session.refreshExpiresAtMs).toISOString(),
    access_expires_at: tokens?.expiresAt ?? null,
  };
  if (tokens) {
    payload.access_token = tokens.accessToken;
    payload.refresh_token = tokens.refreshToken;
    payload.token_type = tokens.tokenType;
    payload.expires_in = tokens.expiresIn;
  }
  return payload;
}

export class LobbyService {
  constructor({ config, store }) {
    this.config = config;
    this.store = store;
  }

  getRegionOrThrow(regionId) {
    const region = getRegion(regionId);
    if (!region) {
      throw new AppError(400, 'UNKNOWN_REGION', `Unknown region: ${regionId}.`);
    }
    return region;
  }

  buildLoginPayload(user, regionId, baseUrl) {
    const region = this.getRegionOrThrow(regionId);
    const { host, port } = getHostAndPort(baseUrl, this.config.port);
    const websocketUrl = toWebSocketUrl(baseUrl, this.config.websocket.path);
    const rank = getRankForPoints(user.rankPoints);

    return {
      chat_server: '',
      notification_channel: 'mock-json',
      voice_server: '',
      event_log_url: `${baseUrl}/api/events`,
      ttl: this.config.auth.accessTtlSeconds,
      region_id_mapping: REGION_ID_MAPPING,
      new_active_region: region.id,
      recommend_regions: getRecommendedRegions(region.id),
      server_time: Math.floor(Date.now() / 1000),
      queue_position: 0,
      need_waiting_secs: 0,
      chat_addr: `${host}:${port}`,
      elite_pass_basic_info: {
        level: 1,
        exp: 0,
        badge_count: 0,
      },
      rank_info: {
        rank: rank.name,
        ranking_points: user.rankPoints,
        peak_ranking_points: user.peakRankPoints,
        season_id: 'mock-s1',
      },
      voice_type: 'none',
      agora_environment: 'mock',
      network_log_url: `${baseUrl}/api/events`,
      ping_addr_list: [{ addr: host, port, region: region.id }],
      ranking_peak_threshold: 1000,
      websocket_url: websocketUrl,
    };
  }

  listRooms(user, regionId = user.region) {
    return this.store
      .listRooms({ region: regionId, viewerUid: user.uid })
      .map((room) => serializeRoom(room));
  }

  getSnapshot(user, session, requestContext) {
    const baseUrl = requestContext.baseUrl ?? getBaseUrl(requestContext.req, this.config);
    const region = this.getRegionOrThrow(user.region);
    const currentRoom = this.store.findRoomForUser(user.uid);

    return {
      profile: serializeProfile(user),
      region: serializeRegion(region),
      session: serializeSession(session),
      presence: {
        online_players: this.store.countActiveUsers(),
        active_sessions: this.store.countActiveSessions(),
      },
      playlists: GAME_MODES.map((mode) => ({ ...mode })),
      maps: MAPS.map((map) => ({ ...map })),
      rooms: this.listRooms(user),
      current_room_id: currentRoom?.id ?? null,
      announcements: ANNOUNCEMENTS.map((announcement) => ({ ...announcement })),
      services: {
        websocket: {
          available: true,
          url: toWebSocketUrl(baseUrl, this.config.websocket.path),
          path: this.config.websocket.path,
        },
        chat: { available: false, reason: 'Not implemented in the mock backend.' },
        voice: { available: false, reason: 'Not implemented in the mock backend.' },
        battle: {
          available: false,
          reason: 'Encrypted protobuf over RUDP is outside this mock backend.',
        },
      },
      features: {
        handshake: true,
        guest_auth: true,
        lobby: true,
        rooms: true,
        matchmaking: false,
        battle: false,
      },
      server_time: Date.now(),
    };
  }

  createRoom(user, rawBody = {}) {
    const body = bodyObject(rawBody);
    if (this.store.findRoomForUser(user.uid)) {
      throw new AppError(
        409,
        'ALREADY_IN_ROOM',
        'Leave your current room before creating another one.',
      );
    }

    const modeId = oneOf(
      body.mode,
      'mode',
      GAME_MODES.map((mode) => mode.id),
      'br_squad',
    );
    const mode = GAME_MODE_BY_ID.get(modeId);
    const mapId = oneOf(
      body.map,
      'map',
      MAPS.map((map) => map.id),
      'bermuda',
    );
    const map = MAP_BY_ID.get(mapId);
    const capacityValue = body.max_players ?? body.maxPlayers;
    const maxPlayers = optionalInteger(capacityValue, 'max_players', {
      min: ROOM_CAPACITY_MIN,
      max: ROOM_CAPACITY_MAX,
      fallback: Math.min(4, mode.maxPlayers),
    });
    const visibility = oneOf(body.visibility, 'visibility', ['public', 'private'], 'public');
    const regionId =
      body.region === undefined || body.region === null || body.region === ''
        ? user.region
        : this.getRegionOrThrow(optionalString(body.region, 'region', { max: 16 })).id;
    const name = roomName(body.name, `${user.nickname}'s room`);

    const room = this.store.createRoom({
      host: user,
      region: regionId,
      name,
      mode: mode.id,
      map: map.id,
      maxPlayers,
      visibility,
    });
    return serializeRoom(room);
  }

  joinRoom(user, roomId) {
    const normalizedId = scalarString(roomId, 'roomId', { max: 80 });
    const room = this.store.getRoom(normalizedId);
    if (!room) throw new AppError(404, 'ROOM_NOT_FOUND', 'Room not found.');

    const currentRoom = this.store.findRoomForUser(user.uid);
    if (currentRoom && currentRoom.id !== room.id) {
      throw new AppError(
        409,
        'ALREADY_IN_ROOM',
        'Leave your current room before joining another one.',
      );
    }

    this.store.joinRoom(room, user);
    return serializeRoom(room);
  }

  leaveRoom(user, roomId) {
    const normalizedId = scalarString(roomId, 'roomId', { max: 80 });
    const room = this.store.getRoom(normalizedId);
    if (!room) throw new AppError(404, 'ROOM_NOT_FOUND', 'Room not found.');
    if (!room.members.some((member) => member.uid === user.uid)) {
      throw new AppError(403, 'NOT_IN_ROOM', 'You are not a member of this room.');
    }

    const result = this.store.leaveRoom(room, user.uid);
    return {
      left: true,
      deleted: result.deleted,
      room: result.room ? serializeRoom(result.room) : null,
    };
  }
}
