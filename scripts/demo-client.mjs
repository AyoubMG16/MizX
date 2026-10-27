import crypto from 'node:crypto';
import WebSocket from 'ws';

const baseUrl = (process.env.DEMO_BASE_URL ?? 'http://127.0.0.1:3000').replace(/\/+$/, '');
const password = crypto.randomBytes(32).toString('hex');

function form(fields) {
  return new URLSearchParams(fields);
}

async function request(path, options = {}) {
  const response = await fetch(`${baseUrl}${path}`, options);
  const text = await response.text();
  let body;
  try {
    body = text ? JSON.parse(text) : null;
  } catch {
    body = text;
  }
  if (!response.ok) {
    throw new Error(`${options.method ?? 'GET'} ${path} -> ${response.status}: ${text}`);
  }
  return body;
}

function connectWebSocket() {
  const ws = new WebSocket(`${baseUrl.replace(/^http/, 'ws')}/ws`);
  const queue = [];
  const waiters = [];

  ws.on('message', (raw) => {
    const message = JSON.parse(raw.toString());
    const index = waiters.findIndex((waiter) => waiter.predicate(message));
    if (index >= 0) {
      const [waiter] = waiters.splice(index, 1);
      clearTimeout(waiter.timer);
      waiter.resolve(message);
    } else {
      queue.push(message);
    }
  });

  function next(predicate, timeoutMs = 5000) {
    const index = queue.findIndex(predicate);
    if (index >= 0) return Promise.resolve(queue.splice(index, 1)[0]);
    return new Promise((resolve, reject) => {
      const waiter = { predicate, resolve, timer: null };
      waiter.timer = setTimeout(() => {
        const waiterIndex = waiters.indexOf(waiter);
        if (waiterIndex >= 0) waiters.splice(waiterIndex, 1);
        reject(new Error('Timed out waiting for a WebSocket message.'));
      }, timeoutMs);
      waiters.push(waiter);
    });
  }

  async function command(message) {
    const response = next((candidate) => candidate.requestId === message.requestId);
    ws.send(JSON.stringify(message));
    return response;
  }

  return new Promise((resolve, reject) => {
    ws.once('open', () => resolve({ ws, next, command }));
    ws.once('error', reject);
  });
}

console.log(`[demo] using ${baseUrl}`);
const health = await request('/healthz');
console.log(`[demo] health: ${health.status}`);

const registration = await request('/oauth/guest/register', {
  method: 'POST',
  headers: { 'content-type': 'application/x-www-form-urlencoded' },
  body: form({ password, app_id: '100067', source: '2' }),
});
console.log(`[demo] guest uid: ${registration.uid}`);

const grant = await request('/oauth/guest/token/grant', {
  method: 'POST',
  headers: { 'content-type': 'application/x-www-form-urlencoded' },
  body: form({
    uid: String(registration.uid),
    password,
    response_type: 'token',
    client_type: '2',
    client_id: '100067',
  }),
});
const accessToken = grant.access_token;
console.log(`[demo] token granted, open_id=${grant.open_id}`);

const handshake = await request('/api/handshake', {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({
    clientVersion: '1.38.2',
    platform: 'android',
    deviceId: 'demo-device',
  }),
});
console.log(`[demo] handshake: ${handshake.data.handshakeId}`);

const login = await request('/api/login', {
  method: 'POST',
  headers: {
    authorization: `Bearer ${accessToken}`,
    'content-type': 'application/json',
  },
  body: JSON.stringify({ handshakeId: handshake.data.handshakeId, region: 'sg' }),
});
console.log(`[demo] HTTP login: ${login.data.profile.nickname} (${login.data.profile.uid})`);

const lobby = await request('/api/lobby', {
  headers: { authorization: `Bearer ${accessToken}` },
});
console.log(
  `[demo] lobby: ${lobby.data.presence.online_players} online, ${lobby.data.rooms.length} room(s)`,
);

const created = await request('/api/lobby/rooms', {
  method: 'POST',
  headers: {
    authorization: `Bearer ${accessToken}`,
    'content-type': 'application/json',
  },
  body: JSON.stringify({
    name: 'Demo room',
    mode: 'br_squad',
    map: 'bermuda',
    max_players: 4,
  }),
});
const roomId = created.data.room.id;
console.log(`[demo] room created: ${roomId}`);

const { ws, next, command } = await connectWebSocket();
try {
  const welcome = await next((message) => message.data?.event === 'connected');
  console.log(`[demo] WebSocket connected: ${welcome.command}`);

  const wsLogin = await command({
    type: 'login',
    requestId: 'demo-login',
    data: { accessToken, region: 'sg' },
  });
  console.log(`[demo] WebSocket login: ${wsLogin.ok}`);

  const wsLobby = await command({
    type: 'lobby.get',
    requestId: 'demo-lobby',
  });
  console.log(`[demo] WebSocket lobby rooms: ${wsLobby.data.rooms.length}`);

  const ping = await command({
    type: 'ping',
    requestId: 'demo-ping',
    data: { clientTime: Date.now() },
  });
  console.log(`[demo] WebSocket ping: ${ping.data.pong}`);

  const leave = await command({
    type: 'lobby.room.leave',
    requestId: 'demo-room-leave',
    data: { roomId },
  });
  console.log(`[demo] room left over WebSocket: ${leave.data.left}`);

  await command({ type: 'logout', requestId: 'demo-logout' });
  console.log('[demo] WebSocket session revoked');
} finally {
  ws.close();
}

console.log('[demo] done');
