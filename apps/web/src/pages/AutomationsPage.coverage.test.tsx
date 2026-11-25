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

import type * as React from 'react';
import userEvent from '@testing-library/user-event';
import { fireEvent } from '@testing-library/react';
import AutomationsPage from './AutomationsPage';

const automationFixture = {
  id: 'a1',
  name: 'Hook',
  description: undefined as string | undefined,
  enabled: true,
  vehicleId: null,
  trigger: { type: 'webhook', params: {} },
  conditions: [],
  actions: [{ type: 'notify_app', params: { message: 'Hello' } }],
  cooldownSec: 0,
  maxRetries: 1,
  lastResult: 'success',
  runCount: 3,
  lastRunAt: new Date('2024-01-01T00:00:00Z').toISOString(),
};

const executionFixtures = [
  {
    id: 'e1',
    triggeredAt: new Date('2024-01-02T03:04:05Z').toISOString(),
    triggerEvent: 'charging_completed',
    result: 'success',
    conditionsMet: true,
    actionResults: [{ action: 'notify_app', ok: true, detail: 'notified' }],
    errorMessage: null,
  },
  {
    id: 'e2',
    triggeredAt: new Date('2024-01-03T03:04:05Z').toISOString(),
    triggerEvent: 'door_open',
    result: 'skipped',
    conditionsMet: false,
    actionResults: [],
    errorMessage: null,
  },
];

