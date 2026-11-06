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
import { within } from '@testing-library/react';
import { ApiError } from '../api/client';
import ProvidersPage from './ProvidersPage';

const providersFixture = [
  {
    id: 'acct-demo',
    provider: 'demo',
    label: 'Demo fleet',
    demo: true,
    status: 'connected',
    vehicleCount: 5,
    lastSyncAt: new Date('2024-01-01T00:00:00Z').toISOString(),
  },
  {
    id: 'acct-1',
    provider: 'tesla',
    label: 'Personal Tesla',
    demo: false,
    status: 'connected',
    vehicleCount: 2,
    lastSyncAt: new Date('2024-01-02T00:00:00Z').toISOString(),
  },
  {
    id: 'acct-2',
    provider: 'tessie',
    label: 'Tessie token',
    demo: false,
    status: 'error',
    vehicleCount: 0,
    lastError: 'Token expired',
  },
];

const readinessFixture = [
  {
    provider: 'tesla',
    ok: true,
    configured: true,
    checks: [
      { ok: true, detail: 'TESLA_CLIENT_ID configured' },
      { ok: true, detail: 'OAuth redirect registered' },
    ],
  },
  {
    provider: 'tessie',
    ok: false,
    configured: false,
    checks: [{ ok: false, detail: 'TESSIE_API_TOKEN missing' }],
  },
];

