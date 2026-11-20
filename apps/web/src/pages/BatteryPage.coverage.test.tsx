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

import BatteryPage from './BatteryPage';
import userEvent from '@testing-library/user-event';

const vehicleSelectionState = vi.hoisted(() => ({
  selectedId: 'v1',
  setVehicle: vi.fn(),
}));

vi.mock('../lib/vehicleSelection', () => ({
  useSelectedVehicle: () => vehicleSelectionState,
}));

const vehicle2 = {
  ...vehicle,
  id: 'v2',
  displayName: 'Bolt',
  exteriorColor: '#64748b',
};

const batteryPoints = [
  { ts: '2024-01-01T00:00:00.000Z', batteryPct: 82, rangeKm: 430 },
  { ts: '2024-01-02T00:00:00.000Z', batteryPct: 76, rangeKm: 405 },
  { ts: '2024-01-03T00:00:00.000Z', batteryPct: 72, rangeKm: 390 },
];

const efficiencyPoints = [
  { date: '2024-01-01', whPerKm: 162, tempC: 11 },
  { date: '2024-01-02', whPerKm: 171, tempC: 13 },
  { date: '2024-01-03', whPerKm: 168, tempC: 12 },
];

const aggregates = [
  {
    date: '2024-01-03',
    distanceKm: 10.5,
    energyKwh: 2.5,
    chargeEnergyKwh: 3.0,
    driveCount: 1,
  },
  {
    date: '2024-01-02',
    distanceKm: 20.0,
    energyKwh: 4.0,
    chargeEnergyKwh: 5.5,
    driveCount: 2,
  },
  {
    date: '2024-01-01',
    distanceKm: 5.25,
    energyKwh: 1.5,
    chargeEnergyKwh: 2.0,
    driveCount: 1,
  },
];

const batteryHealth = {
  estimatedUsableKwh: 72.5,
  estimatedDegradationPct: 4.2,
  sampleCount: 8,
  disclaimer: 'Estimate only; not a warranty diagnostic.',
};

let analyticsMode: 'full' | 'empty' = 'full';

class ResizeObserverMock {
  observe() {}
  unobserve() {}
  disconnect() {}
}