describe('AutomationsPage', () => {
  beforeEach(() => {
    vi.stubGlobal(
      'confirm',
      vi.fn(() => true),
    );
    apiMock.mockClear();
    // web-9: stateful mock — the list refetch after a PATCH must reflect the
    // patched enabled flag, or the UI-flip assertion would be a fixture lie.
    let fixtureEnabled = true;
    apiMock.mockImplementation(
      async (path: string, options?: { method?: string; body?: unknown }) => {
        const method = options?.method ?? 'GET';
        if (path === '/api/v1/automations' && method === 'POST') {
          return { ...automationFixture, id: 'a2', name: 'Created' };
        }
        if (path === '/api/v1/automations')
          return [{ ...automationFixture, enabled: fixtureEnabled }];
        if (path === '/api/v1/vehicles') return [{ id: 'v1', displayName: 'Aurora' }];
        if (path === '/api/v1/notifications/webhooks') {
          return [{ id: 'wh1', name: 'Ops endpoint', displayHint: 'ops.example.test' }];
        }
        if (path === `/api/v1/automations/${automationFixture.id}/executions`) {
          return executionFixtures;
        }
        if (path === `/api/v1/automations/${automationFixture.id}/dry-run`) {
          return {
            result: 'success',
            actionResults: [{ action: 'notify_app', ok: true, detail: 'would notify' }],
          };
        }
        if (
          path === `/api/v1/automations/${automationFixture.id}/inbound-webhook` &&
          method === 'POST'
        ) {
          return {
            url: 'https://example.test/hook',
            secret: 'supersecret',
            publicId: 'pub1',
          };
        }
        if (
          path === `/api/v1/automations/${automationFixture.id}/inbound-webhook` &&
          method === 'DELETE'
        ) {
          return { ok: true };
        }
        if (path === `/api/v1/automations/${automationFixture.id}` && method === 'PATCH') {
          fixtureEnabled =
            (options?.body as { enabled?: boolean } | undefined)?.enabled ?? fixtureEnabled;
          return { ...automationFixture, enabled: fixtureEnabled };
        }
        if (path === `/api/v1/automations/${automationFixture.id}` && method === 'DELETE') {
          return { ok: true };
        }
        return {};
      },
    );
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('renders automation cards with trigger, action count, scope, and run stats', async () => {
    renderPage('/automations', <AutomationsPage />);

    expect(await screen.findByText('Hook')).toBeInTheDocument();
    expect(screen.getByText('Incoming webhook')).toBeInTheDocument();
    expect(screen.getByText('1 action')).toBeInTheDocument();
    expect(screen.getByText('all vehicles')).toBeInTheDocument();
    expect(screen.getByText(/3 runs/)).toBeInTheDocument();
  });

  it('toggles an automation enabled state', async () => {
    const user = userEvent.setup();
    renderPage('/automations', <AutomationsPage />);

    await screen.findByText('Hook');
    await user.click(screen.getByRole('button', { name: /disable/i }));

    // web-9 (W15): the PATCH body must carry the flipped enabled flag, and
    // the row must show the opposite action afterwards.
    await waitFor(() => {
      expect(apiMock).toHaveBeenCalledWith(
        `/api/v1/automations/${automationFixture.id}`,
        expect.objectContaining({
          method: 'PATCH',
          body: expect.objectContaining({ enabled: false }),
        }),
      );
    });
    expect(await screen.findByRole('button', { name: /enable/i })).toBeTruthy();
  });

  it('deletes an automation after confirmation', async () => {
    const user = userEvent.setup();
    renderPage('/automations', <AutomationsPage />);

    await screen.findByText('Hook');
    await user.click(screen.getByRole('button', { name: 'Delete Hook' }));

    await waitFor(() => {
      expect(apiMock).toHaveBeenCalledWith(
        `/api/v1/automations/${automationFixture.id}`,
        expect.objectContaining({ method: 'DELETE' }),
      );
    });
  });

  it('creates a new automation from the editor form', async () => {
    const user = userEvent.setup();
    renderPage('/automations', <AutomationsPage />);

    await screen.findByText('Hook');
    await user.click(screen.getByRole('button', { name: /new automation/i }));

    const nameInput = await screen.findByPlaceholderText('Charge-complete notification');
    await user.type(nameInput, 'Nightly check');

    const selects = screen.getAllByRole('combobox');
    fireEvent.change(selects[0]!, { target: { value: 'battery_threshold' } });
    fireEvent.change(selects[2]!, { target: { value: 'webhook' } });

    expect(
      await screen.findByText(/"Nightly check": when battery threshold, webhook\./),
    ).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: /create automation/i }));

    await waitFor(() => {
      expect(apiMock).toHaveBeenCalledWith(
        '/api/v1/automations',
        expect.objectContaining({
          method: 'POST',
          body: expect.objectContaining({
            name: 'Nightly check',
            trigger: expect.objectContaining({ type: 'battery_threshold' }),
            actions: expect.arrayContaining([expect.objectContaining({ type: 'webhook' })]),
          }),
        }),
      );
    });

    await waitFor(() => {
      expect(screen.queryByPlaceholderText('Charge-complete notification')).not.toBeInTheDocument();
    });
  });

  it('runs a dry run and renders the result details', async () => {
    const user = userEvent.setup();
    renderPage('/automations', <AutomationsPage />);

    await screen.findByText('Hook');
    await user.click(screen.getByRole('button', { name: /dry run/i }));

    await screen.findByRole('button', { name: /run dry run/i });
    await user.click(screen.getByRole('button', { name: /run dry run/i }));

    await waitFor(() => {
      expect(apiMock).toHaveBeenCalledWith(
        `/api/v1/automations/${automationFixture.id}/dry-run`,
        expect.objectContaining({ method: 'POST' }),
      );
    });

    expect(await screen.findByText('Dry run result: success')).toBeInTheDocument();
    expect(screen.getByText(/would notify/)).toBeInTheDocument();
  });

  it('opens execution history and renders execution rows', async () => {
    const user = userEvent.setup();
    renderPage('/automations', <AutomationsPage />);

    await screen.findByText('Hook');
    await user.click(screen.getByRole('button', { name: /history/i }));

    expect(await screen.findByText(/Execution history — Hook/)).toBeInTheDocument();
    expect(await screen.findByText('Conditions not met — skipped.')).toBeInTheDocument();
    expect(screen.getByText(/notify_app: notified/)).toBeInTheDocument();
  });

  it('creates and deletes an inbound webhook', async () => {
    const user = userEvent.setup();
    renderPage('/automations', <AutomationsPage />);

    await screen.findByText('Hook');
    await user.click(screen.getByRole('button', { name: /inbound url/i }));

    expect(await screen.findByText(/Inbound webhook — Hook/)).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: /create inbound webhook/i }));

    await waitFor(() => {
      expect(apiMock).toHaveBeenCalledWith(
        `/api/v1/automations/${automationFixture.id}/inbound-webhook`,
        expect.objectContaining({ method: 'POST' }),
      );
    });

    expect(await screen.findByDisplayValue('https://example.test/hook')).toBeInTheDocument();
    expect(screen.getByText('supersecret')).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'Delete' }));

    await waitFor(() => {
      expect(apiMock).toHaveBeenCalledWith(
        `/api/v1/automations/${automationFixture.id}/inbound-webhook`,
        expect.objectContaining({ method: 'DELETE' }),
      );
    });

    expect(
      await screen.findByRole('button', { name: /create inbound webhook/i }),
    ).toBeInTheDocument();
  });

  it('closes the new automation editor without saving', async () => {
    const user = userEvent.setup();
    renderPage('/automations', <AutomationsPage />);

    await screen.findByText('Hook');
    await user.click(screen.getByRole('button', { name: /new automation/i }));
    await screen.findByPlaceholderText('Charge-complete notification');

    await user.click(screen.getByRole('button', { name: /cancel/i }));

    await waitFor(() => {
      expect(screen.queryByPlaceholderText('Charge-complete notification')).not.toBeInTheDocument();
    });
    expect(apiMock).not.toHaveBeenCalledWith(
      '/api/v1/automations',
      expect.objectContaining({ method: 'POST' }),
    );
  });
});
