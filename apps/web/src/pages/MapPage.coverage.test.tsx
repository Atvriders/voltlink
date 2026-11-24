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
    if (path === '/api/v1/config/client')
      return {
        map: { mode: 'demo', assetsUrl: '/assets' },
        geocoder: { enabled: false, autocomplete: false },
      };
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
import { fireEvent, within } from '@testing-library/react';
import MapPage from './MapPage';

const { setVehicleMock, announceMock } = vi.hoisted(() => ({
  setVehicleMock: vi.fn(),
  announceMock: vi.fn(),
}));

vi.mock('../lib/vehicleSelection', () => ({
  useSelectedVehicle: () => ({ selectedId: null, setVehicle: setVehicleMock }),
}));

vi.mock('../lib/announcer', () => ({
  useAnnounce: () => announceMock,
}));

vi.mock('../components/map/useMapStyle', () => ({
  useMapStyle: () => ({ mode: 'demo' }),
}));

vi.mock('../components/map/GeocodeSearch', () => ({
  default: ({
    onChoose,
  }: {
    onChoose: (r: { label: string; lat: number; lon: number; kind: string }) => void;
  }) => (
    <button
      type="button"
      onClick={() => onChoose({ label: 'Geocoded Place', lat: 47.6, lon: -122.3, kind: 'charger' })}
    >
      Choose geocode result
    </button>
  ),
}));

vi.mock('../components/MapView', () => {
  const routeGeoJson = vi.fn(() => ({
    type: 'Feature',
    geometry: { type: 'LineString', coordinates: [] },
    properties: {},
  }));
  const circleGeoJson = vi.fn(() => ({
    type: 'Feature',
    geometry: { type: 'Polygon', coordinates: [] },
    properties: {},
  }));

  return {
    default: ({
      onReady,
      onPointPick,
    }: {
      onReady?: (map: { flyTo: () => void; getCenter: () => { lat: number; lng: number } }) => void;
      onPointPick?: (lat: number, lon: number) => void;
    }) => (
      <div data-testid="map-view">
        <button
          type="button"
          onClick={() => {
            onReady?.({
              flyTo: vi.fn(),
              getCenter: () => ({ lat: 47.6, lng: -122.3 }),
            });
            onPointPick?.(47.6, -122.3);
          }}
        >
          Pick map point
        </button>
      </div>
    ),
    routeGeoJson,
    circleGeoJson,
  };
});

type PlaceFixture = {
  id: string;
  name: string;
  type: string;
  lat: number;
  lon: number;
  radiusM: number;
};

type GeofenceFixture = {
  id: string;
  name: string;
  lat: number;
  lon: number;
  radiusM: number;
  enabled: boolean;
  alertOn?: string;
};

type ZoneFixture = {
  id: string;
  name: string;
  lat: number;
  lon: number;
  radiusM: number;
  enabled?: boolean;
};

let places: PlaceFixture[] = [];
let geofences: GeofenceFixture[] = [];
let zones: ZoneFixture[] = [];
let failPlaces = false;

function getSection(title: string): HTMLElement {
  const heading = screen.getByText(title);
  const section = heading.closest('section');
  if (!section) throw new Error(`Missing section: ${title}`);
  return section as HTMLElement;
}

