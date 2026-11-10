const API_BASE_URL = import.meta.env.VITE_API_BASE_URL ?? 'http://localhost:4000/api/v1';

export class ApiError extends Error {
  constructor(status, code, message, requestId) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.code = code;
    this.requestId = requestId;
  }
}

/**
 * Thin fetch wrapper for the HealthOS API. It understands the backend error envelope
 * { error: { code, message, requestId } }. Authentication (cookies/tokens) is added in Phase 2.
 */
export async function apiFetch(path, { method = 'GET', body, signal, headers } = {}) {
  const res = await fetch(`${API_BASE_URL}${path}`, {
    method,
    signal,
    credentials: 'include',
    headers: {
      Accept: 'application/json',
      ...(body ? { 'Content-Type': 'application/json' } : {}),
      ...headers,
    },
    body: body ? JSON.stringify(body) : undefined,
  });

  const data = await res.json().catch(() => null);
  if (!res.ok && !(res.status === 503 && data?.status)) {
    const err = data?.error ?? {};
    throw new ApiError(
      res.status,
      err.code ?? 'HTTP_ERROR',
      err.message ?? res.statusText,
      err.requestId,
    );
  }
  return data;
}
