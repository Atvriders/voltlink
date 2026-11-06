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

// --- Appended test suite for the Shell layout component ---
import { fireEvent } from '@testing-library/react';
import type { ComponentProps } from 'react';

vi.mock('../lib/push', () => ({ prepare: vi.fn().mockResolvedValue(undefined) }));
vi.mock('../lib/realtime', () => ({ realtimeStart: vi.fn(), realtimeStop: vi.fn() }));
vi.mock('../lib/vehicleSelection', () => ({
  readRecent: () => [] as string[],
  useSelectedVehicle: () => ({ selectedId: null as string | null, setVehicle: vi.fn() }),
}));
vi.mock('../auth/AuthContext', () => ({
  useAuth: () => authState,
  setTheme: vi.fn(),
  THEMES: [
    { id: 'voltlink-dark', name: 'VoltLink Dark' },
    { id: 'voltlink-light', name: 'VoltLink Light' },
  ],
}));

import { Shell } from './Shell';

type ShellUser = ComponentProps<typeof Shell>['user'];
const shellUser = authState.user as unknown as ShellUser;

const shellVehicle = {
  id: 'v1',
  displayName: 'Aurora',
  make: 'Volt',
  model: 'Aurora',
  exteriorColor: '#334155',
  providerVehicleId: 'demo-aurora',
  provider: 'demo',
  demo: true,
  capabilities: ['lock'],
  labels: [],
  groupIds: [],
  state: {
    status: 'online',
    chargingState: 'idle',
    batteryPercent: 72,
    batteryRangeKm: 420,
    locked: true,
    odometerKm: 12345,
    freshness: 'recent',
    updatedAt: new Date().toISOString(),
  },
};

let vehiclesResponse: (typeof shellVehicle)[] = [shellVehicle];

beforeEach(() => {
  vehiclesResponse = [shellVehicle];
  apiMock.mockImplementation(async (path: string) => {
    if (path === '/api/v1/vehicles') return vehiclesResponse;
    if (path.startsWith('/api/v1/notifications')) return { unread: 3 };
    if (path === '/api/v1/fleet/groups') return [];
    if (path === '/api/v1/users/favorites') return { ok: true };
    if (path === '/api/v1/users/settings') return { ok: true };
    return {};
  });
});

describe('Shell', () => {
  it('renders the navigation chrome, account menu and page content', async () => {
    renderPage(
      '/overview',
      <Shell user={shellUser}>
        <div>Dashboard body</div>
      </Shell>,
    );

    expect(await screen.findByText('Dashboard body')).toBeTruthy();
    expect(screen.getAllByText('VoltLink').length).toBeGreaterThan(0);
    expect(screen.getAllByText('alice@example.test').length).toBeGreaterThan(0);
    expect(screen.getAllByText('Overview').length).toBeGreaterThan(0);
    expect(await screen.findByLabelText('Notifications (3 unread)')).toBeTruthy();
    await waitFor(() => expect(apiMock).toHaveBeenCalledWith('/api/v1/vehicles'));
  });

  it('opens the vehicle switcher and lists the available vehicles', async () => {
    renderPage(
      '/overview',
      <Shell user={shellUser}>
        <div>Dashboard body</div>
      </Shell>,
    );

    const trigger = await screen.findByLabelText('Choose vehicle');
    fireEvent.click(trigger);

    expect(await screen.findByPlaceholderText('Search vehicles')).toBeTruthy();
    expect(await screen.findByText('Aurora')).toBeTruthy();
    expect(screen.getByText('All vehicles')).toBeTruthy();
  });

  it('hides the vehicle switcher when no vehicles exist', async () => {
    vehiclesResponse = [];

    renderPage(
      '/overview',
      <Shell user={shellUser}>
        <div>Empty fleet body</div>
      </Shell>,
    );

    expect(await screen.findByText('Empty fleet body')).toBeTruthy();
    await waitFor(() => expect(screen.queryByLabelText('Choose vehicle')).toBeNull());
    expect(screen.getAllByText('Overview').length).toBeGreaterThan(0);
  });

  it('persists a theme selection from the theme menu', async () => {
    renderPage(
      '/overview',
      <Shell user={shellUser}>
        <div>Dashboard body</div>
      </Shell>,
    );

    fireEvent.click(await screen.findByLabelText('Theme'));
    fireEvent.click(await screen.findByRole('menuitem', { name: /VoltLink Light/i }));

    await waitFor(() =>
      expect(apiMock).toHaveBeenCalledWith(
        '/api/v1/users/settings',
        expect.objectContaining({ method: 'PATCH' }),
      ),
    );
  });
});
