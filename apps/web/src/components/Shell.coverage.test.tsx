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
import { Shell } from './Shell';
import { SelectedVehicleProvider } from '../lib/vehicleSelection';

function renderShell(ui: React.ReactNode) {
  const qc = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return render(
    <QueryClientProvider client={qc}>
      <MemoryRouter initialEntries={['/']}>
        <SelectedVehicleProvider userId={authState.user.id}>
          <Routes>
            <Route path="*" element={ui as React.ReactElement} />
          </Routes>
        </SelectedVehicleProvider>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

vi.mock('../lib/push', () => ({ prepare: vi.fn().mockResolvedValue(undefined) }));
vi.mock('../lib/realtime', () => ({ realtimeStart: vi.fn(), realtimeStop: vi.fn() }));
vi.mock('../auth/AuthContext', () => ({
  useAuth: () => authState,
  setTheme: vi.fn(),
  THEMES: [
    { id: 'voltlink-dark', name: 'VoltLink Dark' },
    { id: 'voltlink-light', name: 'VoltLink Light' },
  ],
}));

const vehicleA = {
  ...vehicle,
  id: 'v1',
  displayName: 'Aurora',
  model: 'Model 3',
  make: 'Tesla',
  labels: ['daily'],
  groupIds: ['g1'],
};

const vehicleB = {
  ...vehicle,
  id: 'v2',
  displayName: 'Borealis',
  exteriorColor: '#0ea5e9',
  providerVehicleId: 'demo-borealis',
  model: 'Ioniq 5',
  make: 'Hyundai',
  labels: ['roadtrip'],
  groupIds: [],
  state: {
    ...vehicle.state,
    chargingState: 'idle',
    batteryPercent: 44,
    locked: false,
  },
};

describe('Shell', () => {
  beforeEach(() => {
    localStorage.clear();
    authState.logout.mockClear();
    apiMock.mockReset();
    apiMock.mockImplementation(async (path: string) => {
      if (path === '/api/v1/vehicles') return [vehicleA, vehicleB];
      if (path === `/api/v1/vehicles/${vehicleA.id}`) return vehicleA;
      if (path === '/api/v1/notifications?pageSize=1') return { unread: 2 };
      if (path.startsWith('/api/v1/notifications')) return { items: [] };
      if (path === '/api/v1/fleet/groups') return [{ id: 'g1', name: 'Daily' }];
      if (path === '/api/v1/users/favorites') return {};
      if (path === '/api/v1/users/settings') return {};
      return {};
    });
  });

  it('renders the shell chrome, navigation, and notifications badge', async () => {
    renderPage(
      '/',
      <Shell user={authState.user}>
        <div>Page content</div>
      </Shell>,
    );

    expect(await screen.findByText('Page content')).toBeTruthy();
    expect(screen.getByRole('navigation', { name: 'Main navigation' })).toBeTruthy();
    expect(screen.getAllByText('Overview').length).toBeGreaterThan(0);
    expect(await screen.findByRole('link', { name: 'Notifications (2 unread)' })).toBeTruthy();
  });

  it('opens the vehicle switcher, filters, toggles a favorite, and selects a vehicle', async () => {
    const user = userEvent.setup();
    renderShell(
      <Shell user={authState.user}>
        <div>Page content</div>
      </Shell>,
    );

    await user.click(await screen.findByRole('button', { name: 'Choose vehicle' }));
    const search = screen.getByRole('searchbox', { name: 'Search vehicles' });
    await user.type(search, 'Aurora');

    await waitFor(() => expect(screen.queryByText('Borealis')).toBeNull());
    expect(screen.getAllByText('Aurora').length).toBeGreaterThan(0);

    const addFavorite = screen.getAllByRole('button', { name: /Add Aurora to favorites/ })[0]!;
    await user.click(addFavorite);
    await waitFor(() =>
      expect(apiMock).toHaveBeenCalledWith(
        '/api/v1/users/favorites',
        expect.objectContaining({ method: 'PUT' }),
      ),
    );

    const pickButton = screen.getAllByText('Aurora')[0]!.closest('button');
    expect(pickButton).toBeTruthy();
    await user.click(pickButton!);

    // Picking closes the switcher and navigates to the vehicle's live page.
    await waitFor(() =>
      expect(screen.queryByRole('searchbox', { name: 'Search vehicles' })).toBeNull(),
    );
    expect(screen.getByText('Page content')).toBeTruthy();
  });

  it('opens the theme menu and persists the chosen theme', async () => {
    const user = userEvent.setup();
    renderPage(
      '/',
      <Shell user={authState.user}>
        <div>Page content</div>
      </Shell>,
    );

    await user.click(await screen.findByRole('button', { name: 'Theme' }));
    expect(screen.getByRole('menu')).toBeTruthy();
    expect(screen.getByRole('menuitem', { name: 'VoltLink Dark' })).toBeTruthy();

    await user.click(screen.getByRole('menuitem', { name: 'VoltLink Light' }));
    await waitFor(() =>
      expect(apiMock).toHaveBeenCalledWith(
        '/api/v1/users/settings',
        expect.objectContaining({ method: 'PATCH', body: { theme: 'voltlink-light' } }),
      ),
    );
  });

  it('opens the account menu and signs out', async () => {
    const user = userEvent.setup();
    renderPage(
      '/',
      <Shell user={authState.user}>
        <div>Page content</div>
      </Shell>,
    );

    const accountButtons = await screen.findAllByRole('button', { name: 'Account menu' });
    await user.click(accountButtons[0]!);
    expect(screen.getByText(/Signed in as/)).toBeTruthy();

    await user.click(screen.getByRole('menuitem', { name: /Sign out/ }));
    await waitFor(() => expect(authState.logout).toHaveBeenCalled());
  });

  it('opens and closes the mobile drawer', async () => {
    const user = userEvent.setup();
    renderPage(
      '/',
      <Shell user={authState.user}>
        <div>Page content</div>
      </Shell>,
    );

    await user.click(await screen.findByRole('button', { name: 'Open menu' }));
    expect(await screen.findByRole('button', { name: 'Close menu' })).toBeTruthy();

    await user.click(screen.getByRole('button', { name: 'Close menu' }));
    await waitFor(() => expect(screen.queryByRole('button', { name: 'Close menu' })).toBeNull());
  });

  it('navigates with links and updates the active heading', async () => {
    const user = userEvent.setup();
    renderPage(
      '/',
      <Shell user={authState.user}>
        <div>Page content</div>
      </Shell>,
    );

    const vehiclesLinks = await screen.findAllByRole('link', { name: /Vehicles/ });
    await user.click(vehiclesLinks[0]!);
    await waitFor(() =>
      expect(screen.getByRole('heading', { level: 1 }).textContent).toContain('Vehicles'),
    );

    const bell = await screen.findByRole('link', { name: 'Notifications (2 unread)' });
    await user.click(bell);
    await waitFor(() =>
      expect(screen.getByRole('heading', { level: 1 }).textContent).toContain('Notifications'),
    );
  });

  it('navigates from the vehicle switcher to the showroom', async () => {
    const user = userEvent.setup();
    renderPage(
      '/',
      <Shell user={authState.user}>
        <div>Page content</div>
      </Shell>,
    );

    await user.click(await screen.findByRole('button', { name: 'Choose vehicle' }));
    await user.click(screen.getByRole('button', { name: /Open 3D showroom/ }));

    await waitFor(() =>
      expect(screen.getByRole('heading', { level: 1 }).textContent).toContain('Showroom'),
    );
  });
});
