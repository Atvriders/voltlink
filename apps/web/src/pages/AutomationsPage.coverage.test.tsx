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

import AutomationsPage from './AutomationsPage';

const automationFixture = {
  id: 'a1',
  name: 'Morning charge alert',
  description: undefined,
  enabled: true,
  vehicleId: null,
  trigger: { type: 'charging_completed', params: {} },
  conditions: [],
  actions: [{ type: 'notify_app', params: { message: 'Charged' } }],
  cooldownSec: 0,
  maxRetries: 1,
  runCount: 5,
  lastRunAt: new Date().toISOString(),
  lastResult: 'success',
};

function mockAutomationApi(automations: unknown[] = [automationFixture]) {
  apiMock.mockImplementation(async (path: string) => {
    if (path === '/api/v1/automations') return automations;
    if (path === '/api/v1/vehicles') return [{ id: 'v1', displayName: 'Aurora' }];
    if (path === '/api/v1/notifications/webhooks') return [];
    if (path.endsWith('/executions'))
      return [
        {
          id: 'e1',
          triggeredAt: new Date().toISOString(),
          triggerEvent: 'charging_completed',
          result: 'success',
          conditionsMet: true,
          actionResults: [{ action: 'notify_app', ok: true, detail: 'Sent' }],
        },
      ];
    if (path.endsWith('/dry-run')) return { result: 'success', actionResults: [] };
    if (path.endsWith('/inbound-webhook'))
      return { url: 'https://example.test/hook', secret: 'secret-value', publicId: 'pub-1' };
    if (path.startsWith('/api/v1/automations/')) return {};
    return {};
  });
}

describe('AutomationsPage', () => {
  beforeEach(() => {
    mockAutomationApi([automationFixture]);
  });

  it('renders the automations list with rule summaries', async () => {
    renderPage('/automations', <AutomationsPage />);

    expect(await screen.findByText('Morning charge alert')).toBeTruthy();
    expect(screen.getByText('Charging completed')).toBeTruthy();
    expect(screen.getByText('1 action')).toBeTruthy();
    expect(screen.getAllByText(/runs/).length).toBeGreaterThan(0);
  });

  it('shows the empty state when there are no automations', async () => {
    mockAutomationApi([]);
    renderPage('/automations', <AutomationsPage />);

    expect(await screen.findByText('No automations yet')).toBeTruthy();
  });

  it('opens the new automation editor', async () => {
    renderPage('/automations', <AutomationsPage />);

    const newButton = screen.getByRole('button', { name: /new automation/i });
    newButton.click();

    expect(await screen.findByPlaceholderText('Charge-complete notification')).toBeTruthy();
    await waitFor(() => {
      expect(screen.getByText('Create automation')).toBeTruthy();
    });
  });
});
