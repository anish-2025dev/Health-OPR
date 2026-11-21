import { randomUUID } from 'node:crypto';
import { AppError } from './errors.js';

const ID_PATTERN = /^[A-Za-z0-9._-]{1,64}$/;

export function requestId(req, res, next) {
  const incomingReqId = req.get('x-request-id');
  const incomingCorrId = req.get('x-correlation-id');

  req.id = incomingReqId && ID_PATTERN.test(incomingReqId) ? incomingReqId : randomUUID();
  req.correlationId = incomingCorrId && ID_PATTERN.test(incomingCorrId) ? incomingCorrId : req.id;

  res.set('x-request-id', req.id);
  res.set('x-correlation-id', req.correlationId);
  next();
}

export function notFoundHandler(req, res, next) {
  next(new AppError(404, 'ROUTE_NOT_FOUND', `No route for ${req.method} ${req.path}`));
}

export function resolveProductDomain(req, err) {
  if (err?.product) return err.product;
  const path = req.originalUrl || req.url || req.path || '';
  if (path.includes('/api/v1/mgt') || path.includes('/mgt/')) return 'suntek-mgt';
  if (path.includes('/api/v1/ops') || path.includes('/ops/')) return 'suntek-ops';
  if (path.includes('/api/v1/platform') || path.includes('/platform/')) return 'platform';
  return 'shared';
}

// eslint-disable-next-line no-unused-vars -- Express identifies error handlers by arity.
export function errorHandler(err, req, res, next) {
  const isAppError = err instanceof AppError;
  const isBadJson = err?.type === 'entity.parse.failed';
  const status = isAppError ? err.status : isBadJson ? 400 : 500;
  const code = isAppError ? err.code : isBadJson ? 'INVALID_JSON' : 'INTERNAL_ERROR';
  // Never leak internal error messages or stack traces to clients.
  const message = isAppError
    ? err.message
    : isBadJson
      ? 'Request body is not valid JSON'
      : 'An unexpected error occurred';

  const product = resolveProductDomain(req, err);

  if (status >= 500) {
    req.log?.error(
      { err, correlationId: req.correlationId, product, requestId: req.id },
      'unhandled error',
    );
  }

  const body = {
    error: {
      code,
      message,
      product,
      requestId: req.id,
      correlationId: req.correlationId || req.id,
    },
  };
  if (isAppError && err.details !== undefined && err.details !== null) {
    body.error.details = err.details;
  }
  res.status(status).json(body);
}
