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
import { EVENT_TYPES } from '@voltlink/shared';
import NotificationsPage from './NotificationsPage';

const { pushEnableMock } = vi.hoisted(() => ({
  pushEnableMock: vi.fn().mockResolvedValue(undefined),
}));
vi.mock('../lib/push', () => ({
  pushSupport: () => 'supported',
  enable: pushEnableMock,
}));

const firstEvent = EVENT_TYPES[0];

const notificationFixtures = () => ({
  items: [
    {
      id: 'n1',
      title: 'Charging complete',
      body: 'Aurora finished charging',
      severity: 'success',
      createdAt: new Date('2024-05-01T10:00:00Z').toISOString(),
      vehicleName: 'Aurora',
      readAt: null,
    },
    {
      id: 'n2',
      title: 'Lock reminder',
      body: 'Aurora is unlocked',
      severity: 'warning',
      createdAt: new Date('2024-05-02T10:00:00Z').toISOString(),
      vehicleName: 'Aurora',
      readAt: new Date('2024-05-02T11:00:00Z').toISOString(),
    },
  ],
  total: 2,
  unread: 1,
});

const webhookFixtures = () => [
  {
    id: 'w1',
    name: 'Slack relay',
    displayHint: 'https://hooks.example.test/slack',
    enabled: true,
    lastStatus: 200,
  },
  {
    id: 'w2',
    name: 'Backup hook',
    displayHint: 'https://hooks.example.test/backup',
    enabled: false,
  },
];

const prefsFixtures = () => ({
  prefs: [{ channel: 'email', event: firstEvent, severity: 'info', enabled: true }],
  channelUrls: { ntfyUrl: '', gotifyUrl: '', discordWebhook: '', teamsWebhook: '' },
});

function apiImpl(path: string, opts?: { method?: string; body?: unknown }) {
  const method = opts?.method ?? 'GET';
  if (path === '/api/v1/notifications/read-all' && method === 'POST') return Promise.resolve({});
  if (/^\/api\/v1\/notifications\/[^/]+\/read$/.test(path) && method === 'POST')
    return Promise.resolve({});
  if (/^\/api\/v1\/notifications\/webhooks\/[^/]+\/rotate-secret$/.test(path) && method === 'POST')
    return Promise.resolve({ secret: 'whsec_rotated' });
  if (/^\/api\/v1\/notifications\/webhooks\/[^/]+$/.test(path) && method === 'PATCH')
    return Promise.resolve({});
  if (/^\/api\/v1\/notifications\/webhooks\/[^/]+$/.test(path) && method === 'DELETE')
    return Promise.resolve({});
  if (path === '/api/v1/notifications/webhooks' && method === 'POST')
    return Promise.resolve({ secret: 'whsec_created' });
  if (path === '/api/v1/notifications/webhooks') return Promise.resolve(webhookFixtures());
  if (path === '/api/v1/notifications/preferences' && method === 'PUT') return Promise.resolve({});
  if (path === '/api/v1/notifications/preferences') return Promise.resolve(prefsFixtures());
  if (path === '/api/v1/notifications/channel-urls') return Promise.resolve({});
  if (path.startsWith('/api/v1/notifications')) return Promise.resolve(notificationFixtures());
  return Promise.resolve({});
}

