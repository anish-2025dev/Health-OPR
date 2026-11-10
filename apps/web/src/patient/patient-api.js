import { ApiError } from '@/lib/api-client';

/**
 * API client for the patient website. The access token is kept in memory only; the refresh token is
 * an HttpOnly cookie, so a returning patient stays signed in without typing a code again.
 */
const BASE = import.meta.env.VITE_API_BASE_URL ?? '/api/v1';
const CSRF = { 'X-Requested-With': 'healthos-web' };
let accessToken = null;
let refreshing = null;
let onLost = () => {};

export const setPatientAuthLost = (fn) => {
  onLost = fn;
};
export const setPatientToken = (t) => {
  accessToken = t;
};

export function refreshPatientSession() {
  refreshing ??= fetch(`${BASE}/patient-auth/refresh`, {
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

export async function patientFetch(
  path,
  { method = 'GET', body, headers, auth = true, retry = true } = {},
) {
  const res = await fetch(`${BASE}${path}`, {
    method,
    credentials: 'include',
    headers: {
      Accept: 'application/json',
      ...CSRF,
      ...(body ? { 'Content-Type': 'application/json' } : {}),
      ...(auth && accessToken ? { Authorization: `Bearer ${accessToken}` } : {}),
      ...headers,
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (res.status === 401 && auth && retry) {
    if (await refreshPatientSession())
      return patientFetch(path, { method, body, headers, auth, retry: false });
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
