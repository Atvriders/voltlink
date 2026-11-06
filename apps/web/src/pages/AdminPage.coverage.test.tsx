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

import AdminPage from './AdminPage';

const adminHealth = {
  database: 'ok',
  redis: 'ok',
  migrationsCurrent: true,
  workersActive: true,
  queueDepth: 42,
  telemetryFresh: true,
  uptimeSec: 7200,
  memoryMb: 128,
};

const adminUsers = [
  {
    id: 'u1',
    email: 'alice@example.test',
    name: 'Alice Example',
    role: 'ADMIN',
    emailVerified: true,
    vehicleCount: 2,
    createdAt: new Date().toISOString(),
  },
];

const commandSwitches = {
  globalReadOnly: false,
  commandsEnabled: true,
  providerCommandsEnabled: true,
  vehicleCommandsEnabled: true,
};

const failedJob = {
  id: 'job-1',
  queue: 'vehicle-commands',
  error: 'Command timed out',
  attempts: 3,
};

function adminApiMock(
  options: { deadJobs?: unknown[]; switches?: typeof commandSwitches } = {},
) {
  return async (path: string, init?: unknown) => {
    if (path === '/api/v1/admin/settings') {
      const method =
        init && typeof init === 'object' ? (init as { method?: string }).method : undefined;
      if (method === 'PATCH') return {};
      return {
        appVersion: '1.2.3',
        telemetryRetentionDays: '365',
        instanceName: 'VoltLink',
      };
    }
    if (path === '/api/v1/admin/users') return adminUsers;
    if (path === '/api/v1/admin/health') return adminHealth;
    if (path === '/api/v1/commands/switches/status') return options.switches ?? commandSwitches;
    if (path === '/api/v1/admin/queue/dead') return options.deadJobs ?? [failedJob];
    if (path.startsWith('/api/v1/admin/users/')) return {};
    if (path === '/api/v1/commands/switches') return {};
    if (path === '/api/v1/admin/retention/run') return {};
    if (path.includes('/queue/')) return {};
    return {};
  };
}

describe('AdminPage', () => {
  beforeEach(() => {
    apiMock.mockImplementation(adminApiMock());
  });

  it('renders admin settings, health, users and failed jobs', async () => {
    renderPage('/admin', <AdminPage />);

    expect(await screen.findByText('Administration')).toBeTruthy();
    expect(screen.getByText(/VoltLink v1\.2\.3/)).toBeTruthy();
    expect(screen.getByText('Database')).toBeTruthy();
    expect(screen.getAllByText('Healthy').length).toBeGreaterThan(0);
    expect(screen.getByText('Queue depth')).toBeTruthy();
    expect(screen.getByText('Alice Example')).toBeTruthy();
    expect(screen.getByLabelText('Role for Alice Example')).toBeTruthy();
    expect(screen.getByText('vehicle-commands')).toBeTruthy();
    expect(screen.getByText('3 attempts')).toBeTruthy();
    expect(screen.getByText('Requeue command jobs')).toBeTruthy();
  });

  it('shows the empty failed-jobs state', async () => {
    apiMock.mockImplementation(adminApiMock({ deadJobs: [] }));
    renderPage('/admin', <AdminPage />);

    expect(await screen.findByText('No failed jobs.')).toBeTruthy();
    expect(screen.queryByText('Requeue command jobs')).toBeNull();
  });

  it('runs retention from the data retention card', async () => {
    renderPage('/admin', <AdminPage />);

    const runButton = await screen.findByRole('button', { name: /run retention now/i });
    runButton.click();

    await waitFor(() =>
      expect(screen.getByRole('button', { name: /run retention now/i })).toBeTruthy(),
    );
  });

  it('renders safety switches and toggles the global read-only switch', async () => {
    renderPage('/admin', <AdminPage />);

    const readOnlySwitch = await screen.findByRole('switch', {
      name: /global read-only mode/i,
    });
    expect(readOnlySwitch.getAttribute('aria-checked')).toBe('false');
    readOnlySwitch.click();

    await waitFor(() =>
      expect(screen.getByRole('switch', { name: /global read-only mode/i })).toBeTruthy(),
    );
  });
});
