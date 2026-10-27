export const PROTOCOL_VERSION = 1;

export const SERVER_EVENT = Object.freeze({
  cmdType: 0,
  name: 'SERVER_EVENT',
  slug: 'server.event',
  authRequired: false,
  description: 'Unsolicited server event such as the welcome message.',
});

export const COMMANDS = Object.freeze(
  [
    {
      cmdType: 1,
      name: 'HANDSHAKE',
      slug: 'handshake',
      authRequired: false,
      description: 'Create a short-lived handshake before login.',
    },
    {
      cmdType: 2,
      name: 'LOGIN',
      slug: 'login',
      authRequired: false,
      description: 'Authenticate with an access token or guest uid/password.',
    },
    {
      cmdType: 3,
      name: 'LOBBY_GET',
      slug: 'lobby.get',
      authRequired: true,
      description: 'Fetch the current lobby snapshot.',
    },
    {
      cmdType: 4,
      name: 'ROOM_CREATE',
      slug: 'lobby.room.create',
      authRequired: true,
      description: 'Create a custom lobby room.',
    },
    {
      cmdType: 5,
      name: 'ROOM_JOIN',
      slug: 'lobby.room.join',
      authRequired: true,
      description: 'Join a lobby room by id.',
    },
    {
      cmdType: 6,
      name: 'ROOM_LEAVE',
      slug: 'lobby.room.leave',
      authRequired: true,
      description: 'Leave the current lobby room.',
    },
    {
      cmdType: 7,
      name: 'PING',
      slug: 'ping',
      authRequired: false,
      description: 'Application-level ping/pong and clock synchronization.',
    },
    {
      cmdType: 8,
      name: 'LOGOUT',
      slug: 'logout',
      authRequired: true,
      description: 'Revoke the current session.',
    },
  ].map((command) => Object.freeze(command)),
);

const COMMAND_BY_TYPE = new Map(COMMANDS.map((command) => [command.cmdType, command]));
const COMMAND_BY_KEY = new Map();

function normalizeKey(value) {
  return String(value)
    .trim()
    .toLowerCase()
    .replace(/[\s.-]+/g, '_')
    .replace(/^_+|_+$/g, '');
}

for (const command of COMMANDS) {
  COMMAND_BY_KEY.set(normalizeKey(command.name), command);
  COMMAND_BY_KEY.set(normalizeKey(command.slug), command);
}

const COMMAND_ALIASES = {
  get_lobby: 'LOBBY_GET',
  lobby: 'LOBBY_GET',
  lobby_data: 'LOBBY_GET',
  create_room: 'ROOM_CREATE',
  room_create: 'ROOM_CREATE',
  lobby_room_create: 'ROOM_CREATE',
  join_room: 'ROOM_JOIN',
  room_join: 'ROOM_JOIN',
  lobby_room_join: 'ROOM_JOIN',
  leave_room: 'ROOM_LEAVE',
  room_leave: 'ROOM_LEAVE',
  lobby_room_leave: 'ROOM_LEAVE',
  bye: 'LOGOUT',
  sign_out: 'LOGOUT',
  heartbeat: 'PING',
  hello: 'HANDSHAKE',
  auth: 'LOGIN',
};

for (const [alias, name] of Object.entries(COMMAND_ALIASES)) {
  COMMAND_BY_KEY.set(normalizeKey(alias), COMMAND_BY_KEY.get(normalizeKey(name)));
}

export function resolveCommand(value) {
  if (typeof value === 'number' && Number.isInteger(value)) {
    return COMMAND_BY_TYPE.get(value) ?? null;
  }
  if (typeof value === 'string') {
    const trimmed = value.trim();
    if (/^\d+$/.test(trimmed)) return COMMAND_BY_TYPE.get(Number(trimmed)) ?? null;
    return COMMAND_BY_KEY.get(normalizeKey(trimmed)) ?? null;
  }
  return null;
}

export function getCommandByType(type) {
  return COMMAND_BY_TYPE.get(Number(type)) ?? null;
}

export function publicProtocolDescription() {
  return {
    protocol: 'freefire-mock-json',
    version: PROTOCOL_VERSION,
    transport: 'WebSocket JSON at /ws',
    note:
      'This is a clean JSON envelope inspired by the cmdType/subCmdType/regionID fields found in the APK. It is not the proprietary encrypted protobuf protocol used by the retail game.',
    requestEnvelope: {
      cmdType: 'integer command id or command string',
      subCmdType: 'integer, defaults to 0',
      regionID: 'string region code',
      requestId: 'string correlation id',
      seq: 'integer sequence number',
      data: 'command-specific object',
    },
    responseEnvelope: {
      ok: 'boolean',
      cmdType: 'echoed command id',
      subCmdType: 'echoed sub-command id',
      command: 'canonical command name',
      regionID: 'string or null',
      requestId: 'echoed correlation id',
      seq: 'echoed sequence number',
      serverTime: 'Unix epoch milliseconds',
      data: 'result on success',
      error: '{ code, message } on failure',
    },
    commands: COMMANDS.map((command) => ({
      cmdType: command.cmdType,
      name: command.name,
      description: command.description,
      auth_required: command.authRequired,
    })),
  };
}

export function protocolResponse(command, options = {}) {
  const {
    requestId = null,
    seq = 0,
    subCmdType = 0,
    regionID = null,
    data = null,
    error = null,
  } = options;

  const response = {
    ok: !error,
    cmdType: command?.cmdType ?? 0,
    subCmdType: Number.isInteger(subCmdType) ? subCmdType : 0,
    command: command?.name ?? SERVER_EVENT.name,
    regionID: typeof regionID === 'string' ? regionID : null,
    requestId: typeof requestId === 'string' ? requestId : requestId ?? null,
    seq: Number.isInteger(seq) ? seq : 0,
    serverTime: Date.now(),
  };

  if (error) response.error = error;
  else response.data = data;
  return response;
}

export function protocolError(command, options, error) {
  const errorBody =
    error && typeof error === 'object' && 'code' in error
      ? { code: error.code, message: error.message }
      : { code: 'INTERNAL_ERROR', message: 'An unexpected server error occurred.' };
  return protocolResponse(command, { ...options, error: errorBody });
}
