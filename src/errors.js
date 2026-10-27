/**
 * Application error carrying an HTTP status, a stable machine-readable code,
 * and optional non-sensitive details. Unknown errors are converted to 500s by
 * the central error handler and never leak stack traces to clients.
 */
export class AppError extends Error {
  constructor(statusCode, code, message, details = undefined) {
    super(message);
    this.name = 'AppError';
    this.statusCode = statusCode;
    this.code = code;
    this.details = details;
  }
}

export function asyncHandler(handler) {
  return function wrappedHandler(req, res, next) {
    Promise.resolve(handler(req, res, next)).catch(next);
  };
}

export function notFoundHandler(req, _res, next) {
  next(new AppError(404, 'NOT_FOUND', `Route not found: ${req.method} ${req.originalUrl}`));
}

export function errorHandler(error, req, res, next) {
  if (res.headersSent) {
    next(error);
    return;
  }

  const known = error instanceof AppError;
  const statusCode = known ? error.statusCode : 500;
  const code = known ? error.code : 'INTERNAL_ERROR';
  const message = known ? error.message : 'An unexpected server error occurred.';

  if (statusCode >= 500) {
    console.error(`[${req.id ?? 'no-request-id'}] ${req.method} ${req.originalUrl}`, error);
  }

  const body = {
    ok: false,
    requestId: req.id ?? null,
    serverTime: Date.now(),
    error: { code, message },
  };
  if (known && error.details !== undefined) {
    body.error.details = error.details;
  }

  res.status(statusCode).json(body);
}
