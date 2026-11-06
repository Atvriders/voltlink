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

import LiveVehiclePage from './LiveVehiclePage';
import { fireEvent } from '@testing-library/react';

vi.mock('react-router-dom', async () => {
  const actual = await vi.importActual<typeof import('react-router-dom')>('react-router-dom');
  return {
    ...actual,
    useParams: () => ({ id: 'v1' }),
  };
});

vi.mock('../webgl/VehicleViewer', () => ({
  default: () => null,
}));

const liveState = {
  ...vehicle.state,
  fetchedAt: new Date().toISOString(),
  chargeLimitPct: 80,
  chargePowerKw: 11,
  chargeCurrentA: 16,
  timeToFullChargeMin: 42,
  batteryCapacityKwh: 75,
  climateOn: true,
  insideTempC: 21,
  driverTempSettingC: 22,
  defrostOn: false,
  seatHeaterLevel: 2,
  trunkOpen: false,
  frunkOpen: false,
  windowsOpen: false,
  sentryMode: false,
  alarmState: 'disarmed',
  valetMode: false,
  softwareVersion: '2024.1',
  headingDeg: 90,
  doors: { frontLeft: false, frontRight: false, rearLeft: false, rearRight: false },
  tirePressureKpa: { frontLeft: 240, frontRight: 241, rearLeft: 238, rearRight: 239 },
};

const liveVehicle = { ...vehicle, state: liveState };

const commandFixture = {
  id: 'cmd-1',
  vehicleId: 'v1',
  type: 'lock',
  status: 'confirmed',
  createdAt: new Date().toISOString(),
  params: {},
};

const commandDetail = {
  ...commandFixture,
  events: [
    {
      id: 'ev-1',
      event: 'confirmed',
      actor: 'system',
      detail: 'Vehicle locked',
      createdAt: new Date().toISOString(),
    },
  ],
};

function mockApi(commands: unknown[] = [commandFixture]) {
  apiMock.mockImplementation(async (path: string, init?: { method?: string; body?: unknown }) => {
    if (path === '/api/v1/vehicles') return [liveVehicle];
    if (path === '/api/v1/vehicles/v1') return liveVehicle;
    if (path === '/api/v1/vehicles/v1/refresh') return { ok: true };
    if (path.startsWith('/api/v1/commands?')) return { items: commands };
    if (path === '/api/v1/commands/cmd-1') return commandDetail;
    if (path === '/api/v1/commands' && init?.method === 'POST') return commandFixture;
    return {};
  });
}

describe('LiveVehiclePage', () => {
  beforeEach(() => {
    window.matchMedia =
      window.matchMedia ||
      (((q: string) => ({
        matches: false,
        media: q,
        onchange: null,
        addListener: () => undefined,
        removeListener: () => undefined,
        addEventListener: () => undefined,
        removeEventListener: () => undefined,
        dispatchEvent: () => false,
      })) as unknown as typeof window.matchMedia);

    vi.stubGlobal(
      'ResizeObserver',
      class {
        observe() {}
        unobserve() {}
        disconnect() {}
      },
    );
    vi.stubGlobal(
      'IntersectionObserver',
      class {
        observe() {}
        unobserve() {}
        disconnect() {}
        takeRecords() {
          return [];
        }
      },
    );

    mockApi();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('renders the live vehicle content, telemetry, and command activity', async () => {
    renderPage('/vehicles/v1', <LiveVehiclePage />);

    expect(await screen.findByRole('heading', { name: 'Aurora' })).toBeTruthy();

    await waitFor(() => {
      expect(screen.getByText('Battery & charging')).toBeTruthy();
    });

    expect(screen.getByText('Remote controls')).toBeTruthy();
    expect(screen.getByText('Command activity')).toBeTruthy();
    expect((await screen.findAllByText('Lock')).length).toBeGreaterThan(0);
  });

  it('shows the empty command state when no commands exist', async () => {
    mockApi([]);

    renderPage('/vehicles/v1', <LiveVehiclePage />);

    expect(await screen.findByText('No commands issued for this vehicle yet.')).toBeTruthy();
  });

  it('submits a refresh request when the refresh button is clicked', async () => {
    renderPage('/vehicles/v1', <LiveVehiclePage />);

    const refreshButton = await screen.findByRole('button', { name: /refresh/i });
    fireEvent.click(refreshButton);

    await waitFor(() => {
      expect(apiMock).toHaveBeenCalledWith(
        '/api/v1/vehicles/v1/refresh',
        expect.objectContaining({ method: 'POST' }),
      );
    });
  });
});
