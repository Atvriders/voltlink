// Page-level unit coverage: renders the main SPA pages against a mocked API
// client so the render paths, empty states, tables and forms are exercised
// without a server or browser.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { render, screen, waitFor, act, cleanup } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

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
    if (path.includes('/drives/totals'))
      return { count: 0, distanceKm: 0, energyKwh: 0, estCost: 0, costPerKm: 0 };
    if (path.startsWith('/api/v1/drives')) return { items: [], total: 0, page: 1, pageSize: 20 };
    if (path === '/api/v1/charging/rates/list') return [];
    if (path === '/api/v1/charging/totals') return { count: 0, energyKwh: 0, cost: 0 };
    if (path.startsWith('/api/v1/charging')) return { items: [], total: 0 };
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

describe('page render coverage', () => {
  it('renders the overview page with a vehicle', async () => {
    const OverviewPage = (await import('./OverviewPage')).default;
    renderPage('/overview', <OverviewPage />);
    expect((await screen.findAllByText('Aurora')).length).toBeGreaterThan(0);
    await waitFor(() => expect(apiMock).toHaveBeenCalled());
  });

  it('renders the public status page anonymously', async () => {
    const PublicStatusPage = (await import('./PublicStatusPage')).default;
    renderPage('/status', <PublicStatusPage />);
    expect(
      (await screen.findAllByText(/operational|maintenance|degraded/i)).length,
    ).toBeGreaterThan(0);
  });

  it('renders the drives page with its empty state and export buttons', async () => {
    const DrivesPage = (await import('./DrivesPage')).default;
    renderPage('/drives', <DrivesPage />);
    expect((await screen.findAllByText(/drives/i)).length).toBeGreaterThan(0);
    await userEvent.click(screen.getByRole('button', { name: 'CSV' }));
    await waitFor(() => {
      const calls = [...apiMock.mock.calls, ...csvMock.mock.calls].map((c) => String(c[0]));
      expect(calls.some((p) => p.includes('export/csv'))).toBe(true);
    });
  });

  it('renders the charging page and its rate rule table', async () => {
    const ChargingPage = (await import('./ChargingPage')).default;
    renderPage('/charging', <ChargingPage />);
    await waitFor(() => expect(apiMock).toHaveBeenCalled());
    expect((await screen.findAllByText(/rate|session|charging/i)).length).toBeGreaterThan(0);
  });

  it('renders the battery page', async () => {
    const BatteryPage = (await import('./BatteryPage')).default;
    renderPage('/battery', <BatteryPage />);
    expect(await screen.findByText(/72%|Battery/i)).toBeTruthy();
  });

  it('renders the register page and submits the form', async () => {
    const RegisterPage = (await import('./RegisterPage')).default;
    renderPage('/register', <RegisterPage />);
    await userEvent.type(screen.getByLabelText('Name'), 'Bob');
    await userEvent.type(screen.getByLabelText(/Email/), 'bob@example.test');
    await userEvent.type(screen.getByLabelText(/Password/), 'password-12345');
    await userEvent.click(screen.getByRole('button', { name: /create account/i }));
    await waitFor(() =>
      expect(apiMock).toHaveBeenCalledWith('/api/v1/auth/register', expect.anything()),
    );
  });

  it('renders the setup page against a bootstrapped instance', async () => {
    const SetupPage = (await import('./SetupPage')).default;
    renderPage('/setup', <SetupPage />);
    // bootstrapped -> redirect to /login
    await waitFor(() => expect(apiMock).toHaveBeenCalledWith('/api/v1/auth/setup-status'));
  });

  it('renders the login page, fills the form and submits', async () => {
    const LoginPage = (await import('./LoginPage')).default;
    renderPage('/login', <LoginPage />);
    await waitFor(() => expect(apiMock).toHaveBeenCalledWith('/api/v1/auth/setup-status'));
    await userEvent.type(screen.getByLabelText(/Email/), 'alice@example.test');
    await userEvent.type(screen.getByLabelText(/Password/), 'password-12345');
    await userEvent.click(screen.getAllByRole('button', { name: /^Sign in$/i })[0]!);
    await waitFor(() => expect(authState.login).toHaveBeenCalled());
  });

  it('renders the step-up dialog with method buttons', async () => {
    const { StepUpDialogHost } = await import('../components/StepUpDialog');
    const { setStepUpHandler, requestStepUp } = await import('../lib/stepUpBus');
    render(<StepUpDialogHost />);
    let resolveFn: (v: boolean) => void = () => undefined;
    const p = new Promise<boolean>((r) => (resolveFn = r));
    act(() => {
      void requestStepUp(['password', 'totp']).then(resolveFn);
    });
    expect(await screen.findByText(/Step-up required/i)).toBeTruthy();
    expect(screen.getByRole('button', { name: /Password/i })).toBeTruthy();
    expect(screen.getByRole('button', { name: /Authenticator/i })).toBeTruthy();
    setStepUpHandler(null);
    await act(async () => {
      resolveFn(false);
      await p;
    });
  });
});
