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

import DriveDetailPage from './DriveDetailPage';
import { fireEvent } from '@testing-library/react';

const driveFixture = {
  id: 'v1',
  vehicleId: 'v1',
  vehicleName: 'Aurora',
  classification: 'business',
  notes: 'Morning commute',
  startAt: '2024-05-01T14:00:00.000Z',
  endAt: '2024-05-01T14:35:00.000Z',
  startAddress: 'Home',
  endAddress: 'Office',
  distanceKm: 24.6,
  durationSec: 2100,
  avgSpeedKmh: 42,
  maxSpeedKmh: 78,
  energyKwh: 4.8,
  efficiencyWhPerKm: 195,
  elevationGainM: 120,
  avgOutsideTempC: 12,
  driverName: 'Alice',
  route: [
    { lat: 47.6, lng: -122.3, timestamp: '2024-05-01T14:00:00.000Z', t: 0 },
    { lat: 47.61, lng: -122.31, timestamp: '2024-05-01T14:05:00.000Z', t: 300 },
    { lat: 47.62, lng: -122.32, timestamp: '2024-05-01T14:10:00.000Z', t: 600 },
  ],
};

describe('DriveDetailPage', () => {
  beforeEach(() => {
    Object.defineProperty(window, 'matchMedia', {
      configurable: true,
      writable: true,
      value: (query: string) => ({
        matches: false,
        media: query,
        onchange: null,
        addListener: () => {},
        removeListener: () => {},
        addEventListener: () => {},
        removeEventListener: () => {},
        dispatchEvent: () => false,
      }),
    });

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

    apiMock.mockImplementation(async (path: string) => {
      if (path.startsWith('/api/v1/drives/') && path.includes('route=true')) return driveFixture;
      if (path.startsWith('/api/v1/drives/')) return driveFixture;
      if (path === '/api/v1/vehicles') return [vehicle];
      if (path === '/api/v1/status')
        return {
          overall: 'operational',
          components: [],
          incidents: [],
          maintenance: [],
          updatedAt: new Date().toISOString(),
        };
      return {};
    });
  });

  it('renders the drive summary and replay controls', async () => {
    renderPage('/drives/v1', <DriveDetailPage />);

    expect(await screen.findByRole('heading', { name: /Aurora/i })).toBeTruthy();

    await waitFor(() => {
      expect(screen.getByText('Drive summary')).toBeTruthy();
    });

    expect(screen.getByText('Route replay')).toBeTruthy();
    expect(screen.getByRole('button', { name: /replay/i })).toBeTruthy();
    expect(screen.getByText('Business')).toBeTruthy();
  });

  it('shows a not-found state when the drive is missing', async () => {
    apiMock.mockImplementationOnce(async () => null);

    renderPage('/drives/v1', <DriveDetailPage />);

    expect(await screen.findByText('Drive not found.')).toBeTruthy();
  });

  it('toggles replay playback state', async () => {
    renderPage('/drives/v1', <DriveDetailPage />);

    const replayButton = await screen.findByRole('button', { name: /replay/i });
    fireEvent.click(replayButton);

    expect(await screen.findByRole('button', { name: /pause/i })).toBeTruthy();
  });
});