beforeEach(() => {
  analyticsMode = 'full';
  vehicleSelectionState.selectedId = 'v1';
  vehicleSelectionState.setVehicle.mockClear();
  apiMock.mockClear();
  vi.stubGlobal('ResizeObserver', ResizeObserverMock);

  apiMock.mockImplementation(async (path: string) => {
    if (path === '/api/v1/vehicles') return [vehicle, vehicle2];
    if (path.startsWith('/api/v1/analytics/') && path.includes('/battery-health')) {
      return analyticsMode === 'empty' ? null : batteryHealth;
    }
    if (path.startsWith('/api/v1/analytics/') && path.includes('/battery?')) {
      return analyticsMode === 'empty' ? [] : batteryPoints;
    }
    if (path.startsWith('/api/v1/analytics/') && path.includes('/efficiency?')) {
      return analyticsMode === 'empty' ? [] : efficiencyPoints;
    }
    if (path.startsWith('/api/v1/analytics/') && path.includes('/aggregates?')) {
      return analyticsMode === 'empty' ? [] : aggregates;
    }
    return {};
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('BatteryPage', () => {
  it('renders charts, battery health estimate, aggregates and usage summary', async () => {
    renderPage('/analytics/battery', <BatteryPage />);

    expect(await screen.findByRole('heading', { name: 'Battery & efficiency' })).toBeTruthy();
    expect(await screen.findByRole('img', { name: 'State of charge chart' })).toBeTruthy();
    expect(await screen.findByRole('img', { name: 'Efficiency chart' })).toBeTruthy();
    expect(await screen.findByText('72.5 kWh')).toBeTruthy();
    expect(await screen.findByText('4.2%')).toBeTruthy();
    expect(await screen.findByText('Estimate only; not a warranty diagnostic.')).toBeTruthy();
    expect(await screen.findByText('Last 14 days')).toBeTruthy();
    expect(await screen.findByText('01-03')).toBeTruthy();
    expect(screen.getByText('8.0 kWh')).toBeTruthy();
    expect(screen.getByText('10.5 kWh')).toBeTruthy();
  });

  it('refetches efficiency and aggregates when the efficiency window changes', async () => {
    const user = userEvent.setup();
    renderPage('/analytics/battery', <BatteryPage />);

    await screen.findByRole('img', { name: 'Efficiency chart' });
    await user.selectOptions(screen.getByLabelText('Efficiency window') as HTMLSelectElement, '30');

    await waitFor(() =>
      expect(apiMock).toHaveBeenCalledWith('/api/v1/analytics/v1/efficiency?days=30'),
    );
    await waitFor(() =>
      expect(apiMock).toHaveBeenCalledWith('/api/v1/analytics/v1/aggregates?days=30'),
    );
    expect(await screen.findByText('Last 30 days')).toBeTruthy();
  });

  it('refetches battery samples when the battery window changes', async () => {
    const user = userEvent.setup();
    renderPage('/analytics/battery', <BatteryPage />);

    await screen.findByRole('img', { name: 'State of charge chart' });
    await user.selectOptions(screen.getByLabelText('Battery window') as HTMLSelectElement, '7');

    await waitFor(() =>
      expect(apiMock).toHaveBeenCalledWith('/api/v1/analytics/v1/battery?days=7'),
    );
    expect(await screen.findByRole('img', { name: 'State of charge chart' })).toBeTruthy();
  });

  it('switches vehicle selection and refetches analytics for the new vehicle', async () => {
    const user = userEvent.setup();
    renderPage('/analytics/battery', <BatteryPage />);

    await screen.findByText('Aurora');
    await user.selectOptions(screen.getByLabelText('Vehicle') as HTMLSelectElement, 'v2');

    await waitFor(() => expect(vehicleSelectionState.setVehicle).toHaveBeenCalledWith('v2'));
    await waitFor(() =>
      expect(apiMock).toHaveBeenCalledWith('/api/v1/analytics/v2/battery?days=14'),
    );
    await waitFor(() =>
      expect(apiMock).toHaveBeenCalledWith('/api/v1/analytics/v2/efficiency?days=14'),
    );
  });

  it('shows empty analytics states when no samples are returned', async () => {
    analyticsMode = 'empty';
    renderPage('/analytics/battery', <BatteryPage />);

    expect(await screen.findByText('No battery samples')).toBeTruthy();
    expect(await screen.findByText('No drive data yet')).toBeTruthy();
    expect(await screen.findByText('Not enough charging data to estimate.')).toBeTruthy();
    expect(await screen.findByText('No aggregate data.')).toBeTruthy();
  });

  it('renders aggregate rows and labels for the usage summary', async () => {
    renderPage('/analytics/battery', <BatteryPage />);

    expect(await screen.findByText('01-03')).toBeTruthy();
    expect(screen.getByText('10.5 km')).toBeTruthy();
    expect(screen.getByText('3.0 kWh in')).toBeTruthy();
    // driveCount pluralization: one drive is singular, two are plural
    expect(screen.getAllByText('1 drive').length).toBeGreaterThan(0);
    expect(screen.getByText('2 drives')).toBeTruthy();
    expect(screen.getByText('Energy (drives)')).toBeTruthy();
    expect(screen.getByText('Charged')).toBeTruthy();
  });

  it('shows the no vehicles empty state when there is no active vehicle', async () => {
    vehicleSelectionState.selectedId = '';
    apiMock.mockImplementation(async (path: string) => {
      if (path === '/api/v1/vehicles') return [];
      return {};
    });

    renderPage('/analytics/battery', <BatteryPage />);

    expect(await screen.findByText('No vehicles')).toBeTruthy();
    expect(
      screen.getByText('Connect a vehicle or demo mode to see battery analytics.'),
    ).toBeTruthy();
  });
});
