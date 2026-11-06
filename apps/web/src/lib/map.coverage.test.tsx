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
import {
  buildStyle,
  buildDemoStyle,
  fictionalCityGeoJson,
  routeGeoJson,
  circleGeoJson,
} from './map';

function MapDataProbe() {
  const style = buildStyle();
  const demo = buildDemoStyle();
  const city = fictionalCityGeoJson();
  const route = routeGeoJson([
    { lat: 39.07, lon: -104.62 },
    { lat: 39.08, lon: -104.61 },
  ]);
  const circle = circleGeoJson(39.0734, -104.6211, 120);

  return (
    <div>
      <div data-testid="style-version">{String(style.version)}</div>
      <div data-testid="style-layers">{String(style.layers.length)}</div>
      <div data-testid="demo-layers">{String(demo.layers.length)}</div>
      <div data-testid="city-type">{city.type}</div>
      <div data-testid="city-features">{String(city.features.length)}</div>
      <div data-testid="route-type">{route.geometry.type}</div>
      <div data-testid="route-coords">{String(route.geometry.coordinates.length)}</div>
      <div data-testid="circle-type">{circle.geometry.type}</div>
      <div data-testid="circle-coords">{String(circle.geometry.coordinates[0]!.length)}</div>
    </div>
  );
}

describe('map helpers', () => {
  it('renders the offline demo city style with the expected layer stack', async () => {
    renderPage('/map', <MapDataProbe />);

    await waitFor(() => expect(screen.getByTestId('style-version')).toBeTruthy());

    expect(screen.getByTestId('style-version').textContent).toBe('8');
    expect(screen.getByTestId('style-layers').textContent).toBe('5');
    expect(screen.getByTestId('demo-layers').textContent).toBe('5');
    expect(screen.getByTestId('city-type').textContent).toBe('FeatureCollection');
    expect(Number(screen.getByTestId('city-features').textContent)).toBeGreaterThan(0);
  });

  it('produces route and circle overlay geometries', async () => {
    renderPage('/map', <MapDataProbe />);

    await waitFor(() => expect(screen.getByTestId('route-type')).toBeTruthy());

    expect(screen.getByTestId('route-type').textContent).toBe('LineString');
    expect(screen.getByTestId('route-coords').textContent).toBe('2');
    expect(screen.getByTestId('circle-type').textContent).toBe('Polygon');
    expect(screen.getByTestId('circle-coords').textContent).toBe('66');
  });

  it('keeps the fictional city deterministic across calls', async () => {
    const first = fictionalCityGeoJson();
    const second = fictionalCityGeoJson();

    renderPage(
      '/map',
      <div data-testid="same">{String(JSON.stringify(first) === JSON.stringify(second))}</div>,
    );

    await waitFor(() => expect(screen.getByTestId('same')).toBeTruthy());

    expect(screen.getByTestId('same').textContent).toBe('true');
    expect(first.features.length).toBe(second.features.length);
  });
});
