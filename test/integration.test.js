import assert from 'node:assert/strict';
import http from 'node:http';
import { after, before, test } from 'node:test';
import WebSocket from 'ws';
import { createApp } from '../src/app.js';
import { AuthService } from '../src/auth.js';
import { loadConfig } from '../src/config.js';
import { LobbyService } from '../src/lobby.js';
import { attachWebSocket } from '../src/realtime.js';
import { MemoryStore } from '../src/store.js';

const config = loadConfig({
  NODE_ENV: 'test',
  PORT: '0',
  HOST: '127.0.0.1',
  PUBLIC_URL: '',
  JWT_SECRET: 'integration-test-secret-'.repeat(4),
  CORS_ORIGIN: '*',
  TRUST_PROXY: '0',
  ACCESS_TOKEN_TTL_SECONDS: '600',
  REFRESH_TOKEN_TTL_SECONDS: '3600',
  HANDSHAKE_TTL_SECONDS: '300',
  GAME_VERSION: '1.38.2',
  GAME_VERSION_CODE: '2019071114',
  GARENA_APP_ID: '100067',
  GARENA_SOURCE_ID: '2',
  DEFAULT_REGION: 'sg',
  MAX_ROOMS: '20',
  WS_HEARTBEAT_MS: '30000',
});
const store = new MemoryStore(config);
const auth = new AuthService({ config, store });
const lobby = new LobbyService({ config, store });
const app = createApp({ config, store, auth, lobby });
const server = http.createServer(app);
const { wss } = attachWebSocket({ server, config, store, auth, lobby });

let baseUrl;
let accessToken;
let refreshToken;
let user;
let roomId;

before(async () => {
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  baseUrl = `http://127.0.0.1:${address.port}`;
});

after(async () => {
  for (const client of wss.clients) client.terminate();
  await new Promise((resolve) => wss.close(resolve));
  await new Promise((resolve) => {
    server.close(resolve);
    server.closeAllConnections?.();
  });
});

async function jsonFetch(path, options = {}) {
  const response = await fetch(`${baseUrl}${path}`, options);
  const body = await response.json();
  return { response, body };
}

function formBody(fields) {
  return new URLSearchParams(fields);
}

function connectWebSocket() {
  const ws = new WebSocket(`${baseUrl.replace(/^http/, 'ws')}/ws`);
  const queue = [];
  const waiters = [];

  ws.on('message', (raw) => {
    const message = JSON.parse(raw.toString());
    const waiterIndex = waiters.findIndex((waiter) => waiter.predicate(message));
    if (waiterIndex >= 0) {
      const [waiter] = waiters.splice(waiterIndex, 1);
      clearTimeout(waiter.timer);
      waiter.resolve(message);
    } else {
      queue.push(message);
    }
  });

  function next(predicate, timeoutMs = 5000) {
    const existingIndex = queue.findIndex(predicate);
    if (existingIndex >= 0) {
      return Promise.resolve(queue.splice(existingIndex, 1)[0]);
    }
    return new Promise((resolve, reject) => {
      const waiter = { predicate, resolve, reject, timer: null };
      waiter.timer = setTimeout(() => {
        const index = waiters.indexOf(waiter);
        if (index >= 0) waiters.splice(index, 1);
        reject(new Error('Timed out waiting for WebSocket message.'));
      }, timeoutMs);
      waiters.push(waiter);
    });
  }

  function request(message) {
    const responsePromise = next(
      (candidate) => candidate.requestId === message.requestId,
    );
    ws.send(JSON.stringify(message));
    return responsePromise;
  }

  return new Promise((resolve, reject) => {
    ws.once('open', () => resolve({ ws, next, request }));
    ws.once('error', reject);
  });
}

async function registerAndGrant(password, nickname) {
  const registered = await jsonFetch('/oauth/guest/register', {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: formBody({
      password,
      app_id: '100067',
      source: '2',
      ...(nickname ? { nickname } : {}),
    }),
  });
  assert.equal(registered.response.status, 200);
  assert.ok(registered.body.uid);

  const granted = await jsonFetch('/oauth/guest/token/grant', {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: formBody({
      uid: String(registered.body.uid),
      password,
      response_type: 'token',
      client_type: '2',
      client_id: '100067',
    }),
  });
  assert.equal(granted.response.status, 200);
  assert.ok(granted.body.access_token);
  return { uid: registered.body.uid, grant: granted.body };
}