describe('NotificationsPage', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    apiMock.mockImplementation(apiImpl);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('renders the inbox with notifications and an unread badge', async () => {
    renderPage('/notifications', <NotificationsPage />);
    expect(await screen.findByText('Charging complete')).toBeTruthy();
    expect(screen.getByText('Lock reminder')).toBeTruthy();
    expect(screen.getByText(/1 unread/)).toBeTruthy();
    expect(screen.getByLabelText('unread')).toBeTruthy();
  });

  it('marks a single unread notification as read', async () => {
    const user = userEvent.setup();
    renderPage('/notifications', <NotificationsPage />);
    const item = await screen.findByText('Charging complete');
    await user.click(item);
    await waitFor(() =>
      expect(apiMock).toHaveBeenCalledWith(
        '/api/v1/notifications/n1/read',
        expect.objectContaining({ method: 'POST' }),
      ),
    );
  });

  it('marks all notifications as read', async () => {
    const user = userEvent.setup();
    renderPage('/notifications', <NotificationsPage />);
    await screen.findByText('Charging complete');
    await user.click(screen.getByRole('button', { name: /mark all read/i }));
    await waitFor(() =>
      expect(apiMock).toHaveBeenCalledWith(
        '/api/v1/notifications/read-all',
        expect.objectContaining({ method: 'POST' }),
      ),
    );
  });

  it('shows the empty state when there are no notifications', async () => {
    apiMock.mockImplementation(async (path: string) =>
      path.startsWith('/api/v1/notifications?') ? { items: [], total: 0, unread: 0 } : {},
    );
    renderPage('/notifications', <NotificationsPage />);
    expect(await screen.findByText("You're all caught up")).toBeTruthy();
  });

  it('toggles an event preference checkbox', async () => {
    const user = userEvent.setup();
    renderPage('/notifications', <NotificationsPage />);
    await user.click(screen.getByRole('tab', { name: /preferences/i }));
    const checkboxes = await screen.findAllByRole('checkbox');
    const emailCheckbox = checkboxes[1] as HTMLInputElement;
    expect(emailCheckbox.checked).toBe(true);
    await user.click(emailCheckbox);
    await waitFor(() =>
      expect(apiMock).toHaveBeenCalledWith(
        '/api/v1/notifications/preferences',
        expect.objectContaining({ method: 'PUT' }),
      ),
    );
  });

  it('saves external channel URLs', async () => {
    const user = userEvent.setup();
    renderPage('/notifications', <NotificationsPage />);
    await user.click(screen.getByRole('tab', { name: /preferences/i }));
    const inputs = await screen.findAllByPlaceholderText('https://…');
    await user.type(inputs[0]!, 'https://ntfy.example.test/topic');
    await user.click(screen.getByRole('button', { name: /save channels/i }));
    await waitFor(() =>
      expect(apiMock).toHaveBeenCalledWith(
        '/api/v1/notifications/channel-urls',
        expect.objectContaining({ method: 'PUT' }),
      ),
    );
  });

  it('enables browser push notifications', async () => {
    const user = userEvent.setup();
    renderPage('/notifications', <NotificationsPage />);
    await user.click(screen.getByRole('tab', { name: /preferences/i }));
    await user.click(await screen.findByRole('button', { name: /enable push notifications/i }));
    // web-9: the confirmation alone is weak — the enable() call must have
    // happened (the subscription PUT lives in lib/push) and the success
    // message is the page's own outcome, not a fixture.
    expect(pushEnableMock).toHaveBeenCalledTimes(1);
    expect(await screen.findByText('Push notifications enabled.')).toBeTruthy();
  });

  it('toggles a webhook enabled state', async () => {
    const user = userEvent.setup();
    renderPage('/notifications', <NotificationsPage />);
    await user.click(screen.getByRole('tab', { name: /webhooks/i }));
    const row = (await screen.findByText('Slack relay')).closest('li') as HTMLElement;
    await user.click(within(row).getByRole('button', { name: /disable/i }));
    await waitFor(() =>
      expect(apiMock).toHaveBeenCalledWith(
        '/api/v1/notifications/webhooks/w1',
        expect.objectContaining({ method: 'PATCH' }),
      ),
    );
  });

  it('creates a webhook through the modal and shows the generated secret', async () => {
    const user = userEvent.setup();
    renderPage('/notifications', <NotificationsPage />);
    await user.click(screen.getByRole('tab', { name: /webhooks/i }));
    await user.click(await screen.findByRole('button', { name: /add webhook/i }));
    const textboxes = screen.getAllByRole('textbox');
    await user.type(textboxes[0]!, 'New relay');
    await user.type(textboxes[1]!, 'https://hooks.example.test/new');
    await user.click(screen.getByRole('button', { name: 'Create' }));
    await waitFor(() =>
      expect(apiMock).toHaveBeenCalledWith(
        '/api/v1/notifications/webhooks',
        expect.objectContaining({ method: 'POST' }),
      ),
    );
    expect(await screen.findByText('whsec_created')).toBeTruthy();
  });

  it('rotates a webhook secret and then deletes the webhook', async () => {
    vi.stubGlobal('confirm', vi.fn().mockReturnValue(true));
    const user = userEvent.setup();
    renderPage('/notifications', <NotificationsPage />);
    await user.click(screen.getByRole('tab', { name: /webhooks/i }));

    const row = (await screen.findByText('Slack relay')).closest('li') as HTMLElement;
    await user.click(within(row).getByRole('button', { name: /rotate secret/i }));
    await waitFor(() =>
      expect(apiMock).toHaveBeenCalledWith(
        '/api/v1/notifications/webhooks/w1/rotate-secret',
        expect.objectContaining({ method: 'POST' }),
      ),
    );

    const refreshed = (await screen.findByText('Slack relay')).closest('li') as HTMLElement;
    const rowButtons = within(refreshed).getAllByRole('button');
    await user.click(rowButtons[rowButtons.length - 1]!);
    await waitFor(() =>
      expect(apiMock).toHaveBeenCalledWith(
        '/api/v1/notifications/webhooks/w1',
        expect.objectContaining({ method: 'DELETE' }),
      ),
    );
  });
});
