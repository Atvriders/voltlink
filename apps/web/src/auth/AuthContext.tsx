// Auth context: loads the current user from the session cookie and exposes
// login/logout. Also drives the theme attribute.

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from 'react';
import { useNavigate } from 'react-router-dom';
import { useQueryClient } from '@tanstack/react-query';
import { api, resetCsrf } from '../api/client';
import { realtimeStop } from '../lib/realtime';
import type { UserPublic } from '@voltlink/shared';
import { normalizeThemeId, type ThemeId } from './themes';

export { THEMES, normalizeThemeId } from './themes';

interface AuthState {
  user: UserPublic | null;
  loading: boolean;
  login: (email: string, password: string, totp?: string) => Promise<{ totpRequired?: boolean }>;
  logout: () => Promise<void>;
  refresh: () => Promise<void>;
}

const AuthContext = createContext<AuthState | null>(null);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<UserPublic | null>(null);
  const [loading, setLoading] = useState(true);
  const qc = useQueryClient();
  const navigate = useNavigate();

  // F-SIGNOUT: stop SSE first, then clear the entire query + mutation cache so
  // the next user in this tab can never see the previous user's data.
  const resetClientState = useCallback(() => {
    realtimeStop();
    void qc.cancelQueries();
    qc.clear();
    resetCsrf();
  }, [qc]);

  const refresh = useCallback(async () => {
    try {
      const me = await api<UserPublic>('/api/v1/auth/me');
      setUser(me);
      applyTheme(me);
    } catch {
      setUser(null);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void refresh();
    const onUnauthorized = () => {
      resetClientState();
      setUser(null);
    };
    window.addEventListener('voltlink:unauthorized', onUnauthorized);
    return () => window.removeEventListener('voltlink:unauthorized', onUnauthorized);
  }, [refresh, resetClientState]);

  const login = useCallback(
    async (email: string, password: string, totp?: string) => {
      const res = await api<{ user?: UserPublic; totpRequired?: boolean }>('/api/v1/auth/login', {
        method: 'POST',
        body: { email, password, totp },
      });
      if (res.totpRequired) return { totpRequired: true };
      if (res.user) {
        resetClientState();
        setUser(res.user);
        applyTheme(res.user);
      }
      return {};
    },
    [resetClientState],
  );

  const logout = useCallback(async () => {
    try {
      const { unsubscribePush } = await import('../lib/push');
      await unsubscribePush();
    } catch {
      /* best-effort */
    }
    try {
      await api('/api/v1/auth/logout', { method: 'POST' });
    } catch {
      /* the session may already be gone */
    }
    resetClientState();
    setUser(null);
    navigate('/login', { replace: true });
  }, [resetClientState, navigate]);

  const value = useMemo(
    () => ({ user, loading, login, logout, refresh }),
    [user, loading, login, logout, refresh],
  );
  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthState {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error('useAuth outside AuthProvider');
  return ctx;
}

let mediaListenerAttached = false;

function systemDark(): boolean {
  return window.matchMedia('(prefers-color-scheme: dark)').matches;
}

/** Resolve the stored id (which may be 'system') to a rendered theme id. */
export function resolveTheme(stored: string | null | undefined): ThemeId {
  if (stored === 'system') return systemDark() ? 'voltlink-dark' : 'voltlink-light';
  return normalizeThemeId(stored);
}

export function applyTheme(user?: UserPublic | null): void {
  const saved = localStorage.getItem('voltlink-theme');
  const theme = resolveTheme(saved || (user ? user.theme : null));
  document.documentElement.setAttribute('data-theme', theme);
  // F-UIMISC: System follows the OS setting while the page is open.
  if (!mediaListenerAttached) {
    mediaListenerAttached = true;
    window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => {
      if (localStorage.getItem('voltlink-theme') === 'system') applyTheme();
    });
  }
}

export function setTheme(theme: string): void {
  localStorage.setItem('voltlink-theme', theme);
  const resolved = resolveTheme(theme);
  document.documentElement.setAttribute('data-theme', resolved);
}
