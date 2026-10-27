# Free Fire 1.38.2 APK: Network Analysis Notes

These notes document the static analysis that informed the mock backend. The
analysis was performed against a local APK for educational interoperability
research. The APK and decompiled output are intentionally not part of this
repository.

> **Scope warning**
>
> This analysis identifies observable endpoint names, SDK request fields, and
> IL2CPP metadata symbols. It does **not** recover the retail game's encryption
> keys or provide a complete wire-protocol implementation. The backend in this
> repository is a documented mock, not a working private server.

---

## Artifact

| Property | Value |
| --- | --- |
| File name | `Free Fire_1.38.2.apk` |
| Size | 66,482,069 bytes |
| SHA-256 | `70462239e5093a94b7b71cb8749fd8ec1e2fbf9db169fe5e3054f526cf233001` |
| Package | `com.dts.freefireth` |
| Version name | `1.38.2` |
| Version code | `2019071114` |
| Minimum SDK | 15 |
| Target SDK | 28 |
| Engine | Unity IL2CPP (`global-metadata.dat`, metadata v23) |

The APK hash is included for identification only. Do not redistribute the
artifact unless you have the right to do so.

## Method

Tools used:

- `unzip` for APK layout inspection
- `jadx` 1.5.6 for the Java/Kotlin DEX code and resources
- `strings` for native libraries
- A parser for the IL2CPP `global-metadata.dat` string-literal and name tables
- Manual inspection of the manifest, network security config, Garena SDK
  classes, and recovered `LoginReq` / `LoginRes` metadata

No dynamic instrumentation, packet capture, TLS interception, memory dumping,
or anti-cheat bypass was part of this pass. Consequently, endpoint discovery and
field names are reliable; exact binary packet layouts and encryption behavior
are not.

### High-level workflow

```bash
# Inspect the APK container
unzip -l "Free Fire_1.38.2.apk" | head -100

# Decompile DEX code and resources
jadx -d /tmp/jadx-out \
     --resources /tmp/jadx-res \
     "Free Fire_1.38.2.apk"

# Inspect native-library strings
unzip -p "Free Fire_1.38.2.apk" \
  lib/armeabi-v7a/libil2cpp.so | strings -n 5 > /tmp/libil2cpp.strings

# Inspect IL2CPP metadata (custom parser used)
# assets/bin/Data/Managed/Metadata/global-metadata.dat
```

The decompiled Java layer contains the Garena SDK. Most of the actual game is
compiled C# in `libil2cpp.so`, with names and literals in
`global-metadata.dat`.

## Manifest observations

The manifest confirms:

- Package `com.dts.freefireth`, version `1.38.2`, version code `2019071114`
- Unity player activity and a large set of Android permissions (network,
  storage, phone state, audio, billing, notifications, etc.)
- Garena SDK metadata:
  - `com.garena.sdk.applicationId = 100067`
  - `com.garena.sdk.ApplicationSourceId = 2`
  - `com.garena.sdk.push.applicationId = 100067`
- A `networkSecurityConfig` resource that permits cleartext traffic globally and
  for specific domains.

The cleartext policy is relevant when considering why the client can use
`http://` endpoints in some paths, but it does not make the proprietary
binary protocol easier to reproduce.

## Launcher and version endpoints

The launcher strings and metadata exposed:

| Endpoint | Purpose |
| --- | --- |
| `https://version.common.freefiremobile.com/live/` | Launcher/version base |
| `ver.php` | Version and hot-update manifest |
| `serverList.json` | Region/server list resource |
| `https://freefiremobile-a.akamaihd.net/sbt/ABHotUpdates/` | Hot-update CDN base |
| `https://freefiremobile-a.akamaihd.net/common/OB12/loading/temproryCDN.jpg` | Loading asset |
| `http://www.freefiremobile.com/` | Game website |
| `http://www.freefiremobile.com/mobile/ff/deeplink` | Deep-link base |

The version response keys recovered from the launcher include:

- `appstore`
- `versioninfo`
- `fileinfo`
- `gameassetbundles`

The mock backend uses those same top-level keys with placeholder values at
`GET /live/ver.php`. It is not a valid hot-update manifest and does not host
assets.

The exact server-list schema was not fully reconstructed. `serverList.json` and
server-list classes are present in metadata, but the mock uses a documented,
straightforward JSON structure:

```json
{
  "serverList": [
    {
      "region": "sg",
      "region_id": 1,
      "name": "Singapore",
      "address": "example host",
      "port": 443,
      "status": "online"
    }
  ],
  "default_region": "sg"
}
```

## Garena SDK authentication

### Base hosts

`com.beetalk.sdk.SDKConstants` constructs the production root from the app id:

```text
https://<app-id>.connect.garena.com
```

For this APK, the app id is `100067`, implying:

```text
https://100067.connect.garena.com
```

Other observed constants:

