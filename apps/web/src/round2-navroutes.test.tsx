// R6: F-NAVREDIRECT — /vehicles and /vehicles/:id/history must be real routes,
// not redirects to Overview.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { render, screen, cleanup } from '@testing-library/react';
import type { ReactNode } from 'react';
import App from './App';

const apiMock = vi.fn();
vi.mock('./api/client', () => ({
  api: (...args: unknown[]) => apiMock(...args),
  apiCsv: vi.fn().mockResolvedValue('a,b'),
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
vi.mock('./auth/AuthContext', () => ({
  useAuth: () => authState,
  AuthProvider: ({ children }: { children: ReactNode }) => <>{children}</>,
}));

vi.mock('react-router-dom', async () => {
  const actual = await vi.importActual<typeof import('react-router-dom')>('react-router-dom');
  return {
    ...actual,
    BrowserRouter: ({ children }: { children: ReactNode }) => <>{children}</>,
  };
});

vi.mock('./components/Shell', () => ({
  Shell: ({ children }: { children: ReactNode }) => <div data-testid="shell">{children}</div>,
}));

vi.mock('./components/StepUpDialog', () => ({
  StepUpDialogHost: () => null,
}));

vi.mock('./lib/vehicleSelection', () => ({
  SelectedVehicleProvider: ({ children }: { children: ReactNode }) => <>{children}</>,
}));

const vehicle = {
  id: 'v1',
  displayName: 'Aurora',
  exteriorColor: '#334155',
  providerVehicleId: 'demo-aurora',
  provider: 'demo',
  demo: true,
  capabilities: ['honk_horn'],
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
};

beforeEach(() => {
  apiMock.mockImplementation(async (path: string) => {
    if (path === '/api/v1/vehicles') return [vehicle];
    if (path === `/api/v1/vehicles/${vehicle.id}`) return vehicle;
    if (path.startsWith('/api/v1/commands?vehicleId='))
      return {
        items: [
          {
            id: 'c1',
            vehicleId: 'v1',
            type: 'honk_horn',
            status: 'confirmed',
            createdAt: new Date().toISOString(),
            params: {},
          },
        ],
        total: 1,
        page: 1,
        pageSize: 20,
      };
    if (path.startsWith('/api/v1/drives')) return { items: [], total: 0, page: 1, pageSize: 20 };
    if (path === '/api/v1/auth/setup-status')
      return { needsSetup: false, registrationMode: 'invite' };
    if (path === '/api/v1/notifications') return { items: [] };
    if (path === '/api/v1/notifications/preferences') return [];
    if (path === '/api/v1/status')
      return {
        overall: 'operational',
        components: [],
        incidents: [],
        maintenance: [],
        updatedAt: new Date().toISOString(),
      };
    return {};
  });
  vi.spyOn(window, 'scrollTo').mockImplementation(() => undefined);
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

function renderApp(path: string) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <MemoryRouter initialEntries={[path]}>
        <Routes>
          <Route path="*" element={<App />} />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

describe('navigation routes (F-NAVREDIRECT)', () => {
  it('/vehicles renders a vehicle list instead of redirecting', async () => {
    renderApp('/vehicles');
    expect(await screen.findByRole('heading', { name: /vehicles/i })).toBeTruthy();
    expect(screen.queryByRole('heading', { name: /^overview$/i })).toBeNull();
  });

  it('/vehicles/:id/history renders the command history page', async () => {
    renderApp('/vehicles/v1/history');
    expect(await screen.findByRole('heading', { name: /command history/i })).toBeTruthy();
    expect(await screen.findByText('Aurora')).toBeTruthy();
  });
});
