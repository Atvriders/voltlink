// R6: F-PARAMS — controls send real parameters, HomeLink and Remote start are
// reachable, and state-driven toggles submit the flipped value.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { render, screen, waitFor, cleanup, fireEvent, within } from '@testing-library/react';
import LiveVehiclePage from './pages/LiveVehiclePage';

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
      email: 'a@example.invalid',
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
vi.mock('./webgl/VehicleViewer', () => ({
  default: () => <div data-testid="viewer" />,
}));

const vehicle = {
  id: 'v1',
  displayName: 'Aurora',
  exteriorColor: '#334455',
  providerVehicleId: 'demo-aurora',
  provider: 'demo',
  demo: true,
  capabilities: ['set_temperature', 'homelink', 'remote_start', 'sentry_mode'],
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
    sentryMode: true,
    updatedAt: new Date().toISOString(),
  },
};

beforeEach(() => {
  apiMock.mockImplementation(async (path: string, init?: { method?: string; body?: unknown }) => {
    if (path === '/api/v1/vehicles') return [vehicle];
    if (path === `/api/v1/vehicles/${vehicle.id}`) return vehicle;
    if (path.startsWith('/api/v1/commands?vehicleId=')) return { items: [], total: 0 };
    if (path.startsWith('/api/v1/charging')) return { items: [], total: 0 };
    if (path.includes('/drives/totals')) return { count: 0, distanceKm: 0, energyKwh: 0 };
    if (path.startsWith('/api/v1/drives')) return { items: [], total: 0 };
    if (path === '/api/v1/commands' && init?.method === 'POST') {
      const body = init.body as { type: string; params: Record<string, unknown> };
      return {
        id: 'cmd-1',
        vehicleId: 'v1',
        type: body.type,
        status: 'queued',
        createdAt: new Date().toISOString(),
        params: body.params,
      };
    }
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
      <MemoryRouter initialEntries={['/vehicles/v1']}>
        <Routes>
          <Route path="/vehicles/:id" element={<LiveVehiclePage />} />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

describe('remote control parameters (F-PARAMS)', () => {
  it('exposes HomeLink and Remote start behind their capabilities', async () => {
    renderPage();
    await waitFor(() => expect(screen.getByText('Aurora')).toBeTruthy());
    expect(screen.getByRole('button', { name: /homelink/i })).toBeTruthy();
    expect(screen.getByRole('button', { name: /remote start/i })).toBeTruthy();
  });

  it('sends a numeric temperature with the command', async () => {
    renderPage();
    await waitFor(() => expect(screen.getByText('Aurora')).toBeTruthy());
    fireEvent.click(screen.getByRole('button', { name: 'Set temperature' }));
    const input = await screen.findByRole('spinbutton');
    fireEvent.change(input, { target: { value: '24.5' } });
    fireEvent.click(screen.getByRole('button', { name: /send|issue|confirm/i }));
    await waitFor(() =>
      expect(apiMock).toHaveBeenCalledWith(
        '/api/v1/commands',
        expect.objectContaining({
          method: 'POST',
          body: expect.objectContaining({
            type: 'set_temperature',
            params: expect.objectContaining({ temperatureC: 24.5 }),
          }),
        }),
      ),
    );
  });

  it('flips a state-driven toggle and sends the flipped value', async () => {
    renderPage();
    await waitFor(() => expect(screen.getByText('Aurora')).toBeTruthy());
    fireEvent.click(screen.getByRole('button', { name: 'Security mode' }));
    const dialog = await screen.findByRole('dialog');
    const select = await within(dialog).findByRole('combobox');
    expect((select as HTMLSelectElement).value).toBe('on');
    fireEvent.change(select, { target: { value: 'off' } });
    fireEvent.click(screen.getByRole('button', { name: /send|issue|confirm/i }));
    await waitFor(() =>
      expect(apiMock).toHaveBeenCalledWith(
        '/api/v1/commands',
        expect.objectContaining({
          method: 'POST',
          body: expect.objectContaining({
            type: 'sentry_mode',
            params: expect.objectContaining({ sentryOn: false }),
          }),
        }),
      ),
    );
  });
});
