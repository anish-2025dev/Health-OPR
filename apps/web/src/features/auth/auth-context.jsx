import { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { apiFetch, refreshAccessToken, setAuthLostHandler, tokenStore } from '@/lib/api-client';

const AuthContext = createContext(null);

const ANONYMOUS = { status: 'anonymous', me: null };

export function AuthProvider({ children }) {
  const queryClient = useQueryClient();
  const [state, setState] = useState({ status: 'loading', me: null });

  const loadMe = useCallback(async () => {
    const me = await apiFetch('/auth/me');
    setState({ status: 'authenticated', me });
    return me;
  }, []);

  const signOutLocally = useCallback(() => {
    tokenStore.clear();
    queryClient.clear();
    setState(ANONYMOUS);
  }, [queryClient]);

  useEffect(() => {
    setAuthLostHandler(signOutLocally);
    let cancelled = false;
    (async () => {
      const restored = await refreshAccessToken();
      if (cancelled) return;
      if (!restored) return setState(ANONYMOUS);
      try {
        await loadMe();
      } catch {
        if (!cancelled) setState(ANONYMOUS);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [loadMe, signOutLocally]);

  const value = useMemo(
    () => ({
      ...state,
      async login(email, password) {
        const result = await apiFetch('/auth/login', {
          method: 'POST',
          body: { email, password },
          auth: false,
        });
        tokenStore.set(result.accessToken);
        return loadMe();
      },
      /** Employee sign-in step 1: always resolves the same way (the API doesn't reveal registration). */
      async requestEmployeeOtp(company, mobile) {
        return apiFetch('/auth/employee/request-otp', {
          method: 'POST',
          body: { company, mobile },
          auth: false,
        });
      },
      async loginWithOtp(company, mobile, code) {
        const result = await apiFetch('/auth/employee/verify-otp', {
          method: 'POST',
          body: { company, mobile, code },
          auth: false,
        });
        tokenStore.set(result.accessToken);
        return loadMe();
      },
      async logout() {
        try {
          await apiFetch('/auth/logout', { method: 'POST', auth: false });
        } finally {
          signOutLocally();
        }
      },
      refreshMe: loadMe,
      can: (permission) => Boolean(state.me?.permissions.includes(permission)),
    }),
    [state, loadMe, signOutLocally],
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

// eslint-disable-next-line react-refresh/only-export-components -- hook lives beside its provider
export function useAuth() {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error('useAuth must be used inside <AuthProvider>');
  return ctx;
}
