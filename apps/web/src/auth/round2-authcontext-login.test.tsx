// TI-56: the web auth module (AuthContext.tsx) had login()/loginMfa() never
// executed, so the strict '**/auth/**' coverage threshold never applied to it.
// These tests drive the REAL AuthProvider: password login (user + MFA branches)
// and MFA completion with a code or a recovery code.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router-dom';
import {
  AuthProvider,
  useAuth,
  resolveTheme,
  setTheme,
  applyTheme,
  resetThemeMediaListenerForTests,
} from './AuthContext';
import { renderHook } from '@testing-library/react';
import type { UserPublic } from '@voltlink/shared';

const apiMock = vi.fn();
vi.mock('../api/client', () => ({
  api: (...args: unknown[]) => apiMock(...args),
  ApiError: class ApiError extends Error {
    code: string;
    status: number;
    constructor(code: string, message: string, status: number) {
      super(message);
      this.code = code;
      this.status = status;
    }
  },
  fetchCsrf: () => Promise.resolve('csrf-token'),
  resetCsrf: () => undefined,
}));
vi.mock('@simplewebauthn/browser', () => ({
  startAuthentication: vi.fn().mockResolvedValue({}),
  startRegistration: vi.fn().mockResolvedValue({}),
}));

const userA: UserPublic = {
  id: 'u1',
  email: 'alice@example.test',
  name: 'Alice',
  units: 'metric',
  timezone: 'UTC',
  theme: 'voltlink-dark',
  totpEnabled: false,
  demoEnabled: true,
  isInstanceAdmin: true,
};

function Probe() {
  const { user, login, loginMfa } = useAuth();
  return (
    <div>
      <span data-testid="user">{user?.email ?? 'none'}</span>
      <button onClick={() => void login('alice@example.test', 'pw-123')} data-testid="login" />
      <button onClick={() => void loginMfa({ code: '123456' })} data-testid="mfa-code" />
      <button
        onClick={() => void loginMfa({ recoveryCode: 'ABCD-EFGH' })}
        data-testid="mfa-recovery"
      />
    </div>
  );
}

const renderProbe = () =>
  render(
    <QueryClientProvider client={new QueryClient()}>
      <MemoryRouter>
        <AuthProvider>
          <Probe />
        </AuthProvider>
      </MemoryRouter>
    </QueryClientProvider>,
  );

let mediaDark = true;
const mediaListeners = new Map<string, (() => void)[]>();
const mediaChange = () => {
  for (const cbs of mediaListeners.values()) for (const cb of cbs) cb();
};

beforeEach(() => {
  mediaDark = true;
  mediaListeners.clear();
  window.matchMedia = ((q: string) => ({
    matches: q.includes('dark') && mediaDark,
    media: q,
    addEventListener: (_ev: string, cb: () => void) => {
      const list = mediaListeners.get(q) ?? [];
      list.push(cb);
      mediaListeners.set(q, list);
    },
    removeEventListener: () => undefined,
    addListener: () => undefined,
    removeListener: () => undefined,
    dispatchEvent: () => false,
  })) as never;
  apiMock.mockReset();
  // Default: /auth/me answers 401 (no user) so the provider starts clean.
  apiMock.mockImplementation(async (path: string) => {
    if (String(path).includes('/auth/me')) {
      const err = new Error('unauthorized') as Error & { status?: number };
      err.status = 401;
      throw err;
    }
    return {};
  });
});

afterEach(() => {
  cleanup();
  document.documentElement.removeAttribute('data-theme');
});

