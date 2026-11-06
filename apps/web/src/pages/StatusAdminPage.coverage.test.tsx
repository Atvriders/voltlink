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

import StatusAdminPage from './StatusAdminPage';
import { fireEvent } from '@testing-library/react';

const statusHistory = [
  {
    componentKey: 'api',
    checkedAt: new Date().toISOString(),
    status: 'operational',
    latencyMs: 120,
  },
  {
    componentKey: 'web',
    checkedAt: new Date().toISOString(),
    status: 'operational',
    latencyMs: 80,
  },
];

const incidentFixture = {
  id: 'i1',
  title: 'Database latency',
  severity: 'major',
  status: 'investigating',
  public: true,
  updates: [
    {
      id: 'u1',
      phase: 'investigating',
      message: 'Looking into elevated latency',
      createdAt: new Date().toISOString(),
    },
  ],
};

const statusBundle = {
  overall: 'degraded',
  uptime30dPct: 99.95,
  components: [
    { key: 'api', name: 'API', group: 'Core', status: 'degraded', manualOverride: false },
    { key: 'web', name: 'Web', group: 'Edge', status: 'operational', manualOverride: true },
  ],
  maintenance: [
    {
      id: 'm1',
      title: 'Postgres upgrade',
      startsAt: new Date().toISOString(),
      endsAt: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
      components: ['postgres'],
    },
  ],
  incidents: [incidentFixture],
  updatedAt: new Date().toISOString(),
};

describe('StatusAdminPage', () => {
  beforeEach(() => {
    apiMock.mockClear();
    apiMock.mockImplementation(async (path: string, init?: { method?: string }) => {
      if (path === '/api/v1/status') return statusBundle;
      if (path === '/api/v1/status/checks/history?hours=24') return statusHistory;
      if (path === '/api/v1/status/checks/run') return { ok: true };
      if (path === '/api/v1/status/incidents') {
        if (init?.method === 'POST') return incidentFixture;
        return [incidentFixture];
      }
      if (path === `/api/v1/status/incidents/${incidentFixture.id}`) {
        return { ...incidentFixture, public: false };
      }
      if (path === `/api/v1/status/incidents/${incidentFixture.id}/updates`) return { ok: true };
      if (path.startsWith('/api/v1/status/components/')) return { ok: true };
      if (path === '/api/v1/status/maintenance') return { ok: true };
      return {};
    });
  });

  it('renders status components, incidents, maintenance windows, and latency history', async () => {
    renderPage('/status-admin', <StatusAdminPage />);

    expect(await screen.findByText('Components')).toBeTruthy();
    expect(await screen.findByText('API')).toBeTruthy();
    expect(await screen.findByText('Database latency')).toBeTruthy();
    expect(await screen.findByText('Postgres upgrade')).toBeTruthy();
    expect(await screen.findByRole('img', { name: /response time chart/i })).toBeTruthy();
  });

  it('renders empty states when there are no incidents, maintenance windows, or latency data', async () => {
    apiMock.mockImplementation(async (path: string) => {
      if (path === '/api/v1/status') return { ...statusBundle, components: [], maintenance: [] };
      if (path === '/api/v1/status/checks/history?hours=24') return [];
      if (path === '/api/v1/status/incidents') return [];
      return {};
    });

    renderPage('/status-admin', <StatusAdminPage />);

    expect(await screen.findByText('No incidents recorded.')).toBeTruthy();
    expect(await screen.findByText('No scheduled maintenance.')).toBeTruthy();
    expect(await screen.findByText('No latency data.')).toBeTruthy();
  });

  it('opens the create incident modal from the incidents card', async () => {
    renderPage('/status-admin', <StatusAdminPage />);

    fireEvent.click(await screen.findByRole('button', { name: /new incident/i }));

    expect(await screen.findByText('Severity')).toBeTruthy();
    expect(screen.getByText('Affected component keys (comma-separated)')).toBeTruthy();
  });

  it('posts a check run when the run checks button is clicked', async () => {
    renderPage('/status-admin', <StatusAdminPage />);

    fireEvent.click(await screen.findByRole('button', { name: /run checks/i }));

    await waitFor(() => {
      expect(apiMock).toHaveBeenCalledWith('/api/v1/status/checks/run', { method: 'POST' });
    });
  });
});
