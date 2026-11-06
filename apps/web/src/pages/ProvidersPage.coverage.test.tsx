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

import { fireEvent } from '@testing-library/react';
import ProvidersPage from './ProvidersPage';

const providerAccounts = [
  {
    id: 'acct-demo',
    provider: 'demo',
    label: 'Volt Demo Account',
    demo: true,
    status: 'connected',
    vehicleCount: 5,
    lastSyncAt: new Date().toISOString(),
  },
  {
    id: 'acct-tessie',
    provider: 'tessie',
    label: 'Tessie Account',
    demo: false,
    status: 'error',
    vehicleCount: 0,
    lastError: 'Token expired',
  },
];

const providerReadiness = [
  {
    provider: 'tesla',
    ok: true,
    configured: true,
    checks: [
      { ok: true, detail: 'Client ID configured' },
      { ok: true, detail: 'Client secret configured' },
    ],
  },
  {
    provider: 'tessie',
    ok: false,
    configured: false,
    checks: [{ ok: false, detail: 'TESSIE_API_TOKEN is not set' }],
  },
];

describe('ProvidersPage', () => {
  beforeEach(() => {
    window.matchMedia =
      window.matchMedia ||
      ((q: string) =>
        ({
          matches: false,
          media: q,
          onchange: null,
          addListener: () => {},
          removeListener: () => {},
          addEventListener: () => {},
          removeEventListener: () => {},
          dispatchEvent: () => false,
        }) as unknown as typeof window.matchMedia);

    apiMock.mockImplementation(async (path: string) => {
      if (path === '/api/v1/providers') return providerAccounts;
      if (path === '/api/v1/providers/readiness') return providerReadiness;
      if (path === '/api/v1/providers/demo/connect') return { vehiclesImported: 5 };
      if (path === '/api/v1/providers/tessie/connect') return {};
      if (path === '/api/v1/providers/tesla/authorize')
        return { url: 'https://tesla.example/oauth' };
      if (path.startsWith('/api/v1/providers/') && path.endsWith('/import'))
        return { imported: 1 };
      if (path.startsWith('/api/v1/providers/') && path.endsWith('/disconnect'))
        return {};
      return {};
    });
  });

  it('renders provider cards, readiness diagnostics, and connected accounts', async () => {
    renderPage('/providers', <ProvidersPage />);

    expect(await screen.findByText('Demo fleet')).toBeTruthy();
    expect(await screen.findByText('Tesla (official API)')).toBeTruthy();
    expect(await screen.findByText('Provider-readiness diagnostics')).toBeTruthy();
    expect(await screen.findByText('Connected accounts')).toBeTruthy();
    expect(await screen.findByText('Volt Demo Account')).toBeTruthy();
    expect(await screen.findByText('5 demo vehicles')).toBeTruthy();
    expect(await screen.findByText('Client ID configured')).toBeTruthy();
    expect(await screen.findByText('Token expired')).toBeTruthy();
  });

  it('shows the empty account state and demo enable action when no providers are connected', async () => {
    apiMock.mockImplementation(async (path: string) => {
      if (path === '/api/v1/providers') return [];
      if (path === '/api/v1/providers/readiness') return [];
      return {};
    });

    renderPage('/providers', <ProvidersPage />);

    expect(await screen.findByText('No provider accounts')).toBeTruthy();
    expect(await screen.findByText('Enable demo mode')).toBeTruthy();
  });

  it('opens the Tessie token connection modal', async () => {
    renderPage('/providers', <ProvidersPage />);

    const tessieButton = await screen.findByRole('button', {
      name: /Connect with Tessie token/i,
    });
    fireEvent.click(tessieButton);

    expect(await screen.findByText('Connect Tessie (optional)')).toBeTruthy();
    const connectButton = await screen.findByRole('button', { name: 'Connect' });
    expect((connectButton as HTMLButtonElement).disabled).toBe(true);
  });
});
