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
import StatusAdminPage from './StatusAdminPage';

const statusComponents = [
  { key: 'api', name: 'API', group: 'core', status: 'operational', manualOverride: false },
  { key: 'db', name: 'Database', group: 'data', status: 'degraded', manualOverride: true },
];

const statusHistory = [
  { latencyMs: 120, checkedAt: new Date().toISOString() },
  { latencyMs: 80, checkedAt: new Date().toISOString() },
];

const statusBundle = {
  overall: 'degraded',
  components: statusComponents,
  incidents: [],
  maintenance: [
    {
      id: 'm1',
      title: 'Scheduled DB upgrade',
      startsAt: '2025-03-01T10:00:00.000Z',
      endsAt: '2025-03-01T11:00:00.000Z',
      components: ['db'],
    },
  ],
  uptime30dPct: 99.9,
  updatedAt: new Date().toISOString(),
};

const incident = {
  id: 'i1',
  title: 'Database outage',
  severity: 'major',
  status: 'investigating',
  public: false,
  updates: [
    {
      id: 'u1',
      phase: 'investigating',
      message: 'Looking into it',
      createdAt: new Date().toISOString(),
    },
  ],
};

describe('StatusAdminPage', () => {
  beforeEach(() => {
    apiMock.mockReset();
    apiMock.mockImplementation(async (path: string, opts?: { method?: string }) => {
      if (path === '/api/v1/status') return statusBundle;
      if (path.startsWith('/api/v1/status/checks/history')) return statusHistory;
      if (path === '/api/v1/status/checks/run') return { ok: true, checked: 1 };
      if (path.startsWith('/api/v1/status/incidents/') && path.endsWith('/updates')) {
        return { id: 'u2' };
      }
      if (path.startsWith('/api/v1/status/incidents/') && opts?.method === 'PATCH') {
        return { ...incident, public: true };
      }
      if (path === '/api/v1/status/incidents' && opts?.method === 'POST') {
        return { ...incident, id: 'i2' };
      }
      if (path === '/api/v1/status/incidents') return [incident];
      if (path.startsWith('/api/v1/status/components/')) return { ok: true };
      if (path === '/api/v1/status/maintenance') return { id: 'm2' };
      return {};
    });
  });

  it('renders the status dashboard with components, incidents, maintenance, and latency chart', async () => {
    renderPage('/admin/status', <StatusAdminPage />);

    expect(await screen.findByText('API')).toBeTruthy();
    expect(screen.getByText('Database')).toBeTruthy();
    expect(screen.getByText('Scheduled DB upgrade')).toBeTruthy();
    expect(screen.getByText('30-day uptime: 99.9%')).toBeTruthy();
    expect(screen.getByRole('img', { name: 'Response time chart' })).toBeTruthy();
    expect(await screen.findByText('Database outage')).toBeTruthy();
    expect(screen.getByRole('link', { name: /public status page/i }).getAttribute('href')).toBe(
      '/status',
    );
    expect(screen.queryByText('No scheduled maintenance.')).toBeNull();
  });

  it('runs automated status checks from the header', async () => {
    const user = userEvent.setup();
    renderPage('/admin/status', <StatusAdminPage />);

    await screen.findByText('API');
    await user.click(screen.getByRole('button', { name: /run checks/i }));

    await waitFor(() => {
      expect(apiMock).toHaveBeenCalledWith('/api/v1/status/checks/run', { method: 'POST' });
    });
  });

  it('saves and clears component manual overrides', async () => {
    const user = userEvent.setup();
    renderPage('/admin/status', <StatusAdminPage />);

    await screen.findByText('API');
    await user.click(screen.getAllByRole('button', { name: 'edit' })[0]!);
    expect(screen.getByText('Override API')).toBeTruthy();

    fireEvent.change(screen.getByRole('combobox'), { target: { value: 'degraded' } });
    await user.click(screen.getByRole('button', { name: 'Apply' }));

    await waitFor(() => {
      expect(apiMock).toHaveBeenCalledWith('/api/v1/status/components/api', {
        method: 'PATCH',
        body: { status: 'degraded', manualOverride: true },
      });
    });
    await waitFor(() => expect(screen.queryByText('Override API')).toBeNull());

    await user.click(screen.getAllByRole('button', { name: 'edit' })[1]!);
    expect(screen.getByText('Override Database')).toBeTruthy();

    await user.click(screen.getByRole('button', { name: 'Clear override' }));

    await waitFor(() => {
      expect(apiMock).toHaveBeenCalledWith('/api/v1/status/components/db', {
        method: 'PATCH',
        body: { manualOverride: false },
      });
    });
  });

  it('creates a new incident from the incident modal', async () => {
    const user = userEvent.setup();
    renderPage('/admin/status', <StatusAdminPage />);

    await screen.findByText('Database outage');
    await user.click(screen.getByRole('button', { name: /new incident/i }));

    const textboxes = screen.getAllByRole('textbox');
    fireEvent.change(textboxes[0]!, { target: { value: 'API outage' } });
    fireEvent.change(textboxes[1]!, { target: { value: 'Investigating API errors' } });
    fireEvent.change(textboxes[2]!, { target: { value: 'api, postgres' } });
    fireEvent.change(screen.getByRole('combobox'), { target: { value: 'major' } });

    await user.click(screen.getByRole('button', { name: 'Create incident' }));

    await waitFor(() => {
      expect(apiMock).toHaveBeenCalledWith(
        '/api/v1/status/incidents',
        expect.objectContaining({
          method: 'POST',
          body: expect.objectContaining({
            title: 'API outage',
            severity: 'major',
            message: 'Investigating API errors',
            components: ['api', 'postgres'],
            public: true,
          }),
        }),
      );
    });
  });

  it('toggles incident public visibility', async () => {
    const user = userEvent.setup();
    renderPage('/admin/status', <StatusAdminPage />);

    await screen.findByText('Database outage');
    await user.click(screen.getByRole('button', { name: 'Make public' }));

    await waitFor(() => {
      expect(apiMock).toHaveBeenCalledWith('/api/v1/status/incidents/i1', {
        method: 'PATCH',
        body: { public: true },
      });
    });
  });

  it('posts an incident update', async () => {
    const user = userEvent.setup();
    renderPage('/admin/status', <StatusAdminPage />);

    await screen.findByText('Database outage');
    await user.click(screen.getByRole('button', { name: 'Update' }));

    fireEvent.change(screen.getByRole('textbox'), {
      target: { value: 'Root cause identified' },
    });
    fireEvent.change(screen.getByRole('combobox'), { target: { value: 'identified' } });

    await user.click(screen.getByRole('button', { name: 'Post update' }));

    await waitFor(() => {
      expect(apiMock).toHaveBeenCalledWith('/api/v1/status/incidents/i1/updates', {
        method: 'POST',
        body: { phase: 'identified', message: 'Root cause identified' },
      });
    });
  });

  it('schedules a maintenance window', async () => {
    const user = userEvent.setup();
    renderPage('/admin/status', <StatusAdminPage />);

    await screen.findByText('Scheduled DB upgrade');
    await user.click(screen.getAllByRole('button', { name: 'Schedule' })[0]!);

    const textboxes = screen.getAllByRole('textbox');
    fireEvent.change(textboxes[0]!, { target: { value: 'Database migration' } });
    fireEvent.change(textboxes[1]!, { target: { value: 'db, workers' } });

    const dateInputs = document.querySelectorAll<HTMLInputElement>('input[type="datetime-local"]');
    fireEvent.change(dateInputs[0]!, { target: { value: '2025-03-01T10:00' } });
    fireEvent.change(dateInputs[1]!, { target: { value: '2025-03-01T11:00' } });

    const scheduleButtons = screen.getAllByRole('button', { name: 'Schedule' });
    await user.click(scheduleButtons[scheduleButtons.length - 1]!);

    await waitFor(() => {
      expect(apiMock).toHaveBeenCalledWith(
        '/api/v1/status/maintenance',
        expect.objectContaining({
          method: 'POST',
          body: expect.objectContaining({
            title: 'Database migration',
            components: ['db', 'workers'],
          }),
        }),
      );
    });
  });
});