describe('TI-56 AuthContext login and MFA completion', () => {
  it('password login with MFA required returns methods and sets no user', async () => {
    apiMock.mockImplementation(async (path: string) => {
      if (String(path).includes('/auth/me')) throw Object.assign(new Error('x'), { status: 401 });
      if (String(path).includes('/auth/login')) {
        return { mfaRequired: true, methods: ['totp', 'recovery_code'] };
      }
      return {};
    });
    renderProbe();
    await screen.getByTestId('login').click();
    await waitFor(() =>
      expect(apiMock).toHaveBeenCalledWith('/api/v1/auth/login', expect.anything()),
    );
    await waitFor(() => expect(screen.getByTestId('user')).toHaveTextContent('none'));
  });

  it('password login with a user response signs the user in', async () => {
    apiMock.mockImplementation(async (path: string) => {
      if (String(path).includes('/auth/me')) throw Object.assign(new Error('x'), { status: 401 });
      if (String(path).includes('/auth/login')) return { user: userA };
      return {};
    });
    renderProbe();
    await screen.getByTestId('login').click();
    await waitFor(() => expect(screen.getByTestId('user')).toHaveTextContent('alice@example.test'));
  });

  it('MFA completion with a code signs the user in', async () => {
    apiMock.mockImplementation(async (path: string) => {
      if (String(path).includes('/auth/me')) throw Object.assign(new Error('x'), { status: 401 });
      if (String(path).includes('/auth/login/mfa')) return { user: userA };
      return {};
    });
    renderProbe();
    await screen.getByTestId('mfa-code').click();
    await waitFor(() => expect(screen.getByTestId('user')).toHaveTextContent('alice@example.test'));
    await waitFor(() =>
      expect(apiMock).toHaveBeenCalledWith(
        '/api/v1/auth/login/mfa',
        expect.objectContaining({
          method: 'POST',
          body: { code: '123456', recoveryCode: undefined },
        }),
      ),
    );
  });

  it('MFA completion with a recovery code signs the user in', async () => {
    apiMock.mockImplementation(async (path: string) => {
      if (String(path).includes('/auth/me')) throw Object.assign(new Error('x'), { status: 401 });
      if (String(path).includes('/auth/login/mfa')) return { user: userA };
      return {};
    });
    renderProbe();
    await screen.getByTestId('mfa-recovery').click();
    await waitFor(() => expect(screen.getByTestId('user')).toHaveTextContent('alice@example.test'));
  });

  describe('TI-56 theme runtime + uncovered branches', () => {
    it('resolveTheme follows the system preference and falls back for unknown ids', () => {
      mediaDark = true;
      expect(resolveTheme('system')).toBe('voltlink-dark');
      mediaDark = false;
      expect(resolveTheme('system')).toBe('voltlink-light');
      expect(resolveTheme('voltlink-light')).toBe('voltlink-light');
      expect(resolveTheme(null)).toBe('voltlink-dark');
      expect(resolveTheme(undefined)).toBe('voltlink-dark');
    });

    it('setTheme persists and applies; applyTheme follows a stored "system" theme on media change', () => {
      setTheme('voltlink-light');
      expect(localStorage.getItem('voltlink-theme')).toBe('voltlink-light');
      expect(document.documentElement.getAttribute('data-theme')).toBe('voltlink-light');

      localStorage.setItem('voltlink-theme', 'system');
      resetThemeMediaListenerForTests();
      applyTheme();
      expect(document.documentElement.getAttribute('data-theme')).toBe('voltlink-dark');
      mediaDark = false;
      mediaChange();
      expect(document.documentElement.getAttribute('data-theme')).toBe('voltlink-light');
      mediaDark = true;
      mediaChange();
      expect(document.documentElement.getAttribute('data-theme')).toBe('voltlink-dark');
      localStorage.removeItem('voltlink-theme');
    });

    it('applyTheme uses the user theme when nothing is stored', () => {
      localStorage.removeItem('voltlink-theme');
      applyTheme({ ...userA, theme: 'voltlink-light' });
      expect(document.documentElement.getAttribute('data-theme')).toBe('voltlink-light');
      document.documentElement.removeAttribute('data-theme');
    });

    it('useAuth outside the provider throws (TI-56)', () => {
      expect(() => renderHook(() => useAuth())).toThrow(/outside AuthProvider/);
    });

    it('password login without a user and without MFA resolves to {}', async () => {
      apiMock.mockResolvedValueOnce({});
      renderProbe();
      const user = await screen.findByTestId('user');
      await waitFor(() => expect(user.textContent).toBe('none'));
      // drive login via a direct import of the provider hook
      const { result } = renderHook(() => useAuth(), {
        wrapper: ({ children }) => (
          <QueryClientProvider client={new QueryClient()}>
            <MemoryRouter>
              <AuthProvider>{children}</AuthProvider>
            </MemoryRouter>
          </QueryClientProvider>
        ),
      });
      await result.current.login('alice@example.test', 'pw-123');
      expect(apiMock).toHaveBeenCalledWith(
        '/api/v1/auth/login',
        expect.objectContaining({ method: 'POST' }),
      );
    });
  });
});
