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

import userEvent from '@testing-library/user-event';
import { fireEvent } from '@testing-library/react';
import ChargingPage from './ChargingPage';

vi.mock('../lib/vehicleSelection', () => ({
  useSelectedVehicle: () => ({ selectedId: null, setSelectedId: vi.fn() }),
}));

const sessions = [
  {
    id: 's1',
    vehicleId: 'v1',
    vehicleName: 'Aurora',
    startAt: '2024-05-01T10:00:00.000Z',
    endAt: '2024-05-01T11:30:00.000Z',
    energyAddedKwh: 32.5,
    cost: 6.5,
    currency: 'USD',
    source: 'home',
    rateName: 'Home TOU',
    pricePerKwh: 0.2,
    manualCost: null,
  },
  {
    id: 's2',
    vehicleId: 'v1',
    vehicleName: 'Aurora',
    startAt: '2024-05-02T12:00:00.000Z',
    endAt: null,
    energyAddedKwh: 18,
    cost: 7.2,
    currency: 'USD',
    source: 'fast',
    pricePerKwh: 0.4,
    manualCost: 5.5,
  },
];

const rateRules = [
  {
    id: 'r1',
    name: 'Home TOU',
    type: 'tou',
    enabled: true,
    pricePerKwh: 0.16,
    currency: 'USD',
    periods: [
      { startMin: 0, endMin: 360, pricePerKwh: 0.09 },
      { startMin: 360, endMin: 720, pricePerKwh: 0.16 },
    ],
  },
  {
    id: 'r2',
    name: 'Flat',
    type: 'flat',
    enabled: false,
    pricePerKwh: 0.25,
    currency: 'USD',
    periods: [],
  },
];

let chargingTotal = 2;

