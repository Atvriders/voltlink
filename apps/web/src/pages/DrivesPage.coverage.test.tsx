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
import DrivesPage from './DrivesPage';

interface DriveFixture {
  id: string;
  vehicleName: string;
  startAt: string;
  endAt: string;
  distanceKm: number;
  durationSec: number;
  energyKwh: number;
  efficiencyWhPerKm: number;
  classification: 'business' | 'personal' | 'unknown';
}

const defaultDrives: DriveFixture[] = [
  {
    id: 'd1',
    vehicleName: 'Aurora Coach',
    startAt: '2024-01-15T08:00:00.000Z',
    endAt: '2024-01-15T08:30:00.000Z',
    distanceKm: 24.5,
    durationSec: 1800,
    energyKwh: 4.2,
    efficiencyWhPerKm: 171,
    classification: 'business',
  },
  {
    id: 'd2',
    vehicleName: 'Bolt Runabout',
    startAt: '2024-01-16T17:15:00.000Z',
    endAt: '2024-01-16T17:45:00.000Z',
    distanceKm: 12.1,
    durationSec: 1800,
    energyKwh: 2.1,
    efficiencyWhPerKm: 174,
    classification: 'personal',
  },
];

let driveItems: DriveFixture[] = defaultDrives;
let driveTotal = 45;

describe('DrivesPage', () => {
  beforeEach(() => {
    driveItems = defaultDrives;
    driveTotal = 45;
    apiMock.mockReset();
    csvMock.mockClear();
    csvMock.mockResolvedValue('a,b');
    Object.defineProperty(URL, 'createObjectURL', {
      writable: true,
      configurable: true,
      value: vi.fn(() => 'blob:mock'),
    });
    HTMLAnchorElement.prototype.click = () => {};

    apiMock.mockImplementation(async (path: string) => {
      if (path === '/api/v1/vehicles') {
        return [
          { id: 'v1', displayName: 'Aurora' },
          { id: 'v2', displayName: 'Bolt' },
        ];
      }
      if (path.startsWith('/api/v1/drives/totals')) {
        return {
          count: driveItems.length,
          distanceKm: 120.5,
          energyKwh: 24.3,
          estCost: 9.5,
          costPerKm: 0.08,
        };
      }
      if (path.startsWith('/api/v1/drives?')) {
        const params = new URLSearchParams(path.split('?')[1] ?? '');
        return {
          items: driveItems,
          total: driveTotal,
          page: Number(params.get('page') ?? '1'),
          pageSize: 20,
        };
      }
      if (path === '/api/v1/drives') {
        return { items: driveItems, total: driveTotal, page: 1, pageSize: 20 };
      }
      return {};
    });
  });

  it('renders drive rows and totals from the API', async () => {
    renderPage('/drives', <DrivesPage />);

    expect(await screen.findByText('Aurora Coach')).toBeTruthy();
    expect(screen.getByText('Drives')).toBeTruthy();
    expect(await screen.findByText(/2 drives/)).toBeTruthy();

    const link = screen.getByRole('link', { name: /Aurora Coach/i });
    expect(link.getAttribute('href')).toBe('/drives/d1');
  });

  it('updates the drives query when searching', async () => {
    const user = userEvent.setup();
    renderPage('/drives', <DrivesPage />);

    await screen.findByText('Aurora Coach');
    await user.type(screen.getByLabelText('Search drives'), 'pike');

    await waitFor(() => {
      expect(apiMock).toHaveBeenCalledWith(expect.stringContaining('search=pike'));
    });
  });

  it('filters by vehicle and classification', async () => {
    renderPage('/drives', <DrivesPage />);

    await screen.findByText('Aurora Coach');
    fireEvent.change(screen.getByLabelText('Vehicle'), { target: { value: 'v1' } });
    await waitFor(() => {
      expect(apiMock).toHaveBeenCalledWith(expect.stringContaining('vehicleId=v1'));
    });

    fireEvent.change(screen.getByLabelText('Classification'), {
      target: { value: 'business' },
    });
    await waitFor(() => {
      expect(apiMock).toHaveBeenCalledWith(expect.stringContaining('classification=business'));
    });
  });

  it('applies sorting and date filters', async () => {
    renderPage('/drives', <DrivesPage />);

    await screen.findByText('Aurora Coach');
    fireEvent.change(screen.getByLabelText('Sort'), {
      target: { value: 'distanceKm:desc' },
    });
    await waitFor(() => {
      expect(apiMock).toHaveBeenCalledWith(expect.stringContaining('sort=distanceKm'));
    });

    fireEvent.change(screen.getByLabelText('From date'), {
      target: { value: '2024-01-01' },
    });
    await waitFor(() => {
      expect(apiMock).toHaveBeenCalledWith(expect.stringContaining('from=2024-01-01'));
    });

    fireEvent.change(screen.getByLabelText('To date'), {
      target: { value: '2024-02-01' },
    });
    await waitFor(() => {
      expect(apiMock).toHaveBeenCalledWith(expect.stringContaining('to=2024-02-01'));
    });
  });

  it('paginates forward and backward through drive pages', async () => {
    const user = userEvent.setup();
    renderPage('/drives', <DrivesPage />);

    await screen.findByText('Aurora Coach');
    expect(await screen.findByText(/Page 1 of 3/)).toBeTruthy();

    await user.click(screen.getByRole('button', { name: 'Next' }));
    await waitFor(() => {
      expect(apiMock).toHaveBeenCalledWith(expect.stringContaining('page=2'));
    });
    expect(await screen.findByText(/Page 2 of 3/)).toBeTruthy();

    await user.click(screen.getByRole('button', { name: 'Previous' }));
    expect(await screen.findByText(/Page 1 of 3/)).toBeTruthy();
  });

  it('exports drives as CSV and JSON', async () => {
    const user = userEvent.setup();
    renderPage('/drives', <DrivesPage />);

    await screen.findByText('Aurora Coach');

    await user.click(screen.getByRole('button', { name: /CSV/i }));
    await waitFor(() => {
      expect(csvMock).toHaveBeenCalledWith('/api/v1/drives/export/csv');
    });

    await user.click(screen.getByRole('button', { name: /JSON/i }));
    await waitFor(() => {
      expect(csvMock).toHaveBeenCalledWith('/api/v1/drives/export/json');
    });
  });

  it('renders the empty state when no drives match', async () => {
    driveItems = [];
    driveTotal = 0;
    renderPage('/drives', <DrivesPage />);

    expect(await screen.findByText('No drives found')).toBeTruthy();
    expect(screen.getByText(/Try different filters/)).toBeTruthy();
  });
});