| Host | Purpose |
| --- | --- |
| `https://connect.garena.com` | Fallback when app id is unavailable |
| `https://testconnect.garena.com` | SDK test environment |
| `https://devconnect.garena.com` | Developer sandbox |
| `https://sso.garena.com` | SSO web flow |
| `http://connect.garenanow.com` | Legacy app config/feedback endpoints |

These are production Garena endpoints. The mock backend does not proxy to them
and does not use real Garena credentials.

### Recovered routes

The SDK appends these paths to the root URL:

| Method | Path | Notes |
| --- | --- | --- |
| `POST` | `/oauth/guest/register` | Create guest account |
| `POST` | `/oauth/guest/token/grant` | Exchange guest credentials for tokens |
| `POST` | `/oauth/token` | Refresh OAuth token |
| `POST` | `/oauth/token/exchange` | Token exchange flow |
| `POST` | `/oauth/token/inspect` | Inspect token validity |
| `POST` | `/oauth/user/info/get` | Get user info |
| `POST` | `/oauth/logout` | Logout/revoke token |
| `POST` | `/game/guest/bind` | Bind guest account |
| `POST` | `/game/user/request/send` | Game user request bridge |
| Web | `/oauth/login` | Garena web login |
| Web | `/oauth/garena` | OAuth redirect |
| Web | `/oauth/token/facebook/exchange` | Facebook token exchange |
| Web | `/oauth/token/vk/exchange/v2` | VK token exchange |
| Web | `/oauth/token/line/exchange` | LINE token exchange |

The mock implements the guest register/grant, refresh, inspect, user-info, and
logout routes. Friend/payment/binding and social-provider routes are outside its
scope.

### Guest registration request

From `GuestAccountRegRequest` and `GuestRegistrationHandler`, the guest
registration POST sends form data:

| Field | Source |
| --- | --- |
| `password` | 64-character password generated by the SDK |
| `client_type` | `RequestConstants.CLIENT_TYPE` |
| `app_id` | Garena application id (`100067`) |
| `source` | Garena source id (`2`) |

The response is read for a numeric `uid`. The client caches the uid and password
locally and reuses them on later launches.

Mock behavior: validates the password, generates a numeric 9-digit uid, stores
a scrypt hash, and returns `{ "uid": ... }` at
`POST /oauth/guest/register`.

### Guest token grant request

From `GuestGrandTokenRequest`:

| Field | Value |
| --- | --- |
| `uid` | Numeric uid from registration |
| `password` | Cached guest password |
| `response_type` | `token` |
| `client_type` | SDK client type |
| `client_id` | Garena application id |

The SDK reads these response fields:

| Field | Use |
| --- | --- |
| `open_id` | Garena open id |
| `access_token` | Bearer token |
| `refresh_token` | Token refresh |
| `expiry_time` | Token expiry timestamp |

Mock behavior: returns all four fields at
`POST /oauth/guest/token/grant`, plus `expires_in` and `uid`. If credentials are
wrong, it returns an OAuth-style `invalid_grant` object with HTTP 200, matching
the SDK's JSON error handling.

### Refresh and inspection

The SDK has token refresh, exchange, and inspection routes. The mock implements
standard refresh-token rotation at `POST /oauth/token`, inspection at
`GET/POST /oauth/token/inspect`, and local user info at
`GET/POST /oauth/user/info/get`.

The real production refresh response may contain additional scopes or
provider-specific fields. The mock only implements the fields needed by the
guest flow.

## Game login and lobby schema

The Unity IL2CPP metadata contains protobuf message names and properties. The
following names were used to shape the mock JSON responses.

### `LoginReq` fields

Recovered request properties include:

- `game_server_id`
- `event_time`
- `game_id`
- `plat_id`
- `zone_area_id`
- `client_version`
- `system_software`
- `system_hardware`
- `telecom_oper`
- `network`
- `screen_width`
- `screen_hight` (spelling preserved from the client)
- `dpi`
- `cpu_hardware`
- `memory`
- `gl_render`
- `gl_version`
- `client_ip`
- `open_id_type`
- `device_type`
- `device_model`
- `ip_region`
- `others`
- `platform_uid`
- `login_by`

Additional device-integrity/emulator detection fields are present, including
serial/board/brand/fingerprint/hardware/manufacturer values, network operator
and type, IMEI/MEID/subscriber fields, emulator package/property/file lists,
`is_emulator`, `is_root`, `signature_md5`, `emulator_score`, storage sizes, and
`ip_address`.

The mock does **not** collect or validate these sensitive device fields. It
accepts only the client version, platform, device id, region, and auth material
needed for its own flows.

### `LoginRes` fields

Recovered response properties used in the mock:

- `chat_server`
- `notification_channel`
- `voice_server`
- `event_log_url`
- `ttl`
- `region_id_mapping`
- `new_active_region`
- `recommend_regions`
- `server_time`
- `queue_position`
- `need_waiting_secs`
- `chat_addr`
- `elite_pass_basic_info`
- `rank_info`
- `voice_type`
- `agora_environment`
- `network_log_url`
- `ping_addr_list`
- `ranking_peak_threshold`