describe('ChargingPage', () => {
  beforeEach(() => {
    chargingTotal = 2;
    apiMock.mockClear();
    csvMock.mockClear();
    const base = apiMock.getMockImplementation();
    apiMock.mockImplementation(async (path: string, init?: { method?: string; body?: unknown }) => {
      if (path === '/api/v1/charging/totals') {
        return { count: 2, energyKwh: 50.5, cost: 13.7 };
      }
      if (path === '/api/v1/charging/rates/list') {
        if (init?.method === 'POST') {
          const body = init.body as {
            name: string;
            type: string;
            pricePerKwh: number;
            periods: unknown[];
          };
          return {
            id: 'r3',
            name: body.name,
            type: body.type,
            enabled: true,
            pricePerKwh: body.pricePerKwh,
            currency: 'USD',
            periods: body.periods,
          };
        }
        return rateRules;
      }
      if (path.startsWith('/api/v1/charging?')) {
        return { items: sessions, total: chargingTotal };
      }
      if (/^\/api\/v1\/charging\/[^/?]+$/.test(path) && init?.method === 'PATCH') {
        return { ok: true };
      }
      return base ? base(path, init) : {};
    });
  });

  it('renders charging sessions, totals, and rate rules', async () => {
    renderPage('/charging', <ChargingPage />);
    expect(await screen.findByText(/2 sessions/)).toBeTruthy();
    await waitFor(() => expect(screen.getAllByText('Aurora').length).toBeGreaterThan(0));
    expect(screen.getByText('Electricity rates')).toBeTruthy();
    expect(screen.getAllByText('Home TOU').length).toBeGreaterThan(0);
    expect(await screen.findByText(/2 time-of-use periods/)).toBeTruthy();
  });

  it('filters sessions by vehicle and source', async () => {
    renderPage('/charging', <ChargingPage />);
    await screen.findByText(/2 sessions/);
    await screen.findByRole('option', { name: 'Aurora' });

    const vehicleSelect = screen.getByLabelText('Vehicle');
    fireEvent.change(vehicleSelect, { target: { value: 'v1' } });
    await waitFor(() =>
      expect(apiMock.mock.calls.some((call) => String(call[0]).includes('vehicleId=v1'))).toBe(
        true,
      ),
    );

    const sourceSelect = screen.getByLabelText('Source');
    fireEvent.change(sourceSelect, { target: { value: 'home' } });
    await waitFor(() =>
      expect(apiMock.mock.calls.some((call) => String(call[0]).includes('source=home'))).toBe(
        true,
      ),
    );
  });

  it('opens the cost correction modal and saves a manual override', async () => {
    const user = userEvent.setup();
    renderPage('/charging', <ChargingPage />);
    const adjustButtons = await screen.findAllByText('Adjust');
    await user.click(adjustButtons[0]!);
    expect(screen.getByText('Correct charging cost')).toBeTruthy();

    const input = screen.getByRole('spinbutton');
    fireEvent.change(input, { target: { value: '12.34' } });
    await user.click(screen.getByText('Save'));

    await waitFor(() => {
      const patch = apiMock.mock.calls.find(
        (call) =>
          String(call[0]) === '/api/v1/charging/s1' &&
          (call[1] as { method?: string })?.method === 'PATCH',
      );
      expect(patch).toBeTruthy();
      expect((patch![1] as { body: { manualCost: number } }).body.manualCost).toBe(12.34);
    });
    await waitFor(() => expect(screen.queryByText('Correct charging cost')).toBeNull());
  });

  it('creates a time-of-use rate rule from the modal', async () => {
    const user = userEvent.setup();
    renderPage('/charging', <ChargingPage />);
    await screen.findByText('Electricity rates');
    await user.click(screen.getByText('New rule'));
    expect(screen.getByText('New electricity rate rule')).toBeTruthy();

    await user.type(screen.getByPlaceholderText('Home TOU'), 'My TOU');
    const typeSelect = screen.getByDisplayValue('Flat rate');
    fireEvent.change(typeSelect, { target: { value: 'tou' } });

    const periodsInput = screen.getByDisplayValue('0.09,0.16,0.28,0.16');
    fireEvent.change(periodsInput, { target: { value: '0.1,0.2,0.3,0.4' } });

    await user.click(screen.getByText('Create rule'));
    await waitFor(() => {
      const post = apiMock.mock.calls.find(
        (call) =>
          String(call[0]) === '/api/v1/charging/rates/list' &&
          (call[1] as { method?: string })?.method === 'POST',
      );
      expect(post).toBeTruthy();
      const body = (post![1] as {
        body: { name: string; type: string; periods: unknown[] };
      }).body;
      expect(body.name).toBe('My TOU');
      expect(body.type).toBe('tou');
      expect(body.periods).toHaveLength(4);
    });
    await waitFor(() => expect(screen.queryByText('New electricity rate rule')).toBeNull());
  });

  it('exports charging data as CSV and JSON', async () => {
    const user = userEvent.setup();
    const createObjectURL = vi.fn(() => 'blob:mock');
    Object.defineProperty(URL, 'createObjectURL', {
      value: createObjectURL,
      configurable: true,
    });
    const anchorClick = vi
      .spyOn(HTMLAnchorElement.prototype, 'click')
      .mockImplementation(() => {});

    renderPage('/charging', <ChargingPage />);
    await screen.findByText(/2 sessions/);

    await user.click(screen.getByText('CSV'));
    await waitFor(() => expect(csvMock).toHaveBeenCalledWith('/api/v1/charging/export/csv'));
    await waitFor(() => expect(createObjectURL).toHaveBeenCalled());

    await user.click(screen.getByText('JSON'));
    await waitFor(() => expect(csvMock).toHaveBeenCalledWith('/api/v1/charging/export/json'));

    anchorClick.mockRestore();
  });

  it('paginates through charging sessions', async () => {
    chargingTotal = 16;
    const user = userEvent.setup();
    renderPage('/charging', <ChargingPage />);
    expect(await screen.findByText('Page 1 of 2')).toBeTruthy();

    await user.click(screen.getByText('Next'));
    await waitFor(() =>
      expect(apiMock.mock.calls.some((call) => String(call[0]).includes('page=2'))).toBe(true),
    );
    expect(await screen.findByText('Page 2 of 2')).toBeTruthy();

    await user.click(screen.getByText('Previous'));
    await waitFor(() =>
      expect(
        apiMock.mock.calls.filter((call) => String(call[0]).includes('page=1')).length,
      ).toBeGreaterThan(1),
    );
    expect(await screen.findByText('Page 1 of 2')).toBeTruthy();
  });

  it('closes modals without saving', async () => {
    const user = userEvent.setup();
    renderPage('/charging', <ChargingPage />);
    const adjustButtons = await screen.findAllByText('Adjust');

    await user.click(adjustButtons[0]!);
    expect(screen.getByText('Correct charging cost')).toBeTruthy();
    await user.click(screen.getByText('Cancel'));
    await waitFor(() => expect(screen.queryByText('Correct charging cost')).toBeNull());

    await user.click(screen.getByText('New rule'));
    expect(screen.getByText('New electricity rate rule')).toBeTruthy();
    await user.click(screen.getByText('Cancel'));
    await waitFor(() => expect(screen.queryByText('New electricity rate rule')).toBeNull());
  });
});
