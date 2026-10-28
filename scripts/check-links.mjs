import assert from 'node:assert/strict';
import WebSocket from 'ws';

const baseUrl = (
  process.env.BASE_URL ??
  process.env.DEMO_BASE_URL ??
  'http://127.0.0.1:3000'
).replace(/\/+$/, '');
const expectedWebSocketUrl = `${baseUrl.replace(/^http/, 'ws')}/ws`;

async function getJson(path) {
  let response;
  try {
    response = await fetch(`${baseUrl}${path}`, {
      signal: AbortSignal.timeout(60_000),
    });
  } catch (error) {
    throw new Error(`Could not reach ${baseUrl}${path}: ${error.message}`);
  }

  const text = await response.text();
  let body;
  try {
    body = text ? JSON.parse(text) : null;
  } catch {
    throw new Error(`${path} returned non-JSON content (HTTP ${response.status}).`);
  }
  if (!response.ok) {
    throw new Error(`${path} returned HTTP ${response.status}: ${text.slice(0, 200)}`);
  }
  return body;
}

function checkWebSocket() {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(expectedWebSocketUrl);
    const timer = setTimeout(() => {
      ws.terminate();
      reject(new Error(`Timed out waiting for ${expectedWebSocketUrl}.`));
    }, 60_000);

    function fail(error) {
      clearTimeout(timer);
      ws.terminate();
      reject(error);
    }

    ws.once('error', fail);
    ws.on('message', (raw) => {
      let message;
      try {
        message = JSON.parse(raw.toString());
      } catch {
        fail(new Error('WebSocket returned a non-JSON message.'));
        return;
      }

      if (message.data?.event === 'connected') {
        assert.equal(message.ok, true);
        ws.send(
          JSON.stringify({
            type: 'ping',
            requestId: 'check-links',
            data: { clientTime: Date.now() },
          }),
        );
        return;
      }

      if (message.requestId === 'check-links') {
        try {
          assert.equal(message.ok, true);
          assert.equal(message.data?.pong, true);
          clearTimeout(timer);
          ws.close();
          resolve();
        } catch (error) {
          fail(error);
        }
      }
    });
  });
}

console.log(`[check] base URL: ${baseUrl}`);

const health = await getJson('/healthz');
assert.equal(health.status, 'ok');
console.log('[check] health: ok');

const root = await getJson('/');
assert.equal(root.status, 'ok');
for (const [name, url] of Object.entries(root.endpoints ?? {})) {
  if (name === 'websocket') {
    assert.equal(url, expectedWebSocketUrl);
  } else {
    assert.ok(
      url.startsWith(`${baseUrl}/`),
      `${name} link does not use the configured base URL: ${url}`,
    );
  }
}
console.log(`[check] service links: ${Object.keys(root.endpoints ?? {}).length} verified`);

const version = await getJson('/live/ver.php');
assert.ok(version.appstore?.latest_version);
assert.ok('gameassetbundles' in version);
console.log(`[check] version manifest: ${version.appstore.latest_version}`);

const serverList = await getJson('/live/serverList.json');
assert.equal(serverList.base_url, baseUrl);
assert.equal(serverList.websocket_url, expectedWebSocketUrl);
assert.ok(Array.isArray(serverList.serverList) && serverList.serverList.length > 0);
for (const server of serverList.serverList) {
  assert.equal(server.websocket_url, expectedWebSocketUrl);
  assert.ok(server.address, `Missing address for region ${server.region}.`);
}
console.log(`[check] server list: ${serverList.serverList.length} region(s) verified`);

const protocol = await getJson('/api/protocol');
assert.ok(protocol.data?.commands?.some((command) => command.name === 'LOGIN'));
console.log(`[check] protocol: ${protocol.data.commands.length} command(s) verified`);

await checkWebSocket();
console.log(`[check] WebSocket: ${expectedWebSocketUrl} connected and answered ping`);
console.log('[check] all server links are consistent');
