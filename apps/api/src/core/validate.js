import { AppError } from './errors.js';

/**
 * Parses `data` with a zod schema or throws a 400 VALIDATION_ERROR. Error details list field paths and
 * messages only, never the submitted values (which may contain passwords or personal data).
 */
export function validate(schema, data) {
  const result = schema.safeParse(data ?? {});
  if (result.success) return result.data;
  const details = result.error.issues.map((issue) => ({
    field: issue.path.join('.') || null,
    message: issue.message,
  }));
  throw new AppError(400, 'VALIDATION_ERROR', 'Request validation failed', details);
}
