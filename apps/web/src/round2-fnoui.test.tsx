// R6: F-NOUI — manual automation trigger and department/cost-center creation
// exist in the UI.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { render, screen, waitFor, cleanup, fireEvent } from '@testing-library/react';
import FleetPage from './pages/FleetPage';
import AutomationsPage from './pages/AutomationsPage';
import LiveVehiclePage from './pages/LiveVehiclePage';

const apiMock = vi.fn();
vi.mock('./api/client', () => ({
  api: (...args: unknown[]) => apiMock(...args),
  apiCsv: vi.fn().mockResolvedValue(''),
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
vi.mock('./auth/AuthContext', () => ({
  useAuth: () => ({
    user: {
      id: 'u1',
      email: 'a@example.invalid',
      name: 'A',
      units: 'metric',
      timezone: 'UTC',
      theme: 'voltlink-dark',
      totpEnabled: false,
      demoEnabled: true,
      isInstanceAdmin: true,
    },
    loading: false,
    login: vi.fn(),
    loginMfa: vi.fn(),
    logout: vi.fn(),
    refresh: vi.fn(),
  }),
}));
vi.mock('./webgl/VehicleViewer', () => ({
  default: () => <div data-testid="viewer" />,
}));

const automation = {
  id: 'a1',
  name: 'Night climate',
  description: '',
  enabled: true,
  vehicleId: null,
  trigger: { type: 'scheduled', params: {} },
  actions: [{ type: 'climate_start', params: {} }],
  runCount: 3,
  lastRunAt: null,
  lastResult: 'success',
};

beforeEach(() => {
  apiMock.mockImplementation(async (path: string) => {
    if (path === '/api/v1/automations') return [automation];
    if (path.startsWith('/api/v1/automations/a1/trigger')) return { ok: true };
    if (path === '/api/v1/fleet/drivers') return [];
    if (path === '/api/v1/fleet/departments') return [];
    if (path === '/api/v1/fleet/cost-centers') return [];
    if (path === '/api/v1/fleet/assignments') return [];
    if (path === '/api/v1/fleet/groups') return [];
    if (path === '/api/v1/fleet/overview') return { vehicles: [], groups: [] };
    if (path === '/api/v1/vehicles') return [];
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
    return {};
  });
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

function renderPage(path: string, ui: React.ReactNode, routePath = '*') {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <MemoryRouter initialEntries={[path]}>
        <Routes>
          <Route path={routePath} element={ui as React.ReactElement} />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

describe('missing UI capabilities (F-NOUI)', () => {
  it('offers a manual automation trigger', async () => {
    renderPage('/automations', <AutomationsPage />);
    await waitFor(() => expect(screen.getByText('Night climate')).toBeTruthy());
    fireEvent.click(screen.getByRole('button', { name: /run now/i }));
    await waitFor(() =>
      expect(apiMock).toHaveBeenCalledWith(
        '/api/v1/automations/a1/trigger',
        expect.objectContaining({ method: 'POST' }),
      ),
    );
  });

  it('creates a department from the drivers tab', async () => {
    renderPage('/fleet', <FleetPage />);
    await waitFor(() => expect(screen.getByRole('button', { name: /drivers/i })).toBeTruthy());
    fireEvent.click(screen.getByRole('button', { name: /drivers/i }));
    fireEvent.click(await screen.findByRole('button', { name: /add department/i }));
    fireEvent.change(await screen.findByLabelText('Department name'), { target: { value: 'R&D' } });
    fireEvent.click(screen.getByRole('button', { name: /create department/i }));
    await waitFor(() =>
      expect(apiMock).toHaveBeenCalledWith(
        '/api/v1/fleet/departments',
        expect.objectContaining({ method: 'POST', body: { name: 'R&D' } }),
      ),
    );
  });

  it('creates a cost center from the drivers tab', async () => {
    renderPage('/fleet', <FleetPage />);
    await waitFor(() => expect(screen.getByRole('button', { name: /drivers/i })).toBeTruthy());
    fireEvent.click(screen.getByRole('button', { name: /drivers/i }));
    fireEvent.click(await screen.findByRole('button', { name: /add cost center/i }));
    fireEvent.change(await screen.findByLabelText('Cost center name'), {
      target: { value: 'CC-1' },
    });
    fireEvent.click(screen.getByRole('button', { name: /create cost center/i }));
    await waitFor(() =>
      expect(apiMock).toHaveBeenCalledWith(
        '/api/v1/fleet/cost-centers',
        expect.objectContaining({ method: 'POST', body: { name: 'CC-1' } }),
      ),
    );
  });

  it('shares a vehicle and revokes a share from the live page', async () => {
    apiMock.mockImplementation(async (path: string, init?: { method?: string; body?: unknown }) => {
      if (path === '/api/v1/vehicles')
        return [
          {
            id: 'v1',
            displayName: 'Aurora',
            exteriorColor: '#334455',
            providerVehicleId: 'demo-aurora',
            provider: 'demo',
            demo: true,
            capabilities: [],
            state: {
              status: 'online',
              chargingState: 'parked',
              batteryPercent: 72,
              batteryRangeKm: 420,
              locked: true,
              odometerKm: 1234,
              interiorTempC: 21,
              outsideTempC: 12,
              speedKmh: 0,
              latitude: 40,
              longitude: -100,
              address: '1 Main St',
              freshness: 'recent',
              updatedAt: new Date().toISOString(),
            },
          },
        ];
      if (path === '/api/v1/vehicles/v1') return { id: 'v1', displayName: 'Aurora' };
      if (path === '/api/v1/vehicles/v1/shares' && init?.method === 'POST')
        return { status: 'invited' };
      if (path === '/api/v1/vehicles/v1/shares')
        return [{ id: 's1', userEmail: 'b@example.invalid', level: 'viewer', allowHighRisk: false }];
      if (path.startsWith('/api/v1/vehicles/v1/shares/s1')) return { ok: true };
      if (path.startsWith('/api/v1/commands?')) return { items: [], total: 0 };
      if (path.startsWith('/api/v1/drives')) return { items: [], total: 0 };
      if (path.includes('/drives/totals')) return { count: 0, distanceKm: 0, energyKwh: 0 };
      if (path.startsWith('/api/v1/charging')) return { items: [], total: 0 };
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
      return {};
    });
    renderPage('/vehicles/v1', <LiveVehiclePage />, '/vehicles/:id');
    await waitFor(() => expect(screen.getByText('Aurora')).toBeTruthy());
    await waitFor(() => expect(screen.getByText('b@example.invalid')).toBeTruthy());
    const emailInput = screen.getByLabelText(/email/i);
    fireEvent.change(emailInput, { target: { value: 'c@example.invalid' } });
    fireEvent.click(screen.getByRole('button', { name: /share/i }));
    await waitFor(() =>
      expect(apiMock).toHaveBeenCalledWith(
        '/api/v1/vehicles/v1/shares',
        expect.objectContaining({ method: 'POST', body: { email: 'c@example.invalid', level: 'viewer' } }),
      ),
    );
    fireEvent.click(screen.getByRole('button', { name: /revoke/i }));
    await waitFor(() =>
      expect(apiMock).toHaveBeenCalledWith(
        '/api/v1/vehicles/v1/shares/s1',
        expect.objectContaining({ method: 'DELETE' }),
      ),
    );
  });
});
