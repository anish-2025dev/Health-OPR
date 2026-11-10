/**
 * Application error with a machine-readable code. Every API error response uses the envelope:
 *   { "error": { "code": "SOME_CODE", "message": "Human readable", "details"?: ..., "requestId": "..." } }
 */
export class AppError extends Error {
  constructor(status, code, message, details) {
    super(message);
    this.name = 'AppError';
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

export const notFound = (message = 'Resource not found') => new AppError(404, 'NOT_FOUND', message);
export const forbidden = (message = 'You do not have permission to do this') =>
  new AppError(403, 'FORBIDDEN', message);
export const unauthorized = (message = 'Authentication required') =>
  new AppError(401, 'UNAUTHENTICATED', message);
export const conflict = (code, message) => new AppError(409, code, message);
