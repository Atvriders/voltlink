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
import { fireEvent } from '@testing-library/react';
import LiveVehiclePage from './LiveVehiclePage';

vi.mock('../webgl/VehicleViewer', () => ({
  default: () => <div data-testid="vehicle-viewer" />,
}));

const auditEvents = [
  {
    id: 'e1',
    event: 'queued',
    actor: 'u1',
    detail: 'Command accepted',
    createdAt: '2024-01-01T00:00:01.000Z',
  },
];

const commandItems = [
  {
    id: 'cmd-activity',
    vehicleId: 'v1',
    type: 'set_temperature',
    status: 'queued',
    createdAt: '2024-01-01T00:00:00.000Z',
    params: {},
    idempotencyKey: 'key-activity',
    updatedAt: '2024-01-01T00:00:01.000Z',
  },
];

const postedCommand = {
  id: 'cmd-posted',
  vehicleId: 'v1',
  type: 'honk_horn',
  status: 'confirmed',
  createdAt: '2024-01-01T00:00:00.000Z',
  params: {},
  idempotencyKey: 'key-posted',
  updatedAt: '2024-01-01T00:00:01.000Z',
};

let commandsForTest = commandItems;
let vehiclesOverride: typeof vehicle | null = null;
let commandPostError: Error | null = null;

function renderVehiclePage(path = '/vehicles/v1') {
  return renderPage(
    path,
    <Routes>
      <Route path="/vehicles/:id" element={<LiveVehiclePage />} />
    </Routes>,
  );
}

beforeEach(() => {
  commandsForTest = commandItems;
  vehiclesOverride = null;
  commandPostError = null;

  if (!globalThis.crypto) {
    vi.stubGlobal('crypto', { randomUUID: () => 'test-uuid' });
  } else if (typeof globalThis.crypto.randomUUID !== 'function') {
    Object.defineProperty(globalThis.crypto, 'randomUUID', {
      value: () => 'test-uuid',
      configurable: true,
    });
  }

  if (!window.matchMedia) {
    Object.defineProperty(window, 'matchMedia', {
      writable: true,
      value: vi.fn().mockImplementation((query: string) => ({
        matches: false,
        media: query,
        onchange: null,
        addListener: vi.fn(),
        removeListener: vi.fn(),
        addEventListener: vi.fn(),
        removeEventListener: vi.fn(),
        dispatchEvent: vi.fn(),
      })),
    });
  }

  const original = apiMock.getMockImplementation();

  apiMock.mockImplementation(async (path: string, init?: { method?: string; body?: unknown }) => {
    if (vehiclesOverride && path === '/api/v1/vehicles') return [vehiclesOverride];

    if (path === '/api/v1/commands?vehicleId=v1&pageSize=8') {
      return { items: commandsForTest };
    }

    if (path === '/api/v1/commands' && init?.method === 'POST') {
      if (commandPostError) throw commandPostError;
      const body = init.body as { type?: string } | undefined;
      const type = body?.type ?? 'honk_horn';
      return { ...postedCommand, id: `cmd-${type}`, type, status: 'confirmed' };
    }

    if (path.startsWith('/api/v1/commands/')) {
      const id = path.split('/').pop() ?? '';
      const known = commandItems.find((c) => c.id === id);
      const type = known?.type ?? (id.startsWith('cmd-') ? id.slice(4) : 'honk_horn');
      return { ...postedCommand, id, type, status: 'confirmed', events: auditEvents };
    }

    if (path === `/api/v1/vehicles/${vehicle.id}/refresh`) return { ok: true };

    return original ? original(path, init) : {};
  });
});

