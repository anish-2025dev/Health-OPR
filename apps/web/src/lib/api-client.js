// Same-origin by default: Vite proxies /api in development and Render rewrites /api in production,
// so the HttpOnly refresh cookie is first-party.
const API_BASE_URL = import.meta.env.VITE_API_BASE_URL ?? '/api/v1';
const CSRF_HEADERS = { 'X-Requested-With': 'healthos-web' };

export class ApiError extends Error {
  constructor(status, code, message, requestId, details) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.code = code;
    this.requestId = requestId;
    this.details = details;
  }
}

// The access token lives only in memory (never localStorage). A page reload restores it via the
// HttpOnly refresh cookie.
let accessToken = null;
let onAuthLost = () => {};

export const tokenStore = {
  get: () => accessToken,
  set: (token) => {
    accessToken = token;
  },
  clear: () => {
    accessToken = null;
  },
};

export function setAuthLostHandler(fn) {
  onAuthLost = fn;
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

let refreshing = null;

/** Exchanges the refresh cookie for a new access token. Concurrent callers share one request. */
export function refreshAccessToken() {
  refreshing ??= (async () => {
    for (let attempt = 0; attempt < 2; attempt++) {
      const res = await fetch(`${API_BASE_URL}/auth/refresh`, {
        method: 'POST',
        credentials: 'include',
        headers: { Accept: 'application/json', ...CSRF_HEADERS },
      }).catch(() => null);
      if (res?.ok) {
        accessToken = (await res.json()).accessToken;
        return true;
      }
      const body = await res?.json().catch(() => null);
      if (body?.error?.code === 'REFRESH_RACE') {
        await sleep(300);
        continue;
      }
      break;
    }
    accessToken = null;
    return false;
  })().finally(() => {
    refreshing = null;
  });
  return refreshing;
}

/** Downloads a file (e.g. CSV export) with the access token and saves it in the browser. */
export async function apiDownload(path, filename, { retry = true } = {}) {
  const res = await fetch(`${API_BASE_URL}${path}`, {
    credentials: 'include',
    headers: {
      ...CSRF_HEADERS,
      ...(accessToken ? { Authorization: `Bearer ${accessToken}` } : {}),
    },
  });
  if (res.status === 401 && retry && (await refreshAccessToken())) {
    return apiDownload(path, filename, { retry: false });
  }
  if (!res.ok) {
    const err = (await res.json().catch(() => null))?.error ?? {};
    throw new ApiError(
      res.status,
      err.code ?? 'HTTP_ERROR',
      err.message ?? 'Download failed',
      err.requestId,
    );
  }
  const url = URL.createObjectURL(await res.blob());
  const a = Object.assign(document.createElement('a'), { href: url, download: filename });
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

/**
 * Fetch wrapper for the HealthOS API. Adds the access token, retries once after refreshing on 401,
 * and turns the backend error envelope { error: { code, message, requestId } } into an ApiError.
 */
export async function apiFetch(path, options = {}) {
  const { method = 'GET', body, signal, headers, auth = true, retry = true } = options;
  const res = await fetch(`${API_BASE_URL}${path}`, {
    method,
    signal,
    credentials: 'include',
    headers: {
      Accept: 'application/json',
      ...CSRF_HEADERS,
      ...(body ? { 'Content-Type': 'application/json' } : {}),
      ...(auth && accessToken ? { Authorization: `Bearer ${accessToken}` } : {}),
      ...headers,
    },
    body: body ? JSON.stringify(body) : undefined,
  });

  if (res.status === 401 && auth && retry) {
    if (await refreshAccessToken()) return apiFetch(path, { ...options, retry: false });
    onAuthLost();
  }

  if (res.status === 204) return null;
  const data = await res.json().catch(() => null);
  // Readiness returns 503 with a normal body when a dependency is down.
  if (!res.ok && !(res.status === 503 && data?.status)) {
    const err = data?.error ?? {};
    throw new ApiError(
      res.status,
      err.code ?? 'HTTP_ERROR',
      err.message ?? res.statusText,
      err.requestId,
      err.details,
    );
  }
  return data;
}
