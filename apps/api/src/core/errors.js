/**
 * Application error with a machine-readable code. Every API error response uses the envelope:
 *   { "error": { "code": "SOME_CODE", "message": "Human readable", "product": "...", "correlationId": "...", "requestId": "...", "details"?: ... } }
 */
export class AppError extends Error {
  constructor(status, code, message, detailsOrOptions) {
    super(message);
    this.name = 'AppError';
    this.status = status;
    this.code = code;

    if (
      detailsOrOptions &&
      typeof detailsOrOptions === 'object' &&
      !Array.isArray(detailsOrOptions) &&
      ('product' in detailsOrOptions || 'details' in detailsOrOptions)
    ) {
      this.product = detailsOrOptions.product ?? null;
      this.details = detailsOrOptions.details !== undefined ? detailsOrOptions.details : null;
    } else {
      this.product = null;
      this.details = detailsOrOptions;
    }
  }
}

export const notFound = (message = 'Resource not found', options) => {
  const err = new AppError(404, 'NOT_FOUND', message, options);
  if (options?.product) err.product = options.product;
  return err;
};

export const forbidden = (message = 'You do not have permission to do this', options) => {
  const err = new AppError(403, 'FORBIDDEN', message, options);
  if (options?.product) err.product = options.product;
  return err;
};

export const unauthorized = (message = 'Authentication required', options) => {
  const err = new AppError(401, 'UNAUTHENTICATED', message, options);
  if (options?.product) err.product = options.product;
  return err;
};

export const conflict = (code, message, options) => {
  const err = new AppError(409, code, message, options);
  if (options?.product) err.product = options.product;
  return err;
};

export const badRequest = (code, message, options) => {
  const err = new AppError(400, code, message, options);
  if (options?.product) err.product = options.product;
  return err;
};

export const mgtError = (status, code, message, details) => {
  const err = new AppError(status, code, message, details);
  err.product = 'suntek-mgt';
  return err;
};

export const opsError = (status, code, message, details) => {
  const err = new AppError(status, code, message, details);
  err.product = 'suntek-ops';
  return err;
};

export const platformError = (status, code, message, details) => {
  const err = new AppError(status, code, message, details);
  err.product = 'platform';
  return err;
};