describe('LiveVehiclePage', () => {
  it('renders live vehicle telemetry, changes preset, and refreshes', async () => {
    const user = userEvent.setup();
    renderVehiclePage();

    expect(await screen.findByRole('heading', { name: 'Aurora' })).toBeTruthy();
    expect(screen.getByText('Battery & charging')).toBeTruthy();
    expect(screen.getByText('72%')).toBeTruthy();

    const preset = screen.getByLabelText('Graphics preset') as HTMLSelectElement;
    fireEvent.change(preset, { target: { value: 'ultra' } });
    expect(preset.value).toBe('ultra');

    await user.click(screen.getByRole('button', { name: /refresh/i }));

    await waitFor(() =>
      expect(apiMock).toHaveBeenCalledWith('/api/v1/vehicles/v1/refresh', { method: 'POST' }),
    );
  });

  it('opens the command lifecycle modal from command activity', async () => {
    const user = userEvent.setup();
    renderVehiclePage();

    const activityButton = await screen.findByRole('button', {
      name: /set[_ ]temperature/i,
    });
    await user.click(activityButton);

    expect(await screen.findByText('Audit trail')).toBeTruthy();
    expect(screen.getByText(/Provider accepted/)).toBeTruthy();
    expect(screen.getByText(/Vehicle state confirms the command completed/)).toBeTruthy();
    expect(apiMock).toHaveBeenCalledWith('/api/v1/commands/cmd-activity');
  });

  it('issues a honk command and shows confirmation', async () => {
    const user = userEvent.setup();
    renderVehiclePage();

    await user.click(await screen.findByRole('button', { name: /honk horn/i }));

    await waitFor(() =>
      expect(apiMock).toHaveBeenCalledWith(
        '/api/v1/commands',
        expect.objectContaining({
          method: 'POST',
          body: expect.objectContaining({ vehicleId: 'v1', type: 'honk_horn' }),
        }),
      ),
    );

    expect(await screen.findByText('Vehicle state confirms the command completed.')).toBeTruthy();
  });

  it('issues a lock command and shows confirmation', async () => {
    const user = userEvent.setup();
    renderVehiclePage();

    await user.click(await screen.findByRole('button', { name: /lock/i }));

    await waitFor(() =>
      expect(apiMock).toHaveBeenCalledWith(
        '/api/v1/commands',
        expect.objectContaining({
          method: 'POST',
          body: expect.objectContaining({ vehicleId: 'v1', type: 'lock' }),
        }),
      ),
    );

    expect(await screen.findByText('Vehicle state confirms the command completed.')).toBeTruthy();
  });

  it('issues a wake command and shows confirmation', async () => {
    const user = userEvent.setup();
    renderVehiclePage();

    await user.click(await screen.findByRole('button', { name: /wake/i }));

    await waitFor(() =>
      expect(apiMock).toHaveBeenCalledWith(
        '/api/v1/commands',
        expect.objectContaining({
          method: 'POST',
          body: expect.objectContaining({ vehicleId: 'v1', type: 'wake' }),
        }),
      ),
    );

    expect(await screen.findByText('Vehicle state confirms the command completed.')).toBeTruthy();
  });

  it('opens a parameter modal for a configurable command and submits it', async () => {
    const user = userEvent.setup();
    commandsForTest = [];
    vehiclesOverride = {
      ...vehicle,
      capabilities: [...vehicle.capabilities, 'set_charge_limit', 'charging'],
    };

    renderVehiclePage();

    await user.click(await screen.findByRole('button', { name: /charge limit/i }));

    const input = await screen.findByRole('spinbutton');
    fireEvent.change(input, { target: { value: '80' } });

    await user.click(screen.getByRole('button', { name: /set & send/i }));

    await waitFor(() =>
      expect(apiMock).toHaveBeenCalledWith(
        '/api/v1/commands',
        expect.objectContaining({
          method: 'POST',
          body: expect.objectContaining({ vehicleId: 'v1', type: 'set_charge_limit' }),
        }),
      ),
    );

    expect(await screen.findByText('Vehicle state confirms the command completed.')).toBeTruthy();
  });

  it('shows an error when a command fails', async () => {
    const user = userEvent.setup();
    commandPostError = new Error('boom');
    renderVehiclePage();

    await user.click(await screen.findByRole('button', { name: /honk horn/i }));

    const alert = await screen.findByRole('alert');
    expect(alert.textContent).toContain('Command failed.');

    await waitFor(() =>
      expect(apiMock).toHaveBeenCalledWith(
        '/api/v1/commands',
        expect.objectContaining({ method: 'POST' }),
      ),
    );
  });

  it('shows a not-found alert for an unknown vehicle id', async () => {
    renderVehiclePage('/vehicles/missing');

    const alert = await screen.findByRole('alert');
    expect(alert.textContent).toContain('Vehicle not found.');
    expect(screen.getByRole('link', { name: /back to overview/i })).toBeTruthy();
  });
});
