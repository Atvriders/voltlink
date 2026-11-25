// R6: F-SIGNOUT — Sign out must clear the query cache, reset CSRF and land on
// /login; an unauthorized event must also clear per-user data.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter, useLocation } from 'react-router-dom';
import { render, screen, waitFor, cleanup, act } from '@testing-library/react';
import { AuthProvider, useAuth } from './AuthContext';

const apiMock = vi.fn();
vi.mock('../api/client', () => ({
  api: (...args: unknown[]) => apiMock(...args),
  apiCsv: vi.fn(),
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
  resetCsrf: vi.fn(),
}));
vi.mock('../lib/realtime', () => ({
  realtimeStart: vi.fn(),
  realtimeStop: vi.fn(),
}));
vi.mock('../lib/push', () => ({
  pushSupport: () => false,
  enable: vi.fn(),
  unsubscribePush: vi.fn().mockResolvedValue(undefined),
}));

let qc: QueryClient;

function Probe() {
  const { logout } = useAuth();
  return (
    <button data-testid="logout" onClick={() => void logout()}>
      logout
    </button>
  );
}

function LocationProbe() {
  const location = useLocation();
  return <span data-testid="path">{location.pathname}</span>;
}

beforeEach(() => {
  qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  qc.setQueryData(['user-preferences'], { theme: 'secret' });
  apiMock.mockImplementation(async (path: string) => {
    if (path === '/api/v1/auth/me') return { user: { id: 'u1', email: 'a@example.invalid' } };
    if (path === '/api/v1/auth/logout') return { ok: true };
    return {};
  });
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

function renderAuth() {
  return render(
    <QueryClientProvider client={qc}>
      <MemoryRouter initialEntries={['/overview']}>
        <AuthProvider>
          <Probe />
          <LocationProbe />
        </AuthProvider>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

describe('sign out (F-SIGNOUT)', () => {
  it('clears the query cache and lands on /login', async () => {
    renderAuth();
    await waitFor(() => expect(screen.getByTestId('logout')).toBeTruthy());
    await act(async () => {
      screen.getByTestId('logout').click();
    });
    await waitFor(() =>
      expect(apiMock).toHaveBeenCalledWith('/api/v1/auth/logout', expect.anything()),
    );
    await waitFor(() => expect(qc.getQueryData(['user-preferences'])).toBeUndefined());
    await waitFor(() => expect(screen.getByTestId('path').textContent).toBe('/login'));
  });

  it('clears the cache when the session is revoked elsewhere', async () => {
    renderAuth();
    await waitFor(() => expect(screen.getByTestId('logout')).toBeTruthy());
    act(() => {
      window.dispatchEvent(new Event('voltlink:unauthorized'));
    });
    await waitFor(() => expect(qc.getQueryData(['user-preferences'])).toBeUndefined());
  });
});