describe('MapPage', () => {
  beforeEach(() => {
    setVehicleMock.mockClear();
    announceMock.mockClear();
    failPlaces = false;

    places = [
      { id: 'p1', name: 'Home', type: 'home', lat: 47.61, lon: -122.31, radiusM: 150 },
      { id: 'p2', name: 'Work', type: 'work', lat: 47.62, lon: -122.32, radiusM: 150 },
    ];
    geofences = [
      {
        id: 'g1',
        name: 'Campus',
        lat: 47.63,
        lon: -122.33,
        radiusM: 500,
        enabled: true,
        alertOn: 'both',
      },
    ];
    zones = [
      { id: 'z1', name: 'Home Zone', lat: 47.64, lon: -122.34, radiusM: 300, enabled: true },
    ];

    apiMock.mockImplementation(async (path: string, init?: { method?: string; body?: unknown }) => {
      const method = init?.method ?? 'GET';

      if (path === '/api/v1/vehicles') return [vehicle];
      if (path === `/api/v1/vehicles/${vehicle.id}`) return vehicle;

      if (path === '/api/v1/vehicles/places/all' && method === 'GET') {
        if (failPlaces) throw new Error('places failed');
        return places;
      }
      if (path === '/api/v1/vehicles/places/all' && method === 'POST') {
        const body = init?.body as {
          name: string;
          type: string;
          lat: number;
          lon: number;
          radiusM: number;
        };
        const created: PlaceFixture = { id: `p${places.length + 1}`, ...body };
        places.push(created);
        return created;
      }
      if (path.startsWith('/api/v1/vehicles/places/all/')) {
        const id = path.split('/').pop() ?? '';
        if (method === 'PATCH') {
          const body = init?.body as { name: string; type: string; radiusM: number };
          places = places.map((p) => (p.id === id ? { ...p, ...body } : p));
          return {};
        }
        if (method === 'DELETE') {
          places = places.filter((p) => p.id !== id);
          return {};
        }
      }

      if (path === '/api/v1/vehicles/geofences/all' && method === 'GET') return geofences;
      if (path === '/api/v1/vehicles/geofences/all' && method === 'POST') {
        const body = init?.body as {
          name: string;
          lat: number;
          lon: number;
          radiusM: number;
          enabled: boolean;
          alertOn: string;
        };
        const created: GeofenceFixture = { id: `g${geofences.length + 1}`, ...body };
        geofences.push(created);
        return created;
      }
      if (path.startsWith('/api/v1/vehicles/geofences/all/')) {
        const id = path.split('/').pop() ?? '';
        if (method === 'PATCH') {
          const body = init?.body as {
            name: string;
            radiusM: number;
            enabled: boolean;
          };
          geofences = geofences.map((g) => (g.id === id ? { ...g, ...body } : g));
          return {};
        }
        if (method === 'DELETE') {
          geofences = geofences.filter((g) => g.id !== id);
          return {};
        }
      }

      if (path === '/api/v1/vehicles/privacy-zones' && method === 'GET') return zones;
      if (path === '/api/v1/vehicles/privacy-zones' && method === 'POST') {
        const body = init?.body as {
          name: string;
          lat: number;
          lon: number;
          radiusM: number;
        };
        const created: ZoneFixture = {
          id: `z${zones.length + 1}`,
          ...body,
          enabled: true,
        };
        zones.push(created);
        return created;
      }
      if (path.startsWith('/api/v1/vehicles/privacy-zones/')) {
        const id = path.split('/').pop() ?? '';
        if (method === 'PATCH') {
          const body = init?.body as { name: string; radiusM: number };
          zones = zones.map((z) => (z.id === id ? { ...z, ...body } : z));
          return {};
        }
        if (method === 'DELETE') {
          zones = zones.filter((z) => z.id !== id);
          return {};
        }
      }

      if (path === '/api/v1/charging?pageSize=50') {
        return {
          items: [
            {
              id: 'c1',
              lat: 47.6,
              lon: -122.3,
              locationName: 'Volt Charger',
              vehicleName: 'Aurora',
            },
          ],
        };
      }

      if (path === '/api/v1/drives/d1?route=true') {
        return {
          data: {
            route: [
              { lat: 47.6, lon: -122.3 },
              { lat: 47.61, lon: -122.31 },
            ],
          },
        };
      }
      if (path.startsWith('/api/v1/drives?')) {
        return { items: [{ id: 'd1' }], total: 1, page: 1, pageSize: 1 };
      }
      if (path.startsWith('/api/v1/drives')) {
        return { items: [], total: 0, page: 1, pageSize: 20 };
      }

      if (path.includes('/geocode')) return [];
      return {};
    });
  });

  it('renders the map, demo basemap notice, vehicle and saved layers', async () => {
    renderPage('/map', <MapPage />);

    expect(await screen.findByRole('heading', { name: 'Map' })).toBeInTheDocument();
    expect(screen.getByText(/Fictional demo map/)).toBeInTheDocument();
    expect(await screen.findByText(/Demo basemap/)).toBeInTheDocument();
    expect(screen.getByTestId('map-view')).toBeInTheDocument();
    expect(screen.getByRole('complementary', { name: 'Map layers' })).toBeInTheDocument();

    expect(await screen.findByRole('button', { name: 'Show on map: Aurora' })).toBeInTheDocument();
    expect(await screen.findByRole('button', { name: 'Edit Home' })).toBeInTheDocument();
    expect(await screen.findByRole('button', { name: 'Edit Campus' })).toBeInTheDocument();
    expect(await screen.findByRole('button', { name: 'Delete Home Zone' })).toBeInTheDocument();
  });

  it('opens place pick mode, uses map centre, repicks and cancels with Escape', async () => {
    const user = userEvent.setup();
    renderPage('/map', <MapPage />);
    await screen.findByRole('heading', { name: 'Map' });

    await user.click(screen.getByRole('button', { name: 'Pick map point' }));
    await user.click(screen.getByRole('button', { name: /Add place/i }));

    expect(screen.getByRole('status')).toHaveTextContent(/place the place/i);

    await user.click(screen.getByRole('button', { name: 'Use map centre' }));
    expect(await screen.findByRole('button', { name: 'Save place' })).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'Repick' }));
    expect(await screen.findByRole('status')).toHaveTextContent(/place the place/i);

    fireEvent.keyDown(window, { key: 'Escape' });
    await waitFor(() => expect(screen.queryByRole('status')).not.toBeInTheDocument());
  });

  it('creates a place from a geocode result', async () => {
    const user = userEvent.setup();
    renderPage('/map', <MapPage />);
    await screen.findByRole('heading', { name: 'Map' });

    await user.click(screen.getByRole('button', { name: 'Choose geocode result' }));

    const name = screen.getByLabelText('Name') as HTMLInputElement;
    await user.clear(name);
    await user.type(name, 'Office');

    const type = screen.getByLabelText('Type') as HTMLSelectElement;
    fireEvent.change(type, { target: { value: 'work' } });

    await user.click(screen.getByRole('button', { name: 'Save place' }));

    await waitFor(() =>
      expect(apiMock).toHaveBeenCalledWith(
        '/api/v1/vehicles/places/all',
        expect.objectContaining({
          method: 'POST',
          body: expect.objectContaining({ name: 'Office', type: 'work' }),
        }),
      ),
    );
    expect(await screen.findByRole('button', { name: 'Edit Office' })).toBeInTheDocument();
  });

  it('creates a geofence with radius and alert mode', async () => {
    const user = userEvent.setup();
    renderPage('/map', <MapPage />);
    await screen.findByRole('heading', { name: 'Map' });

    await user.click(within(getSection('Geofences')).getByRole('button', { name: /Add/i }));
    expect(await screen.findByRole('status')).toHaveTextContent(/place the geofence/i);

    await user.click(screen.getByRole('button', { name: 'Pick map point' }));
    expect(await screen.findByRole('button', { name: 'Save geofence' })).toBeInTheDocument();

    await user.type(screen.getByLabelText('Name'), 'Depot');
    fireEvent.change(screen.getByLabelText('Radius (m)'), { target: { value: '750' } });
    fireEvent.change(screen.getByLabelText('Alert on'), { target: { value: 'enter' } });

    await user.click(screen.getByRole('button', { name: 'Save geofence' }));

    await waitFor(() =>
      expect(apiMock).toHaveBeenCalledWith(
        '/api/v1/vehicles/geofences/all',
        expect.objectContaining({
          method: 'POST',
          body: expect.objectContaining({
            name: 'Depot',
            radiusM: 750,
            alertOn: 'enter',
            enabled: true,
          }),
        }),
      ),
    );
    expect(await screen.findByRole('button', { name: 'Edit Depot' })).toBeInTheDocument();
  });

  it('creates a privacy zone with a radius', async () => {
    const user = userEvent.setup();
    renderPage('/map', <MapPage />);
    await screen.findByRole('heading', { name: 'Map' });

    await user.click(within(getSection('Privacy zones')).getByRole('button', { name: /Add/i }));
    expect(await screen.findByRole('status')).toHaveTextContent(/place the privacy/i);

    await user.click(screen.getByRole('button', { name: 'Pick map point' }));
    expect(await screen.findByRole('button', { name: 'Save privacy' })).toBeInTheDocument();

    await user.type(screen.getByLabelText('Name'), 'Private');
    fireEvent.change(screen.getByLabelText('Radius (m)'), { target: { value: '300' } });

    await user.click(screen.getByRole('button', { name: 'Save privacy' }));

    await waitFor(() =>
      expect(apiMock).toHaveBeenCalledWith(
        '/api/v1/vehicles/privacy-zones',
        expect.objectContaining({
          method: 'POST',
          body: expect.objectContaining({ name: 'Private', radiusM: 300 }),
        }),
      ),
    );
    expect(await screen.findByRole('button', { name: 'Delete Private' })).toBeInTheDocument();
  });

  it('edits a place name and type', async () => {
    const user = userEvent.setup();
    renderPage('/map', <MapPage />);
    await screen.findByRole('heading', { name: 'Map' });

    await user.click(await screen.findByRole('button', { name: 'Edit Home' }));

    const name = screen.getByLabelText('Name') as HTMLInputElement;
    await user.clear(name);
    await user.type(name, 'Home Updated');
    fireEvent.change(screen.getByLabelText('Place type'), { target: { value: 'work' } });

    const editRow = name.closest('li');
    expect(editRow).not.toBeNull();
    await user.click(within(editRow as HTMLElement).getByRole('button', { name: 'Save' }));

    await waitFor(() =>
      expect(apiMock).toHaveBeenCalledWith(
        '/api/v1/vehicles/places/all/p1',
        expect.objectContaining({
          method: 'PATCH',
          body: expect.objectContaining({
            name: 'Home Updated',
            type: 'work',
            radiusM: 150,
          }),
        }),
      ),
    );
    expect(await screen.findByRole('button', { name: 'Edit Home Updated' })).toBeInTheDocument();
  });

  it('edits a geofence and toggles enabled', async () => {
    const user = userEvent.setup();
    renderPage('/map', <MapPage />);
    await screen.findByRole('heading', { name: 'Map' });

    await user.click(await screen.findByRole('button', { name: 'Edit Campus' }));

    const name = screen.getByLabelText('Name') as HTMLInputElement;
    await user.clear(name);
    await user.type(name, 'Campus West');
    await user.click(screen.getByRole('checkbox', { name: /Enabled/i }));

    const editRow = name.closest('li');
    expect(editRow).not.toBeNull();
    await user.click(within(editRow as HTMLElement).getByRole('button', { name: 'Save' }));

    await waitFor(() =>
      expect(apiMock).toHaveBeenCalledWith(
        '/api/v1/vehicles/geofences/all/g1',
        expect.objectContaining({
          method: 'PATCH',
          body: expect.objectContaining({
            name: 'Campus West',
            radiusM: 500,
            enabled: false,
          }),
        }),
      ),
    );
    expect(await screen.findByRole('button', { name: 'Edit Campus West' })).toBeInTheDocument();
  });

  it('deletes a privacy zone and removes it from the list', async () => {
    const user = userEvent.setup();
    renderPage('/map', <MapPage />);
    await screen.findByRole('heading', { name: 'Map' });

    await user.click(await screen.findByRole('button', { name: 'Delete Home Zone' }));

    await waitFor(() =>
      expect(apiMock).toHaveBeenCalledWith('/api/v1/vehicles/privacy-zones/z1', {
        method: 'DELETE',
      }),
    );
    await waitFor(() =>
      expect(screen.queryByRole('button', { name: 'Delete Home Zone' })).not.toBeInTheDocument(),
    );
  });

  it('changes the vehicle filter and stores the selected vehicle', async () => {
    renderPage('/map', <MapPage />);
    await screen.findByRole('heading', { name: 'Map' });

    const filter = (await screen.findByLabelText('Vehicle filter')) as HTMLSelectElement;
    fireEvent.change(filter, { target: { value: 'v1' } });

    expect(filter.value).toBe('v1');
    expect(setVehicleMock).toHaveBeenCalledWith('v1');
  });

  it('shows the map data error state when places fail to load', async () => {
    failPlaces = true;
    renderPage('/map', <MapPage />);

    expect(await screen.findByText('Couldn’t load map data')).toBeInTheDocument();
  });
});
