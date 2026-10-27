const HOST_PATTERN = /^[a-z0-9.\-:[\]]{1,255}$/i;

function firstForwardedValue(value) {
  if (typeof value !== 'string') return null;
  return value.split(',')[0]?.trim() || null;
}

function getRequestProtocol(req, config) {
  if (config.publicUrl) return null;
  if (typeof req.protocol === 'string' && (req.protocol === 'http' || req.protocol === 'https')) {
    return req.protocol;
  }

  if (config.trustProxy) {
    const forwarded = firstForwardedValue(req.headers?.['x-forwarded-proto']);
    if (forwarded === 'http' || forwarded === 'https') return forwarded;
  }
  return req.socket?.encrypted ? 'https' : 'http';
}

/**
 * Return the externally visible HTTP origin for a request.
 * PUBLIC_URL always wins; otherwise derive from request headers.
 */
export function getBaseUrl(req, config) {
  if (config.publicUrl) return config.publicUrl;

  const protocol = getRequestProtocol(req, config);
  let host =
    (typeof req.get === 'function' ? req.get('host') : null) ??
    req.headers?.host ??
    null;

  if (config.trustProxy) {
    const forwardedHost =
      firstForwardedValue(req.headers?.['x-forwarded-host']) ??
      firstForwardedValue(req.headers?.['x-forwarded-server']);
    if (forwardedHost) host = forwardedHost;
  }

  if (typeof host !== 'string' || !HOST_PATTERN.test(host)) {
    host = `localhost:${config.port}`;
  }

  return `${protocol}://${host}`;
}

export function toWebSocketUrl(httpUrl, path) {
  const url = new URL(path, httpUrl);
  url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
  return url.toString();
}

export function getHostAndPort(httpUrl, fallbackPort) {
  try {
    const url = new URL(httpUrl);
    const port =
      Number(url.port) ||
      (url.protocol === 'https:' ? 443 : url.protocol === 'http:' ? 80 : fallbackPort);
    return { host: url.hostname, port };
  } catch {
    return { host: 'localhost', port: fallbackPort };
  }
}
