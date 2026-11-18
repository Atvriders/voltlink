// R6: F-LIFECYCLEUI — the lifecycle modal must read {command, events}, name
// terminal states, and offer Cancel for queued/submitted commands.
// TI-55: pin the runner time zone so a fallback to the LOCAL zone (instead of
// the user's) is always detectable, on every machine.
const pinnedTz = vi.hoisted(() => {
  process.env.TZ = 'UTC';
});
void pinnedTz;
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { render, screen, waitFor, cleanup, within } from '@testing-library/react';
import LiveVehiclePage from './LiveVehiclePage';

const apiMock = vi.fn();
vi.mock('../api/client', () => ({
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
const { tzState } = vi.hoisted(() => ({ tzState: { value: 'UTC' } }));
vi.mock('../auth/AuthContext', () => ({
  useAuth: () => ({
    user: {
      id: 'u1',
      email: 'a@test.dev',
      name: 'A',
      units: 'metric',
      timezone: tzState.value,
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
vi.mock('../webgl/VehicleViewer', () => ({
  default: () => <div data-testid="viewer" />,
}));

const vehicle = {
  id: 'v1',
  displayName: 'Aurora',
  exteriorColor: '#334455',
  providerVehicleId: 'demo-aurora',
  provider: 'demo',
  demo: true,
  capabilities: ['set_temperature'],
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

const baseCommand = {
  id: 'c1',
  vehicleId: 'v1',
  type: 'set_temperature',
  createdAt: new Date().toISOString(),
  params: {},
};

let currentStatus = 'queued';
let errorMsg: string | undefined;

beforeEach(() => {
  apiMock.mockImplementation(async (path: string) => {
    if (path === '/api/v1/vehicles') return [vehicle];
    if (path === `/api/v1/vehicles/${vehicle.id}`) return vehicle;
    if (path.includes('/drives/totals')) return { count: 0, distanceKm: 0, energyKwh: 0 };
    if (path.startsWith('/api/v1/drives')) return { items: [], total: 0, page: 1, pageSize: 20 };
    if (path.startsWith('/api/v1/charging')) return { items: [], total: 0 };
    if (path.startsWith('/api/v1/commands/c1/cancel')) return { ok: true };
    if (path.startsWith('/api/v1/commands?')) {
      return { items: [{ ...baseCommand, status: currentStatus }], total: 1 };
    }
    if (path.startsWith('/api/v1/commands/')) {
      // The REAL API shape: { command, events }.
      return {
        command: {
          ...baseCommand,
          status: currentStatus,
          ...(errorMsg ? { errorMessage: errorMsg } : {}),
        },
        events: [
          { id: 'e1', event: 'queued', detail: 'in queue', createdAt: new Date().toISOString() },
        ],
      };
    }
    return {};
  });
});

function setup(status: string, errorMessage?: string) {
  currentStatus = status;
  errorMsg = errorMessage;
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <MemoryRouter initialEntries={[`/vehicles/${vehicle.id}`]}>
        <Routes>
          <Route path="/vehicles/:id" element={<LiveVehiclePage />} />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe('lifecycle modal (F-LIFECYCLEUI)', () => {
  it('names the terminal state and shows the error from the wrapped response', async () => {
    setup('failed', 'Provider refused the command');
    await waitFor(() => expect(screen.getByText('Aurora')).toBeTruthy());
    await waitFor(() => expect(screen.getByText('Failed').closest('button')).toBeTruthy());
    screen.getByText('Failed').closest('button')!.click();
    const dialog = await screen.findByRole('dialog');
    // TI-40: scope the label assertions to the DIALOG — the activity badge
    // outside also reads 'Failed'.
    await waitFor(() => expect(within(dialog).getByText('Failed')).toBeTruthy());
    await waitFor(() =>
      expect(within(dialog).getByText('Provider refused the command')).toBeTruthy(),
    );
  });

  it('offers Cancel for a queued command', async () => {
    setup('queued');
    await waitFor(() => expect(screen.getByText('Aurora')).toBeTruthy());
    await waitFor(() => expect(screen.getByText('Queued').closest('button')).toBeTruthy());
    screen.getByText('Queued').closest('button')!.click();
    const cancel = await waitFor(() => screen.getByRole('button', { name: /cancel command/i }));
    cancel.click();
    await waitFor(() =>
      expect(apiMock).toHaveBeenCalledWith(
        '/api/v1/commands/c1/cancel',
        expect.objectContaining({ method: 'POST' }),
      ),
    );
  });

  it('prints audit-trail times in the user time zone (R2-59)', async () => {
    tzState.value = 'America/New_York';
    errorMsg = undefined;
    apiMock.mockImplementation(async (path: string) => {
      if (path === '/api/v1/vehicles') return [vehicle];
      if (path === `/api/v1/vehicles/${vehicle.id}`) return vehicle;
      if (path.startsWith('/api/v1/commands?'))
        return { items: [{ ...baseCommand, status: 'failed' }], total: 1 };
      if (path.startsWith('/api/v1/commands/'))
        return {
          command: { ...baseCommand, status: 'failed' },
          events: [
            {
              id: 'e1',
              event: 'queued',
              detail: 'in queue',
              createdAt: '2024-01-01T05:00:00.000Z',
            },
          ],
        };
      return {};
    });
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(
      <QueryClientProvider client={qc}>
        <MemoryRouter initialEntries={[`/vehicles/${vehicle.id}`]}>
          <Routes>
            <Route path="/vehicles/:id" element={<LiveVehiclePage />} />
          </Routes>
        </MemoryRouter>
      </QueryClientProvider>,
    );
    await waitFor(() => expect(screen.getByText('Aurora')).toBeTruthy());
    await waitFor(() => expect(screen.getByText('Failed').closest('button')).toBeTruthy());
    screen.getByText('Failed').closest('button')!.click();
    await waitFor(() => expect(screen.getByRole('dialog')).toBeTruthy());
    // 05:00Z is 00:00 in New York, never 05:00.
    await waitFor(() => expect(screen.getByText(/12:00 AM/)).toBeTruthy());
    tzState.value = 'UTC';
  });
});