test('public discovery endpoints work', async () => {
  const health = await jsonFetch('/healthz');
  assert.equal(health.response.status, 200);
  assert.equal(health.body.status, 'ok');

  const version = await jsonFetch('/live/ver.php');
  assert.equal(version.response.status, 200);
  assert.equal(version.body.appstore.latest_version, '1.38.2');
  assert.ok('gameassetbundles' in version.body);

  const servers = await jsonFetch('/live/serverList.json');
  assert.equal(servers.response.status, 200);
  assert.ok(servers.body.serverList.length > 0);
  assert.equal(servers.body.default_region, 'sg');
  assert.equal(servers.body.base_url, baseUrl);
  assert.equal(servers.body.websocket_url, `${baseUrl.replace(/^http/, 'ws')}/ws`);
  for (const server of servers.body.serverList) {
    assert.equal(server.websocket_url, servers.body.websocket_url);
  }

  const protocol = await jsonFetch('/api/protocol');
  assert.equal(protocol.response.status, 200);
  assert.ok(protocol.body.data.commands.some((command) => command.name === 'LOGIN'));
});

test('guest registration, token grant, handshake, login, and refresh work', async () => {
  const password = 'analysis-test-password-'.repeat(2);
  const created = await registerAndGrant(password, 'IntegrationGuest');
  user = created.uid;
  accessToken = created.grant.access_token;
  refreshToken = created.grant.refresh_token;
  assert.equal(created.grant.open_id, `ff${user}`);
  assert.ok(created.grant.expiry_time > Math.floor(Date.now() / 1000));

  const handshake = await jsonFetch('/api/handshake', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      clientVersion: '1.38.2',
      platform: 'android',
      deviceId: 'integration-device',
    }),
  });
  assert.equal(handshake.response.status, 200);
  assert.ok(handshake.body.data.handshakeId);

  const login = await jsonFetch('/api/login', {
    method: 'POST',
    headers: {
      authorization: `Bearer ${accessToken}`,
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      handshakeId: handshake.body.data.handshakeId,
      region: 'id',
    }),
  });
  assert.equal(login.response.status, 200);
  assert.equal(login.body.data.profile.nickname, 'IntegrationGuest');
  assert.equal(login.body.data.login.new_active_region, 'id');
  assert.equal(login.body.data.login.region_id_mapping.id, 2);
  assert.ok(login.body.data.login.ping_addr_list.length > 0);
  assert.equal(login.body.data.handshake.used, true);

  const reusedHandshake = await jsonFetch('/api/login', {
    method: 'POST',
    headers: {
      authorization: `Bearer ${accessToken}`,
      'content-type': 'application/json',
    },
    body: JSON.stringify({ handshakeId: handshake.body.data.handshakeId }),
  });
  assert.equal(reusedHandshake.response.status, 401);
  assert.equal(reusedHandshake.body.error.code, 'HANDSHAKE_INVALID');

  const refreshed = await jsonFetch('/oauth/token', {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: formBody({
      grant_type: 'refresh_token',
      refresh_token: refreshToken,
      client_id: '100067',
    }),
  });
  assert.equal(refreshed.response.status, 200);
  assert.ok(refreshed.body.access_token);
  assert.notEqual(refreshed.body.refresh_token, refreshToken);

  const oldRefresh = await jsonFetch('/oauth/token', {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: formBody({ grant_type: 'refresh_token', refresh_token: refreshToken }),
  });
  assert.equal(oldRefresh.response.status, 200);
  assert.equal(oldRefresh.body.error, 'invalid_grant');

  accessToken = refreshed.body.access_token;
  refreshToken = refreshed.body.refresh_token;
});

