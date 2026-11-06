// Page render test (coverage harness).
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { render, screen, waitFor, cleanup, fireEvent } from '@testing-library/react';

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
import { SelectedVehicleProvider } from '../lib/vehicleSelection';
import { within } from '@testing-library/react';
import { Shell } from './Shell';

vi.mock('../lib/push', () => ({
  prepare: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('../lib/realtime', () => ({
  realtimeStart: vi.fn(),
  realtimeStop: vi.fn(),
}));

vi.mock('../auth/AuthContext', () => ({
  useAuth: () => authState,
  setTheme: vi.fn(),
  THEMES: [
    { id: 'voltlink-dark', name: 'VoltLink Dark' },
    { id: 'voltlink-light', name: 'VoltLink Light' },
  ],
}));

const richVehicle = {
  ...vehicle,
  groupIds: ['g1'],
  model: 'Aurora',
  make: 'Volt',
  labels: ['family'],
};

const shellUser = authState.user as unknown as Parameters<typeof Shell>[0]['user'];

describe('Shell page', () => {
  beforeEach(() => {
    window.localStorage.clear();
    authState.logout.mockClear();
    apiMock.mockClear();

    const baseImpl = apiMock.getMockImplementation();
    apiMock.mockImplementation(async (path: string, init?: unknown) => {
      if (path === '/api/v1/notifications?pageSize=1') return { unread: 4 };
      if (path === '/api/v1/fleet/groups') return [{ id: 'g1', name: 'Team' }];
      if (path === '/api/v1/vehicles') return [richVehicle];
      if (path === `/api/v1/vehicles/${richVehicle.id}`) return richVehicle;
      if (path === '/api/v1/users/favorites') return {};
      if (path === '/api/v1/users/settings') return {};
      return baseImpl ? baseImpl(path, init) : {};
    });
  });

  const renderShell = () =>
    render(
      <QueryClientProvider
        client={
          new QueryClient({ defaultOptions: { queries: { retry: false } } })
        }
      >
        <MemoryRouter initialEntries={['/']}>
          <SelectedVehicleProvider userId={shellUser!.id}>
            <Routes>
              <Route
                path="*"
                element={
                  <Shell user={shellUser}>
                    <div>Page body</div>
                  </Shell>
                }
              />
            </Routes>
          </SelectedVehicleProvider>
        </MemoryRouter>
      </QueryClientProvider>,
    );

  it('renders navigation, unread notification bell, and vehicle switcher', async () => {
    renderShell();

    expect(screen.getByRole('navigation', { name: 'Main navigation' })).toBeTruthy();
    expect(screen.getAllByRole('link', { name: 'Overview' }).length).toBeGreaterThan(0);
    expect(
      await screen.findByRole('link', { name: 'Notifications (4 unread)' }),
    ).toBeTruthy();
    expect(
      await screen.findByRole('button', { name: /Choose vehicle|Vehicle: Aurora/ }),
    ).toBeTruthy();
    expect(screen.getByText('Page body')).toBeTruthy();
  });

  it('navigates between shell sections from the sidebar', async () => {
    const user = userEvent.setup();
    renderShell();

    await user.click(screen.getByRole('link', { name: 'Charging' }));

    expect(await screen.findByRole('heading', { name: 'Charging' })).toBeTruthy();
  });

  it('navigates to notifications from the unread bell', async () => {
    const user = userEvent.setup();
    renderShell();

    const bell = await screen.findByRole('link', { name: 'Notifications (4 unread)' });
    await user.click(bell);

    expect(await screen.findByRole('heading', { name: 'Notifications' })).toBeTruthy();
  });

  it('opens the vehicle switcher, shows groups, and selects a vehicle', async () => {
    const user = userEvent.setup();
    renderShell();

    await user.click(
      await screen.findByRole('button', { name: /Choose vehicle|Vehicle: Aurora/ }),
    );

    const menu = await screen.findByRole('menu');
    expect(within(menu).getByPlaceholderText('Search vehicles')).toBeTruthy();
    expect(within(menu).getByText('Team')).toBeTruthy();

    await user.click(within(menu).getAllByText('Aurora')[0]!);

    await waitFor(() => expect(screen.queryByRole('menu')).toBeNull());
    expect(screen.getByText('Page body')).toBeTruthy();
  });

  it('keeps mobile header controls inside the viewport (R2-36)', async () => {
    renderShell();
    await screen.findByRole('button', { name: /Choose vehicle|Vehicle: Aurora/ });
    // The standalone Settings link and Theme menu collapse into the account
    // menu below lg, so the phone header never overflows.
    const settingsLink = screen
      .getAllByRole('link', { name: 'Settings' })
      .find((a) => a.getAttribute('aria-label') === 'Settings')!;
    expect(settingsLink.closest('div.hidden.lg\\:block')).toBeTruthy();
    const themeButton = screen.getByRole('button', { name: 'Theme' });
    expect(themeButton.closest('div.hidden.lg\\:block')).toBeTruthy();
    // The logo subtitle is hidden below sm.
    const subtitles = screen.getAllByText('Connected Vehicle Platform');
    expect(subtitles.length).toBeGreaterThan(0);
    for (const subtitle of subtitles) {
      expect(subtitle.className).toContain('hidden');
      expect(subtitle.className).toContain('sm:block');
    }
  });

  it('keeps the switcher and shows a no-match message for an empty search (R2-38)', async () => {
    const user = userEvent.setup();
    renderShell();

    await user.click(
      await screen.findByRole('button', { name: /Choose vehicle|Vehicle: Aurora/ }),
    );

    const menu = await screen.findByRole('menu');
    const search = within(menu).getByPlaceholderText('Search vehicles');

    fireEvent.input(search, { target: { value: 'zzz' } });
    // The switcher stays, and the menu explains there are no matches.
    expect(await within(menu).findByText('No vehicles match.')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Choose vehicle' })).toBeTruthy();
  });

  it('toggles a favorite through the API', async () => {
    const user = userEvent.setup();
    renderShell();

    await user.click(
      await screen.findByRole('button', { name: /Choose vehicle|Vehicle: Aurora/ }),
    );

    const menu = await screen.findByRole('menu');
    const favoriteButtons = await within(menu).findAllByRole('button', {
      name: 'Add Aurora to favorites',
    });
    await user.click(favoriteButtons[0]!);

    await waitFor(() =>
      expect(apiMock).toHaveBeenCalledWith(
        '/api/v1/users/favorites',
        expect.objectContaining({
          method: 'PUT',
          body: { vehicleIds: ['v1'] },
        }),
      ),
    );

    // Toggling again removes the favorite.
    const menu2 = await screen.findByRole('menu');
    const removeButtons = await within(menu2).findAllByRole('button', {
      name: 'Remove Aurora from favorites',
    });
    expect(removeButtons.length).toBeGreaterThan(0);
  });

  it('persists theme changes from the theme menu', async () => {
    const user = userEvent.setup();
    renderShell();

    await user.click(screen.getByRole('button', { name: 'Theme' }));
    await user.click(await screen.findByRole('menuitem', { name: 'VoltLink Light' }));

    await waitFor(() =>
      expect(apiMock).toHaveBeenCalledWith(
        '/api/v1/users/settings',
        expect.objectContaining({
          method: 'PATCH',
          body: { theme: 'voltlink-light' },
        }),
      ),
    );
  });

  it('opens the account menu and signs out', async () => {
    const user = userEvent.setup();
    renderShell();

    const accountButtons = screen.getAllByRole('button', { name: 'Account menu' });
    await user.click(accountButtons[0]!);

    expect(await screen.findByText(/Signed in as/)).toBeTruthy();
    await user.click(screen.getByRole('menuitem', { name: /Sign out/ }));

    await waitFor(() => expect(authState.logout).toHaveBeenCalled());
  });

  it('opens and closes the mobile navigation drawer', async () => {
    const user = userEvent.setup();
    renderShell();

    await user.click(screen.getByRole('button', { name: 'Open menu' }));

    expect(await screen.findByRole('button', { name: 'Close menu' })).toBeTruthy();
    expect(screen.getByRole('navigation', { name: 'Mobile navigation' })).toBeTruthy();

    await user.click(screen.getByRole('button', { name: 'Close menu' }));

    await waitFor(() =>
      expect(screen.queryByRole('button', { name: 'Close menu' })).toBeNull(),
    );
  });
});
