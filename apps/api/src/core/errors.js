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
