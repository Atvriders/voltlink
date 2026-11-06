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

import MapView, { type MapLayer } from './MapView';
import { hasWebGL2 } from '../lib/webgl';
import { createMap } from '../lib/map';

vi.mock('../lib/webgl', () => ({ hasWebGL2: vi.fn() }));
vi.mock('../lib/map', () => ({
  createMap: vi.fn(),
  circleGeoJson: vi.fn(() => ({ type: 'FeatureCollection', features: [] })),
  routeGeoJson: vi.fn(() => ({ type: 'FeatureCollection', features: [] })),
}));

function makeFakeMap() {
  return {
    on: vi.fn(),
    once: vi.fn((_event: string, cb: () => void) => cb()),
    loaded: vi.fn(() => true),
    getSource: vi.fn(() => undefined as unknown),
    addSource: vi.fn(),
    addLayer: vi.fn(),
    getLayer: vi.fn(() => undefined as unknown),
    getStyle: vi.fn(() => ({ layers: [] as Array<{ id: string }> })),
    removeLayer: vi.fn(),
    removeSource: vi.fn(),
    remove: vi.fn(),
  };
}

const layers: MapLayer[] = [
  {
    id: 'vehicle-v1',
    kind: 'vehicle',
    color: '#22d3ee',
    label: 'Aurora',
    feature: {
      type: 'Feature',
      geometry: { type: 'Point', coordinates: [-122.3, 47.6] },
      properties: {},
    },
  },
  {
    id: 'route-v1',
    kind: 'route',
    color: '#0ea5e9',
    feature: {
      type: 'Feature',
      geometry: {
        type: 'LineString',
        coordinates: [
          [-122.3, 47.6],
          [-122.31, 47.61],
        ],
      },
      properties: {},
    },
  },
];

describe('MapView', () => {
  beforeEach(() => {
    vi.mocked(hasWebGL2).mockReturnValue(true);
    vi.mocked(createMap).mockReturnValue(
      makeFakeMap() as unknown as ReturnType<typeof createMap>,
    );
  });

  it('renders the fallback card when WebGL2 is unavailable', async () => {
    vi.mocked(hasWebGL2).mockReturnValue(false);
    renderPage('/map', <MapView layers={layers} />);
    expect(await screen.findByText('Map unavailable on this device')).toBeTruthy();
    expect(screen.getByRole('note')).toBeTruthy();
  });

  it('creates the map, draws layers, and calls onReady', async () => {
    const fakeMap = makeFakeMap();
    vi.mocked(createMap).mockReturnValue(
      fakeMap as unknown as ReturnType<typeof createMap>,
    );
    const onReady = vi.fn();
    renderPage('/map', <MapView layers={layers} onReady={onReady} />);
    await waitFor(() => {
      expect(document.querySelector('[aria-label="Map"]')).toBeTruthy();
    });
    await waitFor(() => expect(onReady).toHaveBeenCalled());
    expect(fakeMap.addSource).toHaveBeenCalled();
    expect(fakeMap.addLayer).toHaveBeenCalled();
  });

  it('shows the fallback card when map creation throws', async () => {
    vi.mocked(hasWebGL2).mockReturnValue(true);
    vi.mocked(createMap).mockImplementation(() => {
      throw new Error('gpu init failed');
    });
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    renderPage('/map', <MapView layers={layers} />);
    expect(await screen.findByText('Map unavailable on this device')).toBeTruthy();
    errorSpy.mockRestore();
  });

  it('renders the map container with an empty layer set', async () => {
    const fakeMap = makeFakeMap();
    vi.mocked(createMap).mockReturnValue(
      fakeMap as unknown as ReturnType<typeof createMap>,
    );
    renderPage('/map', <MapView layers={[]} />);
    await waitFor(() => {
      expect(document.querySelector('[aria-label="Map"]')).toBeTruthy();
    });
    expect(fakeMap.addSource).not.toHaveBeenCalled();
  });
});
