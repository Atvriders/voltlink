// Page render test (coverage harness).
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { render, screen, waitFor, cleanup } from '@testing-library/react';

const apiMock = vi.fn();
const csvMock = vi.fn().mockResolvedValue('a,b');
vi.mock('../api/client', () => ({
  api: (...args: unknown[]) => apiMock(...args),
  apiCsv: (...args: unknown[]) => csvMock(...args),
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
  startAuthentication: vi.fn().mockResolvedValue({ id: 'cred-1', rawId: '', response: {} }),
  startRegistration: vi.fn().mockResolvedValue({ id: 'cred-1', rawId: '', response: {} }),
}));
const authState = {
  user: {
    id: 'u1',
    email: 'alice@example.test',
    name: 'Alice',
    units: 'metric',
    timezone: 'UTC',
    theme: 'voltlink-dark',
    totpEnabled: false,
    demoEnabled: true,
    isInstanceAdmin: true,
  },
  loading: false,
  login: vi.fn().mockResolvedValue({}),
  loginMfa: vi.fn().mockResolvedValue({ id: 'u1' }),
  logout: vi.fn().mockResolvedValue(undefined),
  refresh: vi.fn().mockResolvedValue(undefined),
};
vi.mock('../auth/AuthContext', () => ({ useAuth: () => authState }));

const vehicle = {
  id: 'v1',
  displayName: 'Aurora',
  exteriorColor: '#334155',
  providerVehicleId: 'demo-aurora',
  provider: 'demo',
  demo: true,
  capabilities: ['honk_horn', 'lock', 'wake'],
  state: {
    status: 'online',
    chargingState: 'charging',
    batteryPercent: 72,
    batteryRangeKm: 420,
    locked: true,
    odometerKm: 12345,
    interiorTempC: 21,
    outsideTempC: 12,
    speedKmh: 0,
    latitude: 47.6,
    longitude: -122.3,
    address: 'Seattle',
    freshness: 'recent',
    updatedAt: new Date().toISOString(),
  },
};

beforeEach(() => {
  apiMock.mockImplementation(async (path: string) => {
    if (path === '/api/v1/vehicles') return [vehicle];
    if (path === `/api/v1/vehicles/${vehicle.id}`) return vehicle;
    if (path.includes('/drives/totals'))
      return { count: 0, distanceKm: 0, energyKwh: 0, estCost: 0, costPerKm: 0 };
    if (path.startsWith('/api/v1/drives')) return { items: [], total: 0, page: 1, pageSize: 20 };
    if (path.startsWith('/api/v1/charging')) return { items: [], total: 0 };
    if (path === '/api/v1/charging/totals') return { count: 0, energyKwh: 0, cost: 0 };
    if (path === '/api/v1/charging/rates/list') return [];
    if (path === '/api/v1/providers') return [];
    if (path === '/api/v1/automations') return [];
    if (path === '/api/v1/status')
      return {
        overall: 'operational',
        components: [],
        incidents: [],
        maintenance: [],
        updatedAt: new Date().toISOString(),
      };
    if (path === '/api/v1/auth/setup-status')
      return { needsSetup: false, registrationMode: 'invite' };
    if (path === '/api/v1/fleet/overview') return { vehicles: [vehicle], groups: [] };
    if (path === '/api/v1/fleet/assignments') return { items: [] };
    if (path === '/api/v1/fleet/drivers') return [];
    if (path === '/api/v1/status/incidents') return [];
    if (path === '/api/v1/status/subscriptions') return [];
    if (path === '/api/v1/status/components') return [];
    if (path === '/api/v1/notifications/preferences') return [];
    if (path === '/api/v1/notifications/channels') return [];
    if (path === '/api/v1/notifications') return { items: [] };
    return {};
  });
});

function renderPage(path: string, ui: React.ReactNode) {
  const qc = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return render(
    <QueryClientProvider client={qc}>
      <MemoryRouter initialEntries={[path]}>
        <Routes>
          <Route path="*" element={ui as React.ReactElement} />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

afterEach(cleanup);

import * as AuthContextModule from './AuthContext';

vi.mock('../lib/realtime', () => ({ realtimeStop: vi.fn() }));
vi.mock('../lib/push', () => ({ unsubscribePush: vi.fn().mockResolvedValue(undefined) }));

describe('AuthContext', () => {
  let Auth = AuthContextModule;

  beforeEach(async () => {
    window.matchMedia = ((query: string) => ({
      matches: false,
      media: query,
      onchange: null,
      addListener: () => {},
      removeListener: () => {},
      addEventListener: () => {},
      removeEventListener: () => {},
      dispatchEvent: () => false,
    })) as unknown as typeof window.matchMedia;

    localStorage.clear();
    document.documentElement.removeAttribute('data-theme');
    apiMock.mockReset();
    apiMock.mockImplementation(async (path: string) => {
      if (path === '/api/v1/auth/me') return { user: authState.user };
      if (path === '/api/v1/auth/logout') return {};
      return {};
    });

    Auth = await vi.importActual<typeof AuthContextModule>('./AuthContext');
  });

  it('renders authenticated user content from the session endpoint', async () => {
    function Probe() {
      const { user, loading } = Auth.useAuth();
      return <div>{loading ? 'Loading' : user ? `Hello ${user.name}` : 'No user'}</div>;
    }

    renderPage(
      '/overview',
      <Auth.AuthProvider>
        <Probe />
      </Auth.AuthProvider>,
    );

    expect(await screen.findByText('Hello Alice')).toBeTruthy();
    expect(apiMock).toHaveBeenCalledWith('/api/v1/auth/me');
  });

  it('renders the signed-out state when the session request fails', async () => {
    apiMock.mockImplementation(async (path: string) => {
      if (path === '/api/v1/auth/me') throw new Error('unauthorized');
      return {};
    });

    function Probe() {
      const { user, loading } = Auth.useAuth();
      return <div>{loading ? 'Loading' : user ? `Hello ${user.name}` : 'No user'}</div>;
    }

    renderPage(
      '/overview',
      <Auth.AuthProvider>
        <Probe />
      </Auth.AuthProvider>,
    );

    expect(await screen.findByText('No user')).toBeTruthy();
    expect(apiMock).toHaveBeenCalledWith('/api/v1/auth/me');
  });

  it('signs out through the logout endpoint and clears the user', async () => {
    function Probe() {
      const { user, loading, logout } = Auth.useAuth();
      return (
        <div>
          <span>{loading ? 'Loading' : user ? `Hello ${user.name}` : 'No user'}</span>
          <button type="button" onClick={() => void logout()}>
            Sign out
          </button>
        </div>
      );
    }

    renderPage(
      '/overview',
      <Auth.AuthProvider>
        <Probe />
      </Auth.AuthProvider>,
    );

    const button = await screen.findByRole('button', { name: /sign out/i });
    button.click();

    await waitFor(() => {
      expect(apiMock).toHaveBeenCalledWith('/api/v1/auth/logout', { method: 'POST' });
    });
    expect(await screen.findByText('No user')).toBeTruthy();
  });
});