test('profile and lobby return player state and room data', async () => {
  const profile = await jsonFetch('/api/profile', {
    headers: { authorization: `Bearer ${accessToken}` },
  });
  assert.equal(profile.response.status, 200);
  assert.equal(profile.body.data.profile.uid, String(user));
  assert.equal(profile.body.data.profile.region, 'id');

  const lobbyResponse = await jsonFetch('/api/lobby', {
    headers: { authorization: `Bearer ${accessToken}` },
  });
  assert.equal(lobbyResponse.response.status, 200);
  assert.equal(lobbyResponse.body.data.profile.uid, String(user));
  assert.ok(Array.isArray(lobbyResponse.body.data.playlists));
  assert.equal(lobbyResponse.body.data.services.battle.available, false);

  const created = await jsonFetch('/api/lobby/rooms', {
    method: 'POST',
    headers: {
      authorization: `Bearer ${accessToken}`,
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      name: 'Integration Room',
      mode: 'br_squad',
      map: 'bermuda',
      max_players: 4,
    }),
  });
  assert.equal(created.response.status, 201);
  roomId = created.body.data.room.id;
  assert.equal(created.body.data.room.host_uid, String(user));

  const second = await registerAndGrant('second-user-password-'.repeat(2));
  const joined = await jsonFetch(`/api/lobby/rooms/${roomId}/join`, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${second.grant.access_token}`,
      'content-type': 'application/json',
    },
    body: '{}',
  });
  assert.equal(joined.response.status, 200);
  assert.equal(joined.body.data.room.member_count, 2);

  const left = await jsonFetch(`/api/lobby/rooms/${roomId}/leave`, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${second.grant.access_token}`,
      'content-type': 'application/json',
    },
    body: '{}',
  });
  assert.equal(left.response.status, 200);
  assert.equal(left.body.data.left, true);
  assert.equal(left.body.data.deleted, false);
});

test('WebSocket handshake/login/lobby/room/logout flow works', async () => {
  const { ws, next, request } = await connectWebSocket();
  try {
    const welcome = await next((message) => message.data?.event === 'connected');
    assert.equal(welcome.cmdType, 0);
    assert.equal(welcome.ok, true);

    const ping = await request({
      type: 'ping',
      requestId: 'ws-ping',
      data: { clientTime: 1234 },
    });
    assert.equal(ping.ok, true);
    assert.equal(ping.command, 'PING');
    assert.equal(ping.data.clientTime, 1234);

    const unauthorizedLobby = await request({
      cmdType: 3,
      requestId: 'ws-unauthorized',
      subCmdType: 0,
      regionID: 'id',
    });
    assert.equal(unauthorizedLobby.ok, false);
    assert.equal(unauthorizedLobby.error.code, 'AUTH_REQUIRED');

    const login = await request({
      type: 'login',
      requestId: 'ws-login',
      data: { accessToken, region: 'id' },
    });
    assert.equal(login.ok, true);
    assert.equal(login.command, 'LOGIN');
    assert.equal(login.data.authenticated, true);
    assert.equal(login.data.profile.nickname, 'IntegrationGuest');

    const lobbyMessage = await request({
      cmdType: 3,
      subCmdType: 0,
      regionID: 'id',
      requestId: 'ws-lobby',
    });
    assert.equal(lobbyMessage.ok, true);
    assert.equal(lobbyMessage.data.region.region, 'id');
    assert.ok(lobbyMessage.data.rooms.some((room) => room.id === roomId));

    const leaveExisting = await request({
      type: 'lobby.room.leave',
      requestId: 'ws-room-leave-existing',
      data: { roomId },
    });
    assert.equal(leaveExisting.ok, true);
    assert.equal(leaveExisting.data.deleted, true);

    const room = await request({
      type: 'lobby.room.create',
      requestId: 'ws-room-create',
      data: { name: 'WebSocket Room', mode: 'clash_squad', map: 'kalahari' },
    });
    assert.equal(room.ok, true);
    assert.equal(room.data.room.mode, 'clash_squad');

    const leave = await request({
      type: 'lobby.room.leave',
      requestId: 'ws-room-leave',
      data: { roomId: room.data.room.id },
    });
    assert.equal(leave.ok, true);
    assert.equal(leave.data.left, true);

    const logout = await request({ type: 'logout', requestId: 'ws-logout' });
    assert.equal(logout.ok, true);
    assert.equal(logout.data.loggedOut, true);

    const afterLogout = await request({
      type: 'lobby.get',
      requestId: 'ws-after-logout',
    });
    assert.equal(afterLogout.ok, false);
    assert.equal(afterLogout.error.code, 'AUTH_REQUIRED');

    const revokedHttp = await jsonFetch('/api/profile', {
      headers: { authorization: `Bearer ${accessToken}` },
    });
    assert.equal(revokedHttp.response.status, 401);
    assert.equal(revokedHttp.body.error.code, 'TOKEN_REVOKED');
  } finally {
    ws.close();
  }
});
