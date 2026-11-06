// R6: NEW-12 — save-place uses a pick banner + inline form, never a modal that
// covers the map.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router-dom';
import { render, screen, waitFor, cleanup, fireEvent } from '@testing-library/react';
import MapPage from './pages/MapPage';

const apiMock = vi.fn();
vi.mock('./api/client', () => ({
  api: (...args: unknown[]) => apiMock(...args),
  apiCsv: vi.fn().mockResolvedValue(''),
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
vi.mock('./auth/AuthContext', () => ({
  useAuth: () => ({
    user: {
      id: 'u1',
      email: 'a@test.dev',
      name: 'A',
      units: 'metric',
      timezone: 'UTC',
      theme: 'voltlink-dark',
      totpEnabled: false,
      demoEnabled: true,
      isInstanceAdmin: true,
    },
    loading: false,
    login: vi.fn(),
    loginMfa: vi.fn(),
    logout: vi.fn(),
    refresh: vi.fn(),
  }),
}));
let pickHandler: ((lat: number, lon: number) => void) | null = null;
vi.mock('./components/MapView', () => ({
  default: (props: {
    onPointPick?: (lat: number, lon: number) => void;
    onReady?: (m: unknown) => void;
    mapStyle?: unknown;
  }) => {
    pickHandler = props.onPointPick ?? null;
    return (
      <div data-testid="map">
        <button type="button" onClick={() => props.onPointPick?.(40.1234, -100.5678)}>
          pick-here
        </button>
      </div>
    );
  },
}));

const vehicle = {
  id: 'v1',
  displayName: 'Aurora',
  exteriorColor: '#334455',
  providerVehicleId: 'demo-aurora',
  provider: 'demo',
  demo: true,
  capabilities: [],
  state: {
    status: 'online',
    chargingState: 'parked',
    batteryPercent: 72,
    batteryRangeKm: 420,
    locked: true,
    odometerKm: 1234,
    interiorTempC: 21,
    outsideTempC: 12,
    speedKmh: 0,
    latitude: 40,
    longitude: -100,
    address: '1 Main St',
    freshness: 'recent',
    updatedAt: new Date().toISOString(),
  },
};

beforeEach(() => {
  pickHandler = null;
  apiMock.mockImplementation(async (path: string) => {
    if (path === '/api/v1/vehicles') return [vehicle];
    if (path === '/api/v1/vehicles/places/all') return [];
    if (path === '/api/v1/vehicles/geofences/all') return [];
    if (path === '/api/v1/vehicles/privacy-zones') return [];
    if (path === '/api/v1/config') return { map: { mode: 'demo' } };
    if (path.startsWith('/api/v1/charging')) return { items: [] };
    if (path.startsWith('/api/v1/drives')) return { items: [] };
    return {};
  });
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

function renderPage() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <MemoryRouter initialEntries={['/map']}>
        <MapPage />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

describe('save place picker (NEW-12)', () => {
  it('picks from the map without a covering modal and saves the place', async () => {
    renderPage();
    await waitFor(() => expect(screen.getByRole('button', { name: /add place/i })).toBeTruthy());
    fireEvent.click(screen.getByRole('button', { name: /add place/i }));
    // No modal covers the map; a status banner announces the pick mode.
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(screen.getByText(/click the map to place/i)).toBeTruthy();
    fireEvent.click(screen.getByText('pick-here'));
    expect(await screen.findByText(/selected: 40\.1234, -100\.5678/i)).toBeTruthy();
    const name = screen.getByRole('textbox');
    fireEvent.change(name, { target: { value: 'HQ' } });
    fireEvent.click(screen.getByRole('button', { name: /save/i }));
    await waitFor(() =>
      expect(apiMock).toHaveBeenCalledWith(
        '/api/v1/vehicles/places/all',
        expect.objectContaining({
          method: 'POST',
          body: expect.objectContaining({ name: 'HQ' }),
        }),
      ),
    );
  });
});
