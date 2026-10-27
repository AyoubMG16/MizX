import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import { AppError, errorHandler, notFoundHandler } from './errors.js';
import { createRateLimiter, requestContext } from './middleware.js';
import { createApiRouter } from './routes/api.js';
import { createGarenaRouter } from './routes/garena.js';
import { createSystemRouter } from './routes/system.js';

function corsOptions(config) {
  const allowAll = config.corsOrigins.includes('*');
  return {
    origin(origin, callback) {
      if (!origin || allowAll || config.corsOrigins.includes(origin)) {
        callback(null, true);
        return;
      }
      callback(new AppError(403, 'CORS_ORIGIN_DENIED', 'This origin is not allowed.'));
    },
    methods: ['GET', 'POST', 'OPTIONS'],
    allowedHeaders: [
      'Content-Type',
      'Authorization',
      'X-Request-Id',
      'X-Client-Version',
    ],
    exposedHeaders: ['X-Request-Id', 'RateLimit-Limit', 'RateLimit-Remaining', 'Retry-After'],
    credentials: false,
    maxAge: 86400,
    optionsSuccessStatus: 204,
  };
}

export function createApp({ config, store, auth, lobby }) {
  const app = express();
  app.disable('x-powered-by');
  app.disable('etag');
  app.set('trust proxy', config.trustProxy);

  app.use(requestContext);
  app.use(
    helmet({
      crossOriginResourcePolicy: { policy: 'cross-origin' },
      contentSecurityPolicy: false,
    }),
  );
  app.use(cors(corsOptions(config)));

  const globalLimiter = createRateLimiter({
    windowMs: config.rateLimit.windowMs,
    max: config.rateLimit.max,
    scope: 'http',
  });
  const authLimiter = createRateLimiter({
    windowMs: config.rateLimit.authWindowMs,
    max: config.rateLimit.authMax,
    scope: 'auth',
  });

  app.use(['/api', '/oauth'], globalLimiter);
  app.use('/oauth', authLimiter);
  app.use('/api/login', authLimiter);
  app.use('/api/handshake', authLimiter);

  app.use(express.json({ limit: '64kb', type: ['application/json', 'application/*+json'] }));
  app.use(
    express.urlencoded({
      extended: false,
      limit: '32kb',
      parameterLimit: 100,
    }),
  );

  app.use((req, res, next) => {
    if (!res.hasHeader('Cache-Control')) res.setHeader('Cache-Control', 'no-store');
    next();
  });

  app.use((error, _req, _res, next) => {
    if (error?.type === 'entity.parse.failed') {
      next(new AppError(400, 'INVALID_JSON', 'Malformed JSON request body.'));
      return;
    }
    if (error?.type === 'entity.too.large') {
      next(new AppError(413, 'PAYLOAD_TOO_LARGE', 'Request body is too large.'));
      return;
    }
    if (error?.type === 'parameters.too.many') {
      next(new AppError(413, 'TOO_MANY_PARAMETERS', 'Too many form parameters.'));
      return;
    }
    next(error);
  });

  app.use(createSystemRouter({ config, store }));
  app.use('/oauth', createGarenaRouter({ config, store, auth }));
  app.use('/api', createApiRouter({ config, store, auth, lobby }));

  app.use(notFoundHandler);
  app.use(errorHandler);

  return app;
}
