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

import userEvent from '@testing-library/user-event';
import { act } from '@testing-library/react';
import App from './App';

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
  AuthProvider: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  useAuth: () => authState,
}));

vi.mock('react-router-dom', async () => {
  const actual = await vi.importActual<typeof import('react-router-dom')>('react-router-dom');
  return {
    ...actual,
    BrowserRouter: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  };
});

vi.mock('./components/Shell', () => ({
  Shell: ({ children }: { children: React.ReactNode }) => <div data-testid="shell">{children}</div>,
}));

vi.mock('./components/StepUpDialog', () => ({
  StepUpDialogHost: () => null,
}));

vi.mock('./components/ui', () => ({
  Spinner: () => <div>Loading</div>,
}));

vi.mock('./lib/vehicleSelection', () => ({
  SelectedVehicleProvider: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}));

vi.mock('./pages/OverviewPage', () => ({ default: () => <div>Overview page</div> }));
vi.mock('./pages/LiveVehiclePage', () => ({ default: () => <div>Live vehicle page</div> }));
vi.mock('./pages/ShowroomPage', () => ({ default: () => <div>Showroom page</div> }));
vi.mock('./pages/MapPage', () => ({ default: () => <div>Map page</div> }));
vi.mock('./pages/DrivesPage', () => ({ default: () => <div>Drives page</div> }));
vi.mock('./pages/DriveDetailPage', () => ({ default: () => <div>Drive detail page</div> }));
vi.mock('./pages/ChargingPage', () => ({ default: () => <div>Charging page</div> }));
vi.mock('./pages/BatteryPage', () => ({ default: () => <div>Battery page</div> }));
vi.mock('./pages/AutomationsPage', () => ({ default: () => <div>Automations page</div> }));
vi.mock('./pages/NotificationsPage', () => ({ default: () => <div>Notifications page</div> }));
vi.mock('./pages/FleetPage', () => ({ default: () => <div>Fleet page</div> }));
vi.mock('./pages/ProvidersPage', () => ({ default: () => <div>Providers page</div> }));
vi.mock('./pages/StatusAdminPage', () => ({ default: () => <div>Status admin page</div> }));
vi.mock('./pages/AdminPage', () => ({ default: () => <div>Admin page</div> }));
vi.mock('./pages/SettingsPage', () => ({ default: () => <div>Settings page</div> }));
vi.mock('./pages/OnboardingPage', () => ({ default: () => <div>Onboarding page</div> }));
vi.mock('./pages/LoginPage', () => ({ default: () => <div>Login page</div> }));
vi.mock('./pages/RegisterPage', () => ({ default: () => <div>Register page</div> }));
vi.mock('./pages/SetupPage', () => ({ default: () => <div>Setup page</div> }));
vi.mock('./pages/PublicStatusPage', () => ({ default: () => <div>Public status page</div> }));
vi.mock('./pages/PresentationPage', () => ({ default: () => <div>Presentation page</div> }));
vi.mock('./pages/ResetPasswordPage', () => ({
  ForgotPasswordPage: () => <div>Forgot password page</div>,
  ResetPasswordPage: () => <div>Reset password page</div>,
  VerifyEmailPage: () => <div>Verify email page</div>,
}));

describe('App shell and routing', () => {
  const authedUser = {
    id: 'u1',
    email: 'alice@example.test',
    name: 'Alice',
    units: 'metric',
    timezone: 'UTC',
    theme: 'voltlink-dark',
    totpEnabled: false,
    demoEnabled: true,
    isInstanceAdmin: true,
  } as typeof authState.user;

  function renderApp(path: string) {
    return renderPage(path, <App />);
  }

  beforeEach(() => {
    authState.user = authedUser;
    authState.loading = false;
    authState.login.mockClear();
    authState.loginMfa.mockClear();
    authState.logout.mockClear();
    authState.refresh.mockClear();
    vi.spyOn(window, 'scrollTo').mockImplementation(() => undefined);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    delete (navigator as unknown as { serviceWorker?: unknown }).serviceWorker;
  });

  it('shows the loading fallback while auth is loading', () => {
    authState.loading = true;
    renderApp('/');
    expect(screen.getByText('Loading')).toBeInTheDocument();
    expect(screen.queryByTestId('shell')).not.toBeInTheDocument();
  });

  it('redirects unauthenticated users to the login page', async () => {
    authState.user = null as unknown as typeof authState.user;
    renderApp('/');
    expect(await screen.findByText('Login page')).toBeInTheDocument();
  });

  it('renders the authenticated overview and scrolls to top', async () => {
    renderApp('/');
    expect(await screen.findByText('Overview page')).toBeInTheDocument();
    expect(screen.getByTestId('shell')).toBeInTheDocument();
    expect(window.scrollTo).toHaveBeenCalledWith(0, 0);
  });

  it('renders nested authenticated routes', async () => {
    renderApp('/showroom');
    expect(await screen.findByText('Showroom page')).toBeInTheDocument();

    cleanup();
    renderApp('/settings/profile');
    expect(await screen.findByText('Settings page')).toBeInTheDocument();
  });

  it('renders NotFound and navigates back to overview', async () => {
    const user = userEvent.setup();
    renderApp('/does-not-exist');
    expect(await screen.findByText('Page not found')).toBeInTheDocument();

    await user.click(screen.getByRole('link', { name: /back to overview/i }));

    expect(await screen.findByText('Overview page')).toBeInTheDocument();
    await waitFor(() => expect(screen.queryByText('Page not found')).not.toBeInTheDocument());
  });

  it('renders public authentication routes', async () => {
    renderApp('/login');
    expect(await screen.findByText('Login page')).toBeInTheDocument();

    cleanup();
    renderApp('/register');
    expect(await screen.findByText('Register page')).toBeInTheDocument();

    cleanup();
    renderApp('/setup');
    expect(await screen.findByText('Setup page')).toBeInTheDocument();

    cleanup();
    renderApp('/forgot-password');
    expect(await screen.findByText('Forgot password page')).toBeInTheDocument();

    cleanup();
    renderApp('/reset-password');
    expect(await screen.findByText('Reset password page')).toBeInTheDocument();

    cleanup();
    renderApp('/verify-email');
    expect(await screen.findByText('Verify email page')).toBeInTheDocument();
  });

  it('renders the public status page', async () => {
    renderApp('/status');
    expect(await screen.findByText('Public status page')).toBeInTheDocument();
  });

  it('renders the protected presentation route for signed-in users', async () => {
    renderApp('/presentation');
    expect(await screen.findByText('Presentation page')).toBeInTheDocument();
  });

  it('navigates when the service worker sends a navigation message', async () => {
    const listeners: Array<(event: MessageEvent) => void> = [];
    Object.defineProperty(navigator, 'serviceWorker', {
      configurable: true,
      value: {
        addEventListener: (_type: string, listener: (event: MessageEvent) => void) => {
          listeners.push(listener);
        },
        removeEventListener: vi.fn(),
      },
    });

    renderApp('/');
    expect(await screen.findByText('Overview page')).toBeInTheDocument();

    act(() => {
      listeners.forEach((listener) =>
        listener({ data: { type: 'voltlink:navigate', path: '/showroom' } } as MessageEvent),
      );
    });

    expect(await screen.findByText('Showroom page')).toBeInTheDocument();
  });
});
