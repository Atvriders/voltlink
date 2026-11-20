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

import userEvent from '@testing-library/user-event';
import { fireEvent } from '@testing-library/react';
import AdminPage from './AdminPage';

const settingsFixture = {
  appVersion: '1.2.3',
  telemetryRetentionDays: '30',
};

const usersFixture = [
  {
    id: 'u1',
    email: 'alice@example.test',
    name: 'Alice',
    role: 'ADMIN',
    emailVerified: true,
    vehicleCount: 2,
    createdAt: new Date().toISOString(),
  },
  {
    id: 'u2',
    email: 'bob@example.test',
    name: 'Bob',
    role: 'VIEWER',
    emailVerified: false,
    vehicleCount: 0,
    createdAt: new Date().toISOString(),
  },
];

let deadJobsFixture: Array<{
  id: string;
  queue: string;
  error: string;
  attempts: number;
}> = [];

describe('AdminPage', () => {
  beforeEach(() => {
    deadJobsFixture = [
      {
        id: 'job-1',
        queue: 'vehicle-commands',
        error: 'Command timed out',
        attempts: 3,
      },
    ];

    apiMock.mockImplementation(async (path: string, opts?: { method?: string; body?: unknown }) => {
      if (path === '/api/v1/admin/settings') {
        if (opts?.method === 'PATCH') return { ok: true };
        return settingsFixture;
      }
      if (path === '/api/v1/admin/users') return usersFixture;
      if (path.startsWith('/api/v1/admin/users/') && path.endsWith('/role')) {
        return { ok: true };
      }
      if (path === '/api/v1/admin/health') {
        return {
          database: 'ok',
          redis: 'ok',
          migrationsCurrent: true,
          workersActive: true,
          queueDepth: 3,
          telemetryFresh: true,
          uptimeSec: 7200,
          memoryMb: 256,
        };
      }
      if (path === '/api/v1/commands/switches/status') {
        return {
          globalReadOnly: false,
          commandsEnabled: true,
          providerCommandsEnabled: true,
          vehicleCommandsEnabled: true,
        };
      }
      if (path === '/api/v1/commands/switches' && opts?.method === 'POST') {
        return { ok: true };
      }
      if (path === '/api/v1/admin/queue/dead') return deadJobsFixture;
      if (path.startsWith('/api/v1/admin/queue/') && path.endsWith('/flush')) {
        return { ok: true };
      }
      if (path === '/api/v1/admin/retention/run') return { ok: true };
      return {};
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('renders platform health, command switches, users, retention, and failed jobs', async () => {
    renderPage('/admin', <AdminPage />);

    expect(await screen.findByText('Administration')).toBeInTheDocument();
    expect(await screen.findByText('Platform health')).toBeInTheDocument();
    expect(await screen.findByText('VoltLink v1.2.3')).toBeInTheDocument();
    expect(screen.getAllByText('Healthy').length).toBeGreaterThan(0);
    expect(screen.getByText('Command safety switches')).toBeInTheDocument();
    expect(screen.getByText('Emergency global command-disable')).toBeInTheDocument();
    expect(screen.getByText('Global read-only mode')).toBeInTheDocument();
    expect(await screen.findByText('2 accounts')).toBeInTheDocument();
    expect(await screen.findByText('Alice')).toBeInTheDocument();
    expect(await screen.findByText('Bob')).toBeInTheDocument();
    expect(screen.getByText('Data retention')).toBeInTheDocument();
    expect(screen.getByText('Failed background jobs')).toBeInTheDocument();
    expect(await screen.findByText('vehicle-commands')).toBeInTheDocument();
    expect(await screen.findByText('Command timed out')).toBeInTheDocument();
  });

  // R2-45: the test that asserted PATCH {role:'DRIVER'} was deleted — the API
  // rejects that body ("role must be admin or member"), so it locked in R2-22
  // (PROGRESS note). A spec-correct role-update test lands with the R2-22 fix
  // (step 6).

  it('saves the telemetry retention setting', async () => {
    const user = userEvent.setup();
    renderPage('/admin', <AdminPage />);

    await screen.findByText('Data retention');
    const retentionInput = screen.getByRole('spinbutton');
    const saveButton = screen.getByRole('button', { name: 'Save' });

    expect(saveButton).toBeDisabled();
    fireEvent.change(retentionInput, { target: { value: '90' } });
    expect(saveButton).not.toBeDisabled();

    await user.click(saveButton);

    await waitFor(() => {
      expect(apiMock).toHaveBeenCalledWith('/api/v1/admin/settings', {
        method: 'PATCH',
        body: { telemetryRetentionDays: '90' },
      });
    });
  });

  it('shows a usable retention form when saving fails', async () => {
    const user = userEvent.setup();
    renderPage('/admin', <AdminPage />);

    await screen.findByText('Data retention');
    fireEvent.change(screen.getByRole('spinbutton'), { target: { value: '45' } });

    apiMock.mockRejectedValueOnce(new Error('save failed'));
    await user.click(screen.getByRole('button', { name: 'Save' }));

    await waitFor(() => {
      expect(apiMock).toHaveBeenCalledWith('/api/v1/admin/settings', {
        method: 'PATCH',
        body: { telemetryRetentionDays: '45' },
      });
    });
    await waitFor(() => {
      expect(screen.getByRole('button', { name: 'Save' })).not.toBeDisabled();
    });
  });

  it('runs the retention job now', async () => {
    const user = userEvent.setup();
    renderPage('/admin', <AdminPage />);

    await screen.findByText('Data retention');
    await user.click(screen.getByRole('button', { name: /Run retention now/i }));

    await waitFor(() => {
      expect(apiMock).toHaveBeenCalledWith('/api/v1/admin/retention/run', {
        method: 'POST',
      });
    });
  });

  it('toggles the emergency global command-disable switch', async () => {
    const user = userEvent.setup();
    renderPage('/admin', <AdminPage />);

    await screen.findByText('Command safety switches');
    const disableSwitch = screen.getByRole('switch', {
      name: 'Emergency global command-disable',
    });

    expect(disableSwitch).toHaveAttribute('aria-checked', 'false');
    await user.click(disableSwitch);

    await waitFor(() => {
      expect(apiMock).toHaveBeenCalledWith('/api/v1/commands/switches', {
        method: 'POST',
        body: { commandsEnabled: false },
      });
    });
  });

  it('toggles global read-only mode', async () => {
    const user = userEvent.setup();
    renderPage('/admin', <AdminPage />);

    await screen.findByText('Command safety switches');
    const readOnlySwitch = screen.getByRole('switch', { name: 'Global read-only mode' });

    expect(readOnlySwitch).toHaveAttribute('aria-checked', 'false');
    await user.click(readOnlySwitch);

    await waitFor(() => {
      expect(apiMock).toHaveBeenCalledWith('/api/v1/commands/switches', {
        method: 'POST',
        body: { globalReadOnly: true },
      });
    });
  });

  it('requeues failed command jobs after confirmation', async () => {
    const user = userEvent.setup();
    const confirmSpy = vi.spyOn(window, 'confirm').mockReturnValue(true);
    renderPage('/admin', <AdminPage />);

    expect(await screen.findByText('vehicle-commands')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: /Requeue command jobs/i }));

    expect(confirmSpy).toHaveBeenCalledWith('Requeue all failed jobs?');
    await waitFor(() => {
      expect(apiMock).toHaveBeenCalledWith('/api/v1/admin/queue/vehicle-commands/flush', {
        method: 'POST',
      });
    });
  });

  it('renders the empty failed-jobs state', async () => {
    deadJobsFixture = [];
    renderPage('/admin', <AdminPage />);

    expect(await screen.findByText('No failed jobs.')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Requeue command jobs/i })).not.toBeInTheDocument();
  });
});
