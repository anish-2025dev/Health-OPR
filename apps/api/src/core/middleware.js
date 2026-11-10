import { randomUUID } from 'node:crypto';
import { AppError } from './errors.js';

const REQUEST_ID_PATTERN = /^[A-Za-z0-9._-]{1,64}$/;

export function requestId(req, res, next) {
  const incoming = req.get('x-request-id');
  req.id = incoming && REQUEST_ID_PATTERN.test(incoming) ? incoming : randomUUID();
  res.set('x-request-id', req.id);
  next();
}

export function notFoundHandler(req, res, next) {
  next(new AppError(404, 'ROUTE_NOT_FOUND', `No route for ${req.method} ${req.path}`));
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

  if (status >= 500) {
    req.log?.error({ err }, 'unhandled error');
  }

  const body = { error: { code, message, requestId: req.id } };
  if (isAppError && err.details !== undefined) body.error.details = err.details;
  res.status(status).json(body);
}
