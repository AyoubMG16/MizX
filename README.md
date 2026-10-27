# Free Fire 1.38.2 Mock Backend

A Node.js **Express + WebSocket** backend built from static analysis of the
`Free Fire 1.38.2` Android APK. It implements the pieces that can be recovered
and safely reproduced from the client:

- Version/discovery endpoints used by the launcher
- Garena-style guest registration and token grant flow
- Short-lived handshake and signed session tokens
- Login response shaped after the recovered `LoginRes` fields
- Lobby snapshot, player profile, custom rooms, and room membership
- A documented JSON WebSocket protocol using the recovered
  `cmdType` / `subCmdType` / `regionID` envelope style
- Health checks, rate limiting, CORS, request IDs, and graceful shutdown
- Ready-to-deploy Render configuration

> **This is not a private game server and cannot host the retail client.**
> The live client uses encrypted protobuf over proprietary TCP/RUDP with
> unexported keys and anti-cheat checks. This project does **not** bypass
> encryption, authentication, integrity checks, anti-cheat, or Garena's
> production services, and it does not implement battle, chat, matchmaking,
> purchases, or game assets. See [Limitations](#limitations).

The APK and all decompiled artifacts are intentionally **excluded** from this
repository. Only curated analysis notes are included in
[`docs/APK_ANALYSIS.md`](docs/APK_ANALYSIS.md).

---

## Contents

- [What this is](#what-this-is)
- [Features](#features)
- [Project layout](#project-layout)
- [Requirements](#requirements)
- [Quick start](#quick-start)
- [End-to-end API walkthrough](#end-to-end-api-walkthrough)
- [HTTP API](#http-api)
- [WebSocket protocol](#websocket-protocol)
- [Configuration](#configuration)
- [Deploying to Render](#deploying-to-render)
- [Testing](#testing)
- [APK analysis summary](#apk-analysis-summary)
- [Security notes](#security-notes)
- [Troubleshooting](#troubleshooting)
- [Limitations](#limitations)
- [Legal notice](#legal-notice)

---

## What this is

The APK analysis recovered two distinct surfaces:

1. **Recoverable HTTP endpoints** in the Garena SDK and the Unity launcher:
   version checks, a server-list resource, guest registration, guest token
   grants, token refresh/inspection, and user info.
2. **A proprietary in-game service layer**, where the client uses a protobuf
   payload inside encrypted TCP/RUDP sessions. Logical field and command names
   are recoverable from IL2CPP metadata, but the actual wire format and keys are
   not reproduced here.

This backend implements the first surface and provides a clean, documented mock
of the second surface's session/envelope concepts. It is useful for:

- Testing launcher, login, and lobby UI flows
- Prototyping a client or admin tool
- Studying the recovered field names and request/response shapes
- Demonstrating deployment of an HTTP/WebSocket service on Render

It is **not** a drop-in replacement for the game's production services.

## Features

| Area | Status | Notes |
| --- | --- | --- |
| Launcher version endpoint | ✅ | `GET /live/ver.php` with recovered top-level keys |
| Server list | ✅ | `GET /live/serverList.json` |
| Guest registration | ✅ | `POST /oauth/guest/register` |
| Guest token grant | ✅ | `POST /oauth/guest/token/grant` |
| Refresh token rotation | ✅ | `POST /oauth/token` |
| Token inspection/user info | ✅ | Garena-style compatibility routes |
| Handshake | ✅ | HTTP and WebSocket |
| Signed access/refresh tokens | ✅ | HMAC-signed JWT, per-session revocation |
| Login response | ✅ | Fields modeled after recovered `LoginRes` |
| Profile and lobby snapshot | ✅ | In-memory state |
| Custom rooms | ✅ | Create/list/join/leave over HTTP and WebSocket |
| WebSocket envelope | ✅ | Clean JSON, not the retail binary protocol |
| Chat, voice, matchmaking, battle | ❌ | Explicitly out of scope |
| Persistent database | ❌ | In-memory only |
| Retail client compatibility | ❌ | Requires proprietary encryption/protocol work |

## Project layout

```text
.
├── src/
│   ├── app.js                 # Express app assembly, CORS, rate limits
│   ├── auth.js                # Guest auth, scrypt hashes, JWT sessions
│   ├── config.js              # Validated environment configuration
│   ├── errors.js              # AppError + central error handling
│   ├── game-data.js           # Regions, modes, maps, ranks, announcements
│   ├── index.js               # HTTP server, WebSocket attach, shutdown
│   ├── lobby.js               # Profile/login serializers, room service
│   ├── middleware.js          # Request IDs, auth, rate limiting, envelopes
│   ├── protocol.js            # WebSocket command table and envelopes
│   ├── realtime.js            # WebSocket gateway
│   ├── store.js               # In-memory users, sessions, handshakes, rooms
│   ├── urls.js                # Public URL and WebSocket URL derivation
│   ├── validation.js          # Small input validation helpers
│   └── routes/
│       ├── api.js             # /api application endpoints
│       ├── garena.js          # /oauth Garena-style endpoints
│       └── system.js          # /, health, /live endpoints
├── docs/
│   └── APK_ANALYSIS.md        # Curated static-analysis notes
├── scripts/
│   └── demo-client.mjs        # End-to-end HTTP + WebSocket demo
├── test/
│   └── integration.test.js    # Node test-runner integration tests
├── .env.example
├── .gitignore
├── package.json
├── package-lock.json
├── render.yaml
└── README.md
```

## Requirements

- Node.js **20.11+** (tested with Node.js 24)
- npm
- Optional: `jq` for the shell examples
- Optional: `wscat` (`npx wscat`) for interactive WebSocket testing

## Quick start

```bash
npm install
cp .env.example .env

# Development works without JWT_SECRET. Production does not.
npm start
# or: npm run dev
```

The server listens on `PORT` (default `3000`) and `HOST` (default `0.0.0.0`).

Check it:

```bash
curl -s http://localhost:3000/healthz | jq
curl -s http://localhost:3000/live/ver.php | jq
curl -s http://localhost:3000/api/protocol | jq
```

Open `http://localhost:3000/` for a service descriptor.

## End-to-end API walkthrough

These commands use `jq` and bash. Start the server first.

### 1. Discovery and handshake

```bash
curl -s http://localhost:3000/live/serverList.json | jq '.serverList[0]'

curl -s -X POST http://localhost:3000/api/handshake \
  -H 'Content-Type: application/json' \
  -d '{"clientVersion":"1.38.2","platform":"android","deviceId":"demo-device"}' | jq
```

Save the returned `data.handshakeId` if you want it to be consumed by login.
A handshake is single-use and expires after `HANDSHAKE_TTL_SECONDS`.

### 2. Create a guest account

The original SDK sends form data, not JSON. Both form and JSON bodies are
accepted here.

```bash
GUEST_PASSWORD="$(openssl rand -hex 32)"

GUEST_UID="$(curl -s -X POST http://localhost:3000/oauth/guest/register \
  -H 'Content-Type: application/x-www-form-urlencoded' \
  --data-urlencode "password=${GUEST_PASSWORD}" \
  --data-urlencode 'client_type=2' \
  --data-urlencode 'app_id=100067' \
  --data-urlencode 'source=2' | jq -r '.uid')"

echo "guest uid: ${GUEST_UID}"
```

The implementation stores a **scrypt hash** of the password, never the
plaintext.

### 3. Grant an access token

```bash
TOKENS="$(curl -s -X POST http://localhost:3000/oauth/guest/token/grant \
  -H 'Content-Type: application/x-www-form-urlencoded' \
  --data-urlencode "uid=${GUEST_UID}" \
  --data-urlencode "password=${GUEST_PASSWORD}" \
  --data-urlencode 'response_type=token' \
  --data-urlencode 'client_type=2' \
  --data-urlencode 'client_id=100067')"

echo "${TOKENS}" | jq

ACCESS_TOKEN="$(echo "${TOKENS}" | jq -r '.access_token')"
REFRESH_TOKEN="$(echo "${TOKENS}" | jq -r '.refresh_token')"
```

The response mirrors the fields read by the SDK:
`open_id`, `access_token`, `refresh_token`, and `expiry_time`.

### 4. Log in with the token

```bash
HANDSHAKE_ID="$(curl -s -X POST http://localhost:3000/api/handshake \
  -H 'Content-Type: application/json' \
  -d '{"clientVersion":"1.38.2","platform":"android"}' | jq -r '.data.handshakeId')"

curl -s -X POST http://localhost:3000/api/login \
  -H "Authorization: Bearer ${ACCESS_TOKEN}" \
  -H 'Content-Type: application/json' \
  -d "{\"handshakeId\":\"${HANDSHAKE_ID}\",\"region\":\"sg\"}" | jq
```

`handshakeId` is optional. Login also accepts guest credentials directly:

```json
{
  "uid": "123456789",
  "password": "the-guest-password",
  "region": "sg"
}
```

### 5. Fetch the profile and lobby

```bash
curl -s http://localhost:3000/api/profile \
  -H "Authorization: Bearer ${ACCESS_TOKEN}" | jq

curl -s http://localhost:3000/api/lobby \
  -H "Authorization: Bearer ${ACCESS_TOKEN}" | jq
```

The lobby snapshot contains the profile, region, session expiry, playlists,
maps, announcements, visible rooms, current room, and capability flags.

### 6. Create and join a room

```bash
ROOM="$(curl -s -X POST http://localhost:3000/api/lobby/rooms \
  -H "Authorization: Bearer ${ACCESS_TOKEN}" \
  -H 'Content-Type: application/json' \
  -d '{"name":"Demo room","mode":"br_squad","map":"bermuda","max_players":4}')"

echo "${ROOM}" | jq
ROOM_ID="$(echo "${ROOM}" | jq -r '.data.room.id')"
```

Join/leave as the same or another authenticated account:

```bash
curl -s -X POST "http://localhost:3000/api/lobby/rooms/${ROOM_ID}/join" \
  -H "Authorization: Bearer ${ACCESS_TOKEN}" | jq

curl -s -X POST "http://localhost:3000/api/lobby/rooms/${ROOM_ID}/leave" \
  -H "Authorization: Bearer ${ACCESS_TOKEN}" | jq
```

Room rules:

- A user can be in only one room at a time.
- A full room returns `ROOM_FULL`.
- When the host leaves, host ownership transfers to the next member.
- When the last member leaves, the room is deleted.
- Private rooms are only visible to members in room lists.

### 7. Refresh and rotate tokens

```bash
NEW_TOKENS="$(curl -s -X POST http://localhost:3000/oauth/token \
  -H 'Content-Type: application/x-www-form-urlencoded' \
  --data-urlencode 'grant_type=refresh_token' \
  --data-urlencode "refresh_token=${REFRESH_TOKEN}" \
  --data-urlencode 'client_id=100067')"

echo "${NEW_TOKENS}" | jq
```

Refresh tokens are single-use and rotate. Reusing an old refresh token returns
`invalid_grant`.

### 8. Log out

```bash
curl -s -X POST http://localhost:3000/api/logout \
  -H "Authorization: Bearer ${ACCESS_TOKEN}" | jq
```

This revokes the whole session, including its refresh token.

## HTTP API

All `/api` responses use a common JSON envelope:

```json
{
  "ok": true,
  "requestId": "c98d0a4f-7d40-4bb9-bba0-a1e932f79f0d",
  "serverTime": 1793142934979,
  "data": {}
}
```

Errors use the same envelope with `ok: false` and an `error` object. Every
response includes an `x-request-id` header; a valid client-supplied
`x-request-id` is preserved.

The Garena-style `/oauth` routes intentionally return SDK-friendly raw JSON
objects (not the generic envelope) and use OAuth-style error responses where
appropriate.

### Public endpoints

| Method | Path | Purpose |
| --- | --- | --- |
| `GET` | `/` | Service descriptor and endpoint links |
| `GET` | `/health` | Health check with in-memory store statistics |
| `GET` | `/healthz` | Render health-check alias |
| `GET` | `/live/ver.php` | Version/hot-update style manifest |
| `GET` | `/live/serverList.json` | Regions and server addresses |
| `GET` | `/live/announcements.json` | Lobby announcements |
| `GET` | `/api/protocol` | WebSocket protocol and command table |
| `POST` | `/api/events` | Accepts client telemetry-style JSON (not persisted) |

### Garena-compatible auth routes

| Method | Path | Input |
| --- | --- | --- |
| `POST` | `/oauth/guest/register` | `password`, `client_type`, `app_id`, `source`; optional `nickname`, `region` |
| `POST` | `/oauth/guest/token/grant` | `uid`, `password`, `response_type=token`, `client_type`, `client_id` |
| `POST` | `/oauth/token` | `grant_type=refresh_token`, `refresh_token`, `client_id` |
| `GET/POST` | `/oauth/token/inspect` | `access_token` in body/query or Bearer header |
| `GET/POST` | `/oauth/user/info/get` | Access token |
| `POST` | `/oauth/logout` | Access or refresh token |

Garena routes accept `application/json` and
`application/x-www-form-urlencoded`. OAuth-style failures such as
`invalid_grant`, `invalid_request`, and `unsupported_response_type` are returned
with HTTP 200 so the original SDK callback style sees a structured error. The
application API uses normal HTTP status codes.

### Application endpoints

| Method | Path | Auth | Purpose |
| --- | --- | --- | --- |
| `POST` | `/api/handshake` | No | Create a single-use handshake |
| `POST` | `/api/login` | Token or guest credentials | Login and return `LoginRes`-style data |
| `POST` | `/api/logout` | Bearer | Revoke current session |
| `GET` | `/api/profile` | Bearer | Profile and session details |
| `GET` | `/api/session` | Bearer | Session metadata |
| `GET` | `/api/lobby` | Bearer | Full lobby snapshot |
| `GET` | `/api/lobby/rooms` | Bearer | Visible rooms; optional `?region=` |
| `POST` | `/api/lobby/rooms` | Bearer | Create a room |
| `POST` | `/api/lobby/rooms/:roomId/join` | Bearer | Join a room |
| `POST` | `/api/lobby/rooms/:roomId/leave` | Bearer | Leave a room |

#### `POST /api/handshake`

Request fields are optional:

```json
{
  "clientVersion": "1.38.2",
  "platform": "android",
  "deviceId": "device-or-install-id",
  "region": "sg"
}
```

The response includes `handshakeId`, `expiresAt`, protocol version, region,
client-version compatibility, capability flags, and public endpoint URLs.

#### `POST /api/login`

Provide either a Bearer token (or `accessToken` in the body) or
`uid` + `password`. `handshakeId` is optional but, when supplied, is consumed
and validated. `region` overrides the account's current region.

The `data.login` object is modeled on the recovered `LoginRes` field names:
`chat_server`, `notification_channel`, `voice_server`, `event_log_url`, `ttl`,
`region_id_mapping`, `new_active_region`, `recommend_regions`, `server_time`,
`queue_position`, `need_waiting_secs`, `chat_addr`, `elite_pass_basic_info`,
`rank_info`, `voice_type`, `agora_environment`, `network_log_url`,
`ping_addr_list`, and `ranking_peak_threshold`.

These are **mock values** with the recovered names, not values from a live
Garena service.

#### Room creation body

```json
{
  "name": "Friday squad",
  "mode": "br_squad",
  "map": "bermuda",
  "max_players": 4,
  "visibility": "public",
  "region": "sg"
}
```

Supported modes: `br_solo`, `br_duo`, `br_squad`, `clash_squad`.

Supported maps: `bermuda`, `purgatory`, `kalahari`, `alpine`.

### Authentication

Use:

```http
Authorization: Bearer <access_token>
```

For compatibility, the Garena routes also accept `access_token` in a form body
or query string. Avoid putting tokens in URLs outside local testing because
URLs may be logged.

### Common error codes

| Code | HTTP | Meaning |
| --- | --- | --- |
| `VALIDATION_ERROR` | 400 | A field failed validation |
| `INVALID_BODY` / `INVALID_JSON` | 400 | Malformed request body |
| `AUTH_REQUIRED` | 401 | No access token or WebSocket login |
| `TOKEN_INVALID` | 401 | Bad signature, malformed token, or wrong type |
| `TOKEN_EXPIRED` | 401 | Access token expired |
| `TOKEN_REVOKED` | 401 | Session logged out or refresh token rotated |
| `HANDSHAKE_INVALID` | 401 | Handshake missing, reused, or expired |
| `HANDSHAKE_EXPIRED` | 401 | Handshake TTL elapsed |
| `INVALID_GRANT` | 401 | Wrong guest uid/password |
| `UNKNOWN_REGION` | 400 | Unsupported region code |
| `ALREADY_IN_ROOM` | 409 | User is already in another room |
| `ROOM_FULL` | 409 | Room capacity reached |
| `ROOM_NOT_FOUND` | 404 | Unknown room id |
| `NOT_IN_ROOM` | 403 | Leave requested without membership |
| `RATE_LIMITED` | 429 | HTTP rate limit exceeded |
| `CORS_ORIGIN_DENIED` | 403 | Browser origin not allowed |
| `NOT_FOUND` | 404 | Unknown route |
| `INTERNAL_ERROR` | 500 | Unexpected failure |

## WebSocket protocol

Connect to:

```text
ws://localhost:3000/ws
```

On Render, use the `wss://` version of your public service URL:

```text
wss://your-service.onrender.com/ws
```

The WebSocket protocol is a **clean JSON envelope inspired by** the
`cmdType`/`subCmdType`/`regionID` fields found in the client. It is not the
retail game's encrypted binary protocol.

### Envelope

Client request:

```json
{
  "cmdType": 2,
  "subCmdType": 0,
  "regionID": "sg",
  "requestId": "login-1",
  "seq": 1,
  "data": {}
}
```

`cmdType` can also be a command string such as `"handshake"`, `"login"`, or
`"lobby.get"`; `type` and `command` are accepted as aliases. `requestId` and
`seq` are echoed in the response.

Server response:

```json
{
  "ok": true,
  "cmdType": 2,
  "subCmdType": 0,
  "command": "LOGIN",
  "regionID": "sg",
  "requestId": "login-1",
  "seq": 1,
  "serverTime": 1793142951000,
  "data": {}
}
```

Errors replace `data` with:

```json
{
  "error": {
    "code": "AUTH_REQUIRED",
    "message": "Log in over this WebSocket before using this command."
  }
}
```

### Commands

| cmdType | Name | Auth | Data |
| --- | --- | --- | --- |
| `0` | `SERVER_EVENT` | No | Server-originated welcome/event |
| `1` | `HANDSHAKE` | No | `clientVersion`, `platform`, `deviceId`, `region` |
| `2` | `LOGIN` | No | `accessToken` or `uid` + `password`; optional `handshakeId`, `region` |
| `3` | `LOBBY_GET` | Yes | none |
| `4` | `ROOM_CREATE` | Yes | `name`, `mode`, `map`, `max_players`, `visibility`, `region` |
| `5` | `ROOM_JOIN` | Yes | `roomId` |
| `6` | `ROOM_LEAVE` | Yes | `roomId` |
| `7` | `PING` | No | optional `clientTime` |
| `8` | `LOGOUT` | Yes | none |

The server closes the socket with code `1008` after exceeding the per-window
message limit. Protocol-level ping/pong frames are also sent by the server; a
client that does not answer is terminated after the heartbeat interval.

### Interactive example

```bash
npx wscat -c ws://localhost:3000/ws
```

The first message is the welcome event. Send one JSON object per line:

```json
{"type":"login","requestId":"login-1","data":{"accessToken":"PASTE_ACCESS_TOKEN","region":"sg"}}
```

```json
{"cmdType":3,"subCmdType":0,"regionID":"sg","requestId":"lobby-1","seq":2}
```

```json
{"type":"lobby.room.create","requestId":"room-1","data":{"name":"WS room","mode":"clash_squad","map":"kalahari","max_players":8}}
```

```json
{"type":"ping","requestId":"ping-1","data":{"clientTime":1793142951000}}
```

```json
{"type":"logout","requestId":"logout-1"}
```

A WebSocket login does not replace the HTTP session; it attaches the same
signed access-token session to the socket. Logging out over either surface
revokes the session for both.

## Configuration

Copy `.env.example` to `.env`. All environment variables are optional in
development except where noted.

| Variable | Default | Purpose |
| --- | --- | --- |
| `NODE_ENV` | `development` | `production` requires `JWT_SECRET` |
| `PORT` | `3000` | HTTP/WebSocket port; Render injects it |
| `HOST` | `0.0.0.0` | Bind address |
| `PUBLIC_URL` | empty | Public origin used in returned URLs |
| `JWT_SECRET` | dev-only fallback | HMAC signing key; **required in production** |
| `CORS_ORIGIN` | `*` | Comma-separated origins or `*` |
| `TRUST_PROXY` | `1` in production, `0` otherwise | Proxy hop count/boolean |
| `ACCESS_TOKEN_TTL_SECONDS` | `3600` | Access-token lifetime |
| `REFRESH_TOKEN_TTL_SECONDS` | `2592000` | Refresh/session lifetime |
| `HANDSHAKE_TTL_SECONDS` | `600` | Handshake lifetime |
| `RATE_LIMIT_WINDOW_MS` | `60000` | General HTTP window |
| `RATE_LIMIT_MAX` | `300` | General HTTP requests/window/IP |
| `AUTH_RATE_LIMIT_WINDOW_MS` | `600000` | Auth endpoint window |
| `AUTH_RATE_LIMIT_MAX` | `60` | Auth requests/window/IP |
| `GAME_VERSION` | `1.38.2` | Version reported by live endpoints |
| `GAME_VERSION_CODE` | `2019071114` | Version code reported by live endpoints |
| `GARENA_APP_ID` | `100067` | App id encoded in the analyzed APK |
| `GARENA_SOURCE_ID` | `2` | Source id encoded in the analyzed APK |
| `DEFAULT_REGION` | `sg` | Default region; must be a supported code |
| `MAX_ROOMS` | `100` | In-memory room cap |
| `WS_MAX_PAYLOAD_BYTES` | `65536` | Max WebSocket message size |
| `WS_HEARTBEAT_MS` | `30000` | Protocol ping interval |
| `WS_MESSAGE_WINDOW_MS` | `10000` | Per-socket message window |
| `WS_MESSAGE_LIMIT` | `40` | Messages allowed per window |

Generate a production secret with:

```bash
openssl rand -hex 48
```

The server refuses to start in production without a secret of at least 32
characters.

## Deploying to Render

### Option A: `render.yaml` Blueprint

1. Push this project to a GitHub repository. Keep it private if you do not want
   the analysis notes and mock API publicly visible.
2. In Render, choose **New → Blueprint** and select the repository.
3. Render reads `render.yaml`, runs `npm ci`, and starts `npm start`.
4. After the first deploy, open the service and set `PUBLIC_URL` to the assigned
   public URL, for example `https://ff-mock.onrender.com`.
5. Redeploy if necessary. Render health-checks `/healthz`.

`render.yaml` generates `JWT_SECRET` automatically and sets `TRUST_PROXY=1`.

### Option B: Manual Web Service

Create a Render **Web Service** with:

| Setting | Value |
| --- | --- |
| Runtime | Node |
| Build command | `npm ci` |
| Start command | `npm start` |
| Health check path | `/healthz` |

Set these environment variables:

```text
NODE_ENV=production
JWT_SECRET=<openssl rand -hex 48>
TRUST_PROXY=1
PUBLIC_URL=https://your-service.onrender.com
CORS_ORIGIN=*
```

Render provides `PORT`; the server binds to `0.0.0.0` and uses
`process.env.PORT`, so no port changes are required. WebSockets use the same
port and path (`/ws`) and do not require an extra service.

### Render checklist

- [ ] `JWT_SECRET` set (not the development fallback)
- [ ] `PUBLIC_URL` set to the actual HTTPS origin
- [ ] `TRUST_PROXY=1` so rate limiting and forwarded protocol work
- [ ] `GET https://your-service.onrender.com/healthz` returns 200
- [ ] `wss://your-service.onrender.com/ws` accepts a connection
- [ ] Never commit `.env`, the APK, or decompiled output

### Render behavior to expect

- **Free instances spin down** after inactivity and cold-start on the next
  request. The first WebSocket or HTTP request may take longer.
- **State is in memory.** Users, sessions, handshakes, and rooms are lost when
  the process restarts or redeploys.
- **No shared state across instances.** Do not scale beyond one instance
  without moving sessions/rooms to Redis or a database.
- Free instances are suitable for demos and testing, not production
  authentication.

## Testing

Run the integration suite:

```bash
npm test
```

It covers discovery endpoints, guest registration, token grant, handshake
consumption, login, token refresh/rotation, profile, lobby, rooms, WebSocket
login, WebSocket commands, logout, and session revocation.

Run the end-to-end demo against a locally running server:

```bash
npm start
# in another terminal:
npm run demo

# or point at a deployed service:
DEMO_BASE_URL=https://your-service.onrender.com npm run demo
```

The demo creates a guest, logs in, fetches the lobby, creates a room, connects
over WebSocket, pings, logs out, and cleans up the room.

## APK analysis summary

Detailed notes, endpoint tables, and field lists are in
[`docs/APK_ANALYSIS.md`](docs/APK_ANALYSIS.md).

Key recovered facts:

- **Package:** `com.dts.freefireth`
- **Version:** `1.38.2` (`versionCode 2019071114`)
- **Engine:** Unity IL2CPP, metadata v23
- **Garena app/source:** `100067` / `2`
- **Launcher base:** `https://version.common.freefiremobile.com/live/`
  with `ver.php` and `serverList.json`
- **Launcher response keys:** `appstore`, `versioninfo`, `fileinfo`,
  `gameassetbundles`
- **Garena SDK auth paths:** `/oauth/guest/register`,
  `/oauth/guest/token/grant`, `/oauth/token`, `/oauth/token/inspect`,
  `/oauth/user/info/get`, `/oauth/logout`
- **Login/lobby fields:** recovered from IL2CPP metadata as `LoginReq` /
  `LoginRes` property names
- **Service envelope:** `cmdType`, `subCmdType`, `regionID`,
  `SendMessageToLobby`, `SendMessageToChatChannel`
- **Battle transport:** encrypted protobuf over proprietary TCP/RUDP, including
  RUDP opcodes such as `RUDP_JOIN_MATCH`, `RUDP_BATTLE_START`, and `RUDP_DEAD`

The live game protocol could not be truthfully reimplemented from static
analysis alone. The mock JSON protocol is deliberately separate and documented
as such.

## Security notes

- The development JWT secret is public and must never be used in production.
- This is a mock identity provider. Do not reuse real Garena credentials or
  issue tokens to untrusted clients.
- Access tokens are bearer credentials. Use HTTPS/WSS in production and avoid
  logging headers or query strings.
- Rate limiting is per-process and in memory. Use a shared store behind a load
  balancer.
- The scrypt password hash protects stored mock credentials, but the service is
  not a substitute for a hardened authentication system.
- The server implements CORS only for browser clients. CORS is not an
  authentication mechanism.
- Keep the APK, decompiled sources, extracted assets, and any proprietary keys
  out of the repository. `.gitignore` excludes common Android/reverse-engineering
  artifacts.
- Review Garena's terms and local law before reverse-engineering, modifying, or
  interacting with the game.

## Troubleshooting

| Symptom | Likely cause / fix |
| --- | --- |
| `JWT_SECRET is required when NODE_ENV=production` | Set `JWT_SECRET`; do not deploy the dev fallback |
| Login returns `401 TOKEN_INVALID` | Use the exact access token; do not paste a truncated value from logs |
| Login returns `401 HANDSHAKE_INVALID` | Handshakes are single-use; request a new one |
| Refresh returns `invalid_grant` | Refresh tokens rotate; use the newest token |
| Repeated `429 RATE_LIMITED` | Raise limits or wait; limits are per IP/window |
| Browser gets `403 CORS_ORIGIN_DENIED` | Add the browser origin to `CORS_ORIGIN` |
| WebSocket upgrade returns 403 | The browser origin is not allowed |
| WebSocket closes with `1008` | Per-socket message limit exceeded |
| Returned URLs point at `localhost` on Render | Set `PUBLIC_URL` to the public HTTPS origin |
| Rooms disappear after a restart | Expected; state is in memory |
| `ALREADY_IN_ROOM` | Leave the current room before creating/joining another |
| Room list empty | Rooms are region-scoped; create one or check `?region=` |

## Limitations

1. **No retail-client compatibility.** The retail client expects proprietary
   encrypted protobuf messages and its own authentication/handshake chain. This
   project intentionally does not attempt to decrypt, replay, or bypass those
   mechanisms.
2. **No battle or matchmaking.** The RUDP/TCP game service is not implemented.
3. **No chat/voice.** The `LoginRes` fields are present for shape and are set
   to empty/mock values.
4. **No hot-update/asset hosting.** Version endpoints return placeholder
   manifests using the recovered keys. They do not serve game assets.
5. **No persistence.** Restarts and redeploys clear all users, sessions, and
   rooms.
6. **Not hardened for public production use.** It is a development/demo
   service with simple in-memory auth and per-process rate limiting.
7. **No real Garena OAuth.** The guest flow is a local simulation. Real Garena
   tokens will not verify against this server and this server cannot mint valid
   Garena credentials.

If you need a production-quality lobby service, replace the in-memory store
with a database, add a proper identity provider, use a shared rate-limit store,
and run behind HTTPS with a secret manager.

## Legal notice

This project is provided for educational analysis and interoperability testing.
It is not affiliated with, endorsed by, or supported by Garena or Free Fire.
Free Fire and related marks belong to their respective owners. No APK, game
assets, proprietary source code, signing keys, or credentials are included.

Use this project only with content and accounts you are authorized to use, and
comply with applicable terms of service and law.
