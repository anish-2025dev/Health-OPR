import { ApiError } from '@/lib/api-client';

/** API client for the platform console. Separate token and refresh cookie from hospital logins. */
const BASE = import.meta.env.VITE_API_BASE_URL ?? '/api/v1';
const CSRF = { 'X-Requested-With': 'healthos-web' };
let accessToken = null;
let refreshing = null;
let onLost = () => {};

export const setPlatformAuthLost = (fn) => {
  onLost = fn;
};
export const setPlatformToken = (t) => {
  accessToken = t;
};

export function refreshPlatformSession() {
  refreshing ??= fetch(`${BASE}/platform/auth/refresh`, {
    method: 'POST',
    credentials: 'include',
    headers: { Accept: 'application/json', ...CSRF },
  })
    .then(async (res) => {
      if (!res.ok) return false;
      accessToken = (await res.json()).accessToken;
      return true;
    })
    .catch(() => false)
    .finally(() => {
      refreshing = null;
    });
  return refreshing;
}

export async function platformFetch(
  path,
  { method = 'GET', body, auth = true, retry = true } = {},
) {
  const res = await fetch(`${BASE}/platform${path}`, {
    method,
    credentials: 'include',
    headers: {
      Accept: 'application/json',
      ...CSRF,
      ...(body ? { 'Content-Type': 'application/json' } : {}),
      ...(auth && accessToken ? { Authorization: `Bearer ${accessToken}` } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (res.status === 401 && auth && retry) {
    if (await refreshPlatformSession())
      return platformFetch(path, { method, body, auth, retry: false });
    onLost();
  }
  if (res.status === 204) return null;
  const data = await res.json().catch(() => null);
  if (!res.ok) {
    const e = data?.error ?? {};
    throw new ApiError(
      res.status,
      e.code ?? 'HTTP_ERROR',
      e.message ?? res.statusText,
      e.requestId,
      e.details,
    );
  }
  return data;
}
