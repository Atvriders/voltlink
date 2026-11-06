// Page render test (coverage harness).
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { render, screen, waitFor, cleanup } from '@testing-library/react';

const apiMock = vi.fn();
const csvMock = vi.fn().mockResolvedValue('a,b');
vi.mock('./api/client', () => ({
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

function renderApp(path: string) {
  window.history.pushState({}, '', path);
  const qc = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return render(
    <QueryClientProvider client={qc}>
      <App />
    </QueryClientProvider>,
  );
}

import App from './App';
import { fireEvent } from '@testing-library/react';

vi.mock('./api/client', () => ({
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

vi.mock('./auth/AuthContext', () => ({
  useAuth: () => authState,
  AuthProvider: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}));

vi.mock('./lib/vehicleSelection', () => ({
  SelectedVehicleProvider: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}));

vi.mock('./components/Shell', () => ({
  Shell: ({ children }: { children: React.ReactNode }) => (
    <div>
      <nav>VoltLink shell</nav>
      {children}
    </div>
  ),
}));

vi.mock('./components/StepUpDialog', () => ({
  StepUpDialogHost: () => null,
}));

vi.mock('./lib/toast', () => ({
  toast: { error: vi.fn() },
  ToastRegion: () => null,
  errorText: (e: unknown) => String(e),
}));

vi.mock('./components/boundaries', () => ({
  ErrorBoundary: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  RouteErrorFallback: () => <div>Route error</div>,
}));

vi.mock('./components/ui', () => ({
  Spinner: () => <div>Loading…</div>,
}));

vi.mock('./pages/OverviewPage', () => ({
  default: () => <div>Overview page stub</div>,
}));

vi.mock('./pages/LoginPage', () => ({
  default: () => <div>Login page stub</div>,
}));

vi.mock('./pages/RegisterPage', () => ({
  default: () => <div>Register page stub</div>,
}));

vi.mock('./pages/SetupPage', () => ({
  default: () => <div>Setup page stub</div>,
}));

vi.mock('./pages/ResetPasswordPage', () => ({
  ForgotPasswordPage: () => <div>Forgot password page stub</div>,
  ResetPasswordPage: () => <div>Reset password page stub</div>,
  VerifyEmailPage: () => <div>Verify email page stub</div>,
}));

vi.mock('./pages/PublicStatusPage', () => ({
  default: () => <div>Public status page stub</div>,
}));

describe('App shell router', () => {
  beforeEach(() => {
    Object.defineProperty(window, 'scrollTo', { value: vi.fn(), writable: true });
    window.matchMedia =
      window.matchMedia ||
      (((q: string) => ({
        matches: false,
        media: q,
        onchange: null,
        addListener: () => {},
        removeListener: () => {},
        addEventListener: () => {},
        removeEventListener: () => {},
        dispatchEvent: () => false,
      })) as unknown as typeof window.matchMedia);
  });

  it('renders the overview page inside the authenticated shell', async () => {
    renderApp('/');

    expect(await screen.findByText('Overview page stub')).toBeTruthy();
    expect(screen.getByText('VoltLink shell')).toBeTruthy();
  });

  it('renders the not found page for an unknown authenticated route', async () => {
    renderApp('/does-not-exist');

    expect(await screen.findByText('Page not found')).toBeTruthy();
    expect(screen.getByText(/That address does not exist/i)).toBeTruthy();
  });

  it('navigates back to the overview from the not found page', async () => {
    renderApp('/missing');

    const link = await screen.findByRole('link', { name: /back to overview/i });
    fireEvent.click(link);

    expect(await screen.findByText('Overview page stub')).toBeTruthy();
  });
});
