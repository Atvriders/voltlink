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

vi.mock('@voltlink/shared', () => ({
  EVENT_TYPES: ['charge_started', 'charge_completed', 'low_battery'],
}));
vi.mock('../lib/push', () => ({
  pushSupport: () => 'supported',
  enable: vi.fn().mockResolvedValue(undefined),
}));

import NotificationsPage from './NotificationsPage';

const notification = {
  id: 'n1',
  title: 'Charge complete',
  body: 'Aurora finished charging.',
  severity: 'success',
  createdAt: new Date().toISOString(),
  vehicleName: 'Aurora',
  readAt: null,
};

const webhook = {
  id: 'w1',
  name: 'Ops webhook',
  displayHint: 'https://example.com/hooks/voltlink',
  enabled: true,
  lastStatus: 200,
};

describe('NotificationsPage', () => {
  beforeEach(() => {
    apiMock.mockImplementation(
      async (path: string, init?: { method?: string }) => {
        if (path.startsWith('/api/v1/notifications?')) {
          return { items: [notification], total: 1, unread: 1 };
        }
        if (path === '/api/v1/notifications/read-all') return {};
        if (path.endsWith('/read')) return {};
        if (path === '/api/v1/notifications/preferences') {
          if (init?.method === 'PUT') return {};
          return {
            prefs: [
              {
                channel: 'in_app',
                event: 'charge_started',
                severity: 'info',
                enabled: true,
              },
            ],
            channelUrls: {
              ntfyUrl: '',
              gotifyUrl: '',
              discordWebhook: '',
              teamsWebhook: '',
            },
          };
        }
        if (path === '/api/v1/notifications/channel-urls') return {};
        if (path === '/api/v1/notifications/webhooks') {
          if (init?.method === 'POST') return { secret: 'whsec_created_once' };
          return [webhook];
        }
        if (path.startsWith('/api/v1/notifications/webhooks/')) {
          if (path.endsWith('/rotate-secret')) return { secret: 'whsec_rotated' };
          return {};
        }
        return {};
      },
    );
  });

  it('renders the inbox with notification fixtures', async () => {
    renderPage('/notifications', <NotificationsPage />);

    await waitFor(() => expect(screen.getByText('Charge complete')).toBeTruthy());
    expect(screen.getByText('1 unread')).toBeTruthy();
    expect(screen.getByText('Aurora finished charging.')).toBeTruthy();
    expect(screen.getByText('Aurora')).toBeTruthy();
  });

  it('renders the empty inbox state', async () => {
    apiMock.mockImplementation(async (path: string) => {
      if (path.startsWith('/api/v1/notifications?')) {
        return { items: [], total: 0, unread: 0 };
      }
      return {};
    });

    renderPage('/notifications', <NotificationsPage />);

    await waitFor(() => expect(screen.getByText(/all caught up/i)).toBeTruthy());
    expect(screen.queryByText('Charge complete')).toBeNull();
  });

  it('shows notification preferences when the preferences tab is selected', async () => {
    renderPage('/notifications', <NotificationsPage />);
    await waitFor(() => expect(screen.getByText('Charge complete')).toBeTruthy());

    screen.getByRole('tab', { name: 'preferences' }).click();

    await waitFor(() => expect(screen.getByText('Event preferences')).toBeTruthy());
    expect(screen.getByText('External channels')).toBeTruthy();
    expect(screen.getByLabelText('charge_started via in_app')).toBeTruthy();
    expect(screen.getByText('Enable push notifications')).toBeTruthy();
  });

  it('shows configured webhooks on the webhooks tab', async () => {
    renderPage('/notifications', <NotificationsPage />);
    await waitFor(() => expect(screen.getByText('Charge complete')).toBeTruthy());

    screen.getByRole('tab', { name: 'webhooks' }).click();

    await waitFor(() => expect(screen.getByText('Ops webhook')).toBeTruthy());
    expect(screen.getByText('HTTP 200')).toBeTruthy();
    expect(screen.getByText('Add webhook')).toBeTruthy();
  });
});
