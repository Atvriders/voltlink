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
vi.mock('../components/MapView', () => ({
  default: (props: { layers?: unknown[]; height?: number | string }) => (
    <div data-testid="mapview">{String((props.layers ?? []).length)} layers</div>
  ),
  circleGeoJson: () => ({ type: 'Feature' }),
  routeGeoJson: () => ({ type: 'Feature' }),
}));

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
    if (path === '/api/v1/config/client')
      return { map: { mode: 'demo', assetsUrl: '/assets' }, geocoder: { enabled: false, autocomplete: false } };
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

import MapPage from './MapPage';

const placeFixtures = [
  { id: 'p1', name: 'Home Base', type: 'home', lat: 47.6, lon: -122.3, radiusM: 150 },
];
const fenceFixtures = [
  {
    id: 'g1',
    name: 'Work Ring',
    lat: 47.61,
    lon: -122.31,
    radiusM: 1200,
    enabled: true,
    alertOn: 'both',
  },
];
const zoneFixtures = [
  { id: 'z1', name: 'Private Block', lat: 47.62, lon: -122.32, radiusM: 300, enabled: true },
];
const chargeFixtures = [
  { id: 'c1', lat: 47.6, lon: -122.3, locationName: 'Downtown Charger', vehicleName: 'Aurora' },
];

describe('MapPage', () => {
  let emptyMode = false;

  beforeEach(() => {
    emptyMode = false;

    if (typeof window.matchMedia !== 'function') {
      window.matchMedia = ((q: string) => ({
        matches: false,
        media: q,
        onchange: null,
        addListener: () => {},
        removeListener: () => {},
        addEventListener: () => {},
        removeEventListener: () => {},
        dispatchEvent: () => false,
      })) as unknown as typeof window.matchMedia;
    }

    if (typeof window.ResizeObserver === 'undefined') {
      class ResizeObserverStub {
        observe() {}
        unobserve() {}
        disconnect() {}
      }
      window.ResizeObserver = ResizeObserverStub as unknown as typeof ResizeObserver;
    }

    if (typeof window.IntersectionObserver === 'undefined') {
      class IntersectionObserverStub {
        observe() {}
        unobserve() {}
        disconnect() {}
        takeRecords() {
          return [];
        }
      }
      window.IntersectionObserver =
        IntersectionObserverStub as unknown as typeof IntersectionObserver;
    }

    const base = apiMock.getMockImplementation();
    apiMock.mockImplementation(async (path: string, ...rest: unknown[]) => {
      if (path === '/api/v1/vehicles') return emptyMode ? [] : [vehicle];
      if (path === '/api/v1/vehicles/places/all') return emptyMode ? [] : placeFixtures;
      if (path === '/api/v1/vehicles/geofences/all') return emptyMode ? [] : fenceFixtures;
      if (path === '/api/v1/vehicles/privacy-zones') return emptyMode ? [] : zoneFixtures;
      if (path.startsWith('/api/v1/charging'))
        return emptyMode ? { items: [] } : { items: chargeFixtures };
      if (path.startsWith('/api/v1/drives?'))
        return { items: [], total: 0, page: 1, pageSize: 1 };
      if (base) return base(path, ...rest);
      return {};
    });
  });

  it('renders the map page with vehicle, places, geofences and privacy zones', async () => {
    renderPage('/map', <MapPage />);

    expect(await screen.findByRole('heading', { name: 'Map' })).toBeTruthy();

    const aurora = await screen.findAllByText('Aurora');
    expect(aurora.length).toBeGreaterThan(0);
    expect(await screen.findByText('Home Base')).toBeTruthy();
    expect(await screen.findByText('Work Ring')).toBeTruthy();
    expect(await screen.findByText('Private Block')).toBeTruthy();
    expect(screen.getByLabelText('Map layers')).toBeTruthy();
  });

  it('shows empty states when there are no vehicles, places, geofences or privacy zones', async () => {
    emptyMode = true;
    renderPage('/map', <MapPage />);

    expect(await screen.findByRole('heading', { name: 'Map' })).toBeTruthy();
    const emptyMarkers = await screen.findAllByText('None yet.');
    expect(emptyMarkers.length).toBe(4);
    expect(screen.queryByText('Home Base')).toBeNull();
  });

  it('starts place pick mode when Add place is clicked and cancels on Escape', async () => {
    renderPage('/map', <MapPage />);

    const addButton = await screen.findByRole('button', { name: /add place/i });
    addButton.click();

    expect(await screen.findByText(/Click the map to place the place/i)).toBeTruthy();
    expect(screen.getByRole('button', { name: /use map centre/i })).toBeTruthy();

    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
    await waitFor(() => {
      expect(screen.queryByText(/Click the map to place the place/i)).toBeNull();
    });
  });
});