The mock returns these names at `POST /api/login`, but the values are local mock
data. The real client would still require the correct binary protobuf encoding
and encryption to accept them.

### Match/battle server fields

Metadata/string inspection also exposed fields used when entering a match:

- `GameServerAddr`
- `GameServerPort`
- `GameServerToken`
- `GameServerSecretKey`
- `GameServerMatchID`
- `GameServerMapID`
- `GameServerGameMode`

These describe a dynamic battle-server handoff. The mock does not implement this
handoff and reports battle/matchmaking as unavailable.

## Session/service envelope

`ServiceConnectionHandler` and related classes use:

- `cmdType`
- `subCmdType`
- `regionID`
- `SendMessageToLobby`
- `SendMessageToChatChannel`
- `ReconnectInfo`
- `NextReconnectTime`
- `ReconnectCount`
- `GetDisconnectionReason`

The mock's WebSocket envelope uses `cmdType`, `subCmdType`, and `regionID` for
recognizability, but it sends clean JSON. It does not reproduce any numeric
`cmdType` values, protobuf schemas, or encryption used by the retail client.
Numeric command ids in `src/protocol.js` are defined by this project.

## Transport layer observations

The client contains a separate networking stack beyond HTTP:

- TCP service handlers for lobby/chat-style services
- A custom UDP/RUDP reliable transport
- Protobuf message serialization
- Encryption/decryption routines and key/IV state
- Compression flags and packet tracking
- Reconnect, keep-alive, acknowledgement, and sequence handling

Recovered symbols include:

### TCP

- `TCP_INIT`
- `TCP_HEARTBEAT`
- `TCP_USER`
- `TCP_MTU`
- `TCPMessageIDReserved`
- `PROTO_DATA_TYPE`
- `ServiceConnectionHandler`

### UDP/RUDP

- `UDP_HELLO`
- `UDP_ACK`
- `UDP_PING`
- `UDP_BYEBYE`
- `UDP_LONGTIMENOSEE`
- `RUDP_JOIN_MATCH`
- `RUDP_JOIN_MATCH_FINISHED`
- `RUDP_BATTLE_START`
- `RUDP_DEAD`
- `RUDP_ADD_PICKUP`
- `RUDP_BATTLE_END`

The presence of these names confirms a proprietary binary service, but does not
reveal a usable key schedule or packet format. Implementing a compatible client
would require substantially more analysis and would raise anti-cheat, terms-of-
service, and legal questions. That work is intentionally not included.

## Dynamic lobby endpoints

The game's lobby/chat/battle addresses are not static strings like the version
endpoint. They are delivered through login/session data and dynamic fields such
as `chat_server`, `chat_addr`, and the game-server handoff fields. The mock
therefore exposes its own WebSocket endpoint and returns its own URLs instead of
pretending to reproduce Garena's dynamic topology.

## Mapping from APK findings to this project

| APK finding | Mock implementation |
| --- | --- |
| `https://version.common.freefiremobile.com/live/ver.php` | `GET /live/ver.php` |
| `serverList.json` | `GET /live/serverList.json` |
| Garena guest register | `POST /oauth/guest/register` |
| Garena guest token grant | `POST /oauth/guest/token/grant` |
| Garena refresh/inspect/user info | `/oauth/token`, `/oauth/token/inspect`, `/oauth/user/info/get` |
| SDK `open_id` / tokens / expiry | JWT access + refresh tokens |
| `LoginReq` / `LoginRes` | JSON login request/response at `/api/login` |
| `cmdType` / `subCmdType` / `regionID` | Documented WebSocket JSON envelope |
| Lobby service handler | `/api/lobby`, WebSocket `LOBBY_GET` |
| Chat/voice/battle services | Explicitly unavailable |
| RUDP battle protocol | Not implemented |

## What was not recovered or implemented

- Garena production OAuth secrets or token-exchange trust
- The real game's protobuf `.proto` schemas
- Encryption keys, IV derivation, or packet authentication
- Anti-cheat/integrity verification
- Dynamic game-server discovery and matchmaking
- Chat, voice, friends, inventory, store, and battle services
- Valid hot-update file manifests/assets
- A retail-client-compatible redirect or patch strategy

## Reproducibility and safety

The static analysis can be reproduced from a lawfully obtained APK using the
commands above. Keep the APK and all extracted/decompiled material out of public
repositories. The included `.gitignore` excludes common APK, OBB, DEX, smali,
JADX, and APKTool outputs.

Do not use this analysis to bypass access controls, steal accounts, cheat in
live matches, or distribute proprietary game content. The mock backend is meant
for local experimentation with the recoverable HTTP/session concepts, not for
operating a live game service.

## Version caveat

These observations apply to the analyzed `1.38.2` APK. Garena can change
endpoints, field names, OAuth requirements, and server behavior at any time.
The mock backend deliberately does not depend on live Garena services and may
diverge from current/canonical behavior.
