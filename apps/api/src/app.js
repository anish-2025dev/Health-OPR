import express from 'express';
import helmet from 'helmet';
import cors from 'cors';
import { pinoHttp } from 'pino-http';
import { apiV1Router } from './api/v1/index.js';
import { errorHandler, notFoundHandler, requestId } from './core/middleware.js';

/**
 * Builds the Express app. Dependencies are injected so tests can run without live services.
 * @param {{ config: object, logger: import('pino').Logger, checks: Record<string, () => Promise<unknown>> }} deps
 */
export function createApp({ config, logger, checks }) {
  const app = express();

  app.disable('x-powered-by');
  app.set('trust proxy', 1);

  app.use(requestId);
  app.use(
    pinoHttp({
      logger,
      genReqId: (req) => req.id,
      autoLogging: config.APP_ENV !== 'test',
      // Log the minimum needed for tracing. Headers, query strings and bodies may carry personal data.
      serializers: {
        req: (req) => ({ id: req.id, method: req.method, path: req.url?.split('?')[0] }),
        res: (res) => ({ statusCode: res.statusCode }),
      },
    }),
  );
  app.use(helmet());
  app.use(
    cors({
      origin: config.FRONTEND_URL,
      credentials: true,
    }),
  );
  app.use(express.json({ limit: '1mb' }));

  app.use('/api/v1', apiV1Router({ config, checks }));

  app.use(notFoundHandler);
  app.use(errorHandler);

  return app;
}