describe('ProvidersPage', () => {
  beforeEach(() => {
    apiMock.mockClear();
    csvMock.mockClear();
    apiMock.mockImplementation(async (path: string) => {
      if (path === '/api/v1/providers/readiness') return readinessFixture;
      if (path === '/api/v1/providers') return providersFixture;
      if (path === '/api/v1/providers/demo/connect') return { vehiclesImported: 5 };
      if (path === '/api/v1/providers/acct-1/import') return { imported: 2 };
      if (path === '/api/v1/providers/acct-1/disconnect') return {};
      if (path === '/api/v1/providers/tessie/connect') return {};
      if (path === '/api/v1/providers/tesla/authorize')
        return { url: 'https://tesla.example/oauth' };
      return {};
    });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('renders provider sections, readiness diagnostics, and connected accounts', async () => {
    renderPage('/providers', <ProvidersPage />);

    expect(await screen.findByRole('heading', { name: 'Providers' })).toBeInTheDocument();
    expect(await screen.findByText(/five fictional vehicles/i)).toBeInTheDocument();
    expect(screen.getByText('Tesla (official API)')).toBeInTheDocument();
    expect(await screen.findByText('Provider-readiness diagnostics')).toBeInTheDocument();
    expect(screen.getByText('TESLA_CLIENT_ID configured')).toBeInTheDocument();
    expect(screen.getByText('TESSIE_API_TOKEN missing')).toBeInTheDocument();
    expect(screen.getAllByText('ready').length).toBeGreaterThan(0);
    expect(screen.getAllByText('needs configuration').length).toBeGreaterThan(0);
    expect(screen.getAllByText('account connected').length).toBeGreaterThan(0);
    expect(screen.getByText('Personal Tesla')).toBeInTheDocument();
    expect(screen.getByText('2 vehicles')).toBeInTheDocument();
    expect(screen.getByText('Token expired')).toBeInTheDocument();
    expect(screen.getAllByText('connected').length).toBeGreaterThan(0);
    expect(screen.getByText('error')).toBeInTheDocument();
  });

  it('submits the demo fleet connect action', async () => {
    const user = userEvent.setup();
    renderPage('/providers', <ProvidersPage />);

    const demoButton = await screen.findByRole('button', { name: /Refresh demo fleet/i });
    await user.click(demoButton);

    await waitFor(() =>
      expect(apiMock).toHaveBeenCalledWith('/api/v1/providers/demo/connect', {
        method: 'POST',
      }),
    );
  });

  it('imports vehicles from a connected provider account', async () => {
    const user = userEvent.setup();
    renderPage('/providers', <ProvidersPage />);

    const row = (await screen.findByText('Personal Tesla')).closest('li');
    expect(row).not.toBeNull();

    await user.click(within(row as HTMLElement).getByRole('button', { name: /Import/i }));

    await waitFor(() =>
      expect(apiMock).toHaveBeenCalledWith('/api/v1/providers/acct-1/import', {
        method: 'POST',
      }),
    );
  });

  it('disconnects a provider account after confirmation', async () => {
    const user = userEvent.setup();
    const confirmSpy = vi.fn(() => true);
    vi.stubGlobal('confirm', confirmSpy);

    renderPage('/providers', <ProvidersPage />);

    const row = (await screen.findByText('Personal Tesla')).closest('li');
    expect(row).not.toBeNull();

    await user.click(within(row as HTMLElement).getByRole('button', { name: /Disconnect/i }));

    expect(confirmSpy).toHaveBeenCalledWith(
      'Disconnect tesla? Stored credentials will be removed.',
    );
    await waitFor(() =>
      expect(apiMock).toHaveBeenCalledWith('/api/v1/providers/acct-1/disconnect', {
        method: 'POST',
      }),
    );
  });

  it('opens, cancels, and submits the Tessie token modal', async () => {
    const user = userEvent.setup();
    renderPage('/providers', <ProvidersPage />);

    await user.click(
      await screen.findByRole('button', { name: /Connect with Tessie token/i }),
    );
    expect(await screen.findByText('Connect Tessie (optional)')).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'Cancel' }));
    await waitFor(() =>
      expect(screen.queryByText('Connect Tessie (optional)')).not.toBeInTheDocument(),
    );

    await user.click(screen.getByRole('button', { name: /Connect with Tessie token/i }));

    const tokenInput = document.querySelector(
      'input[type="password"]',
    ) as HTMLInputElement | null;
    expect(tokenInput).not.toBeNull();

    expect(screen.getByRole('button', { name: 'Connect' })).toBeDisabled();
    await user.type(tokenInput!, 'token-123');
    await waitFor(() =>
      expect(screen.getByRole('button', { name: 'Connect' })).toBeEnabled(),
    );

    await user.click(screen.getByRole('button', { name: 'Connect' }));

    await waitFor(() =>
      expect(apiMock).toHaveBeenCalledWith('/api/v1/providers/tessie/connect', {
        method: 'POST',
        body: { token: 'token-123', label: 'Tessie' },
      }),
    );
    await waitFor(() =>
      expect(screen.queryByText('Connect Tessie (optional)')).not.toBeInTheDocument(),
    );
  });

  it('shows the Tesla configuration error when OAuth start returns 503', async () => {
    const user = userEvent.setup();
    renderPage('/providers', <ProvidersPage />);

    await screen.findByText('Tesla (official API)');
    apiMock.mockImplementationOnce(() =>
      Promise.reject(new ApiError('tesla_not_configured', 'Tesla not configured', 503)),
    );

    await user.click(screen.getByRole('button', { name: /Connect with Tesla/i }));

    await waitFor(() =>
      expect(apiMock).toHaveBeenCalledWith('/api/v1/providers/tesla/authorize'),
    );
    expect(await screen.findByRole('alert')).toHaveTextContent(
      /Tesla isn.t configured on this server/,
    );
  });

  it('shows an error alert when demo connect fails', async () => {
    const user = userEvent.setup();
    renderPage('/providers', <ProvidersPage />);

    const demoButton = await screen.findByRole('button', { name: /Refresh demo fleet/i });
    apiMock.mockImplementationOnce(() =>
      Promise.reject(new ApiError('demo_failed', 'Demo connect failed', 500)),
    );

    await user.click(demoButton);

    await waitFor(() =>
      expect(apiMock).toHaveBeenCalledWith('/api/v1/providers/demo/connect', {
        method: 'POST',
      }),
    );
    expect(await screen.findByRole('alert')).toHaveTextContent('Demo connect failed');
  });
});
