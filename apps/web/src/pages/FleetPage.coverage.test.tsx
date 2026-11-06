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

import { fireEvent, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import FleetPage from './FleetPage';

type ApiInit = { method?: string; body?: unknown };

let emptyMode = false;

const fleetVehicle = {
  id: 'v1',
  displayName: 'Aurora',
  make: 'Tesla',
  model: 'Model 3',
  labels: ['pool'],
  vehicleClass: 'suv',
  batteryPct: 72,
  charging: true,
  offline: false,
  demo: true,
  fetchedAt: new Date().toISOString(),
};

const offlineVehicle = {
  id: 'v2',
  displayName: 'Borealis',
  make: 'Rivian',
  model: 'R1T',
  labels: [],
  vehicleClass: 'pickup_truck',
  batteryPct: null,
  charging: false,
  offline: true,
  demo: false,
  fetchedAt: null,
};

const fleetGroup = {
  id: 'g1',
  name: 'Ops',
  description: 'Operations fleet',
  vehicleIds: ['v1'],
};

const driver = { id: 'd1', name: 'Sam', email: 'sam@example.test' };
const department = { id: 'dep1', name: 'Support' };
const costCenter = { id: 'cc1', name: 'Field Ops' };
const assignment = {
  id: 'a1',
  vehicleId: 'v1',
  driverId: 'd1',
  vehicleName: 'Aurora',
  driverName: 'Sam',
};

const overdueRecord = {
  id: 'm1',
  vehicleId: 'v1',
  vehicleName: 'Aurora',
  title: 'Tire rotation',
  kind: 'tires',
  dueAt: '2020-01-01T00:00:00.000Z',
  completedAt: null,
};

const completedRecord = {
  id: 'm2',
  vehicleId: 'v1',
  vehicleName: 'Aurora',
  title: 'Registration renewal',
  kind: 'registration',
  dueAt: null,
  completedAt: '2021-01-01T00:00:00.000Z',
};

describe('FleetPage', () => {
  beforeEach(() => {
    emptyMode = false;
    vi.spyOn(window, 'confirm').mockReturnValue(true);

    apiMock.mockImplementation(async (path: string, init?: ApiInit) => {
      const method = init?.method ?? 'GET';

      if (path === '/api/v1/fleet/overview') {
        if (emptyMode) {
          return {
            vehicles: [],
            driverCount: 0,
            departmentCount: 0,
            costCenterCount: 0,
            groupCount: 0,
            maintenanceDue: 0,
          };
        }
        return {
          vehicles: [fleetVehicle, offlineVehicle],
          driverCount: 1,
          departmentCount: 1,
          costCenterCount: 1,
          groupCount: 1,
          maintenanceDue: 1,
        };
      }

      if (path === '/api/v1/fleet/groups') {
        if (method === 'POST') return { id: 'g2', name: 'Service', vehicleIds: [] };
        return emptyMode ? [] : [fleetGroup];
      }
      if (/^\/api\/v1\/fleet\/groups\/[^/]+\/vehicles$/.test(path)) return { ok: true };
      if (/^\/api\/v1\/fleet\/groups\/[^/]+$/.test(path)) return { ok: true };

      if (path === '/api/v1/fleet/drivers') {
        if (method === 'POST') return { id: 'd2', name: 'Kim', email: '' };
        return emptyMode ? [] : [driver];
      }
      if (/^\/api\/v1\/fleet\/drivers\/[^/]+$/.test(path)) return { ok: true };

      if (path === '/api/v1/fleet/departments') return emptyMode ? [] : [department];
      if (path === '/api/v1/fleet/cost-centers') return emptyMode ? [] : [costCenter];

      if (path === '/api/v1/fleet/assignments') {
        if (method === 'POST') return { id: 'a2' };
        return emptyMode ? [] : [assignment];
      }
      if (/^\/api\/v1\/fleet\/assignments\/[^/]+$/.test(path)) return { ok: true };

      if (path === '/api/v1/fleet/maintenance') {
        if (method === 'POST') return { id: 'm3' };
        return emptyMode ? [] : [overdueRecord, completedRecord];
      }
      if (/^\/api\/v1\/fleet\/maintenance\/[^/]+$/.test(path)) return { ok: true };

      if (path === '/api/v1/vehicles') {
        return emptyMode
          ? []
          : [
              { id: 'v1', displayName: 'Aurora' },
              { id: 'v2', displayName: 'Borealis' },
            ];
      }

      return {};
    });
  });

  it('renders the fleet overview summary and vehicle rows', async () => {
    renderPage('/fleet', <FleetPage />);

    expect(await screen.findByText('Aurora')).toBeTruthy();
    expect(screen.getByText('Borealis')).toBeTruthy();
    expect(screen.getByText('Tesla Model 3')).toBeTruthy();
    expect(
      screen.getByText(/2 vehicles · 1 charging · 1 offline · 1 need attention/),
    ).toBeTruthy();
    expect(screen.getByText('72%')).toBeTruthy();
    expect(screen.getByText('pickup truck')).toBeTruthy();
    expect(screen.getByText('demo')).toBeTruthy();
    expect(screen.getByText('offline')).toBeTruthy();
    expect(screen.getByText('Fleet')).toBeTruthy();
  });

  it('shows the empty state when the fleet has no vehicles', async () => {
    emptyMode = true;
    renderPage('/fleet', <FleetPage />);

    expect(await screen.findByText('No fleet vehicles')).toBeTruthy();
    expect(screen.getByText(/0 vehicles · 0 charging · 0 offline/)).toBeTruthy();
  });

  it('opens the groups tab and creates a new group', async () => {
    const user = userEvent.setup();
    renderPage('/fleet', <FleetPage />);

    await user.click(screen.getByRole('button', { name: 'groups' }));

    expect(await screen.findByText('Vehicle groups')).toBeTruthy();
    expect(screen.getByText('Ops')).toBeTruthy();
    expect(screen.getByText('Operations fleet')).toBeTruthy();

    await user.click(screen.getByRole('button', { name: /new group/i }));
    expect(screen.getByText('New vehicle group')).toBeTruthy();

    await user.type(screen.getByRole('textbox'), 'Service');
    await user.click(screen.getByRole('button', { name: 'Create' }));

    await waitFor(() => {
      expect(apiMock).toHaveBeenCalledWith(
        '/api/v1/fleet/groups',
        expect.objectContaining({ method: 'POST', body: { name: 'Service' } }),
      );
    });
  });

  it('toggles vehicle membership and deletes a group', async () => {
    const user = userEvent.setup();
    renderPage('/fleet', <FleetPage />);

    await user.click(screen.getByRole('button', { name: 'groups' }));

    const borealis = await screen.findByRole('button', { name: 'Borealis' });
    await user.click(borealis);

    await waitFor(() => {
      expect(apiMock).toHaveBeenCalledWith(
        '/api/v1/fleet/groups/g1/vehicles',
        expect.objectContaining({ method: 'PUT', body: { vehicleIds: ['v1', 'v2'] } }),
      );
    });

    await user.click(screen.getByRole('button', { name: 'Delete Ops' }));

    await waitFor(() => {
      expect(apiMock).toHaveBeenCalledWith(
        '/api/v1/fleet/groups/g1',
        expect.objectContaining({ method: 'DELETE' }),
      );
    });
  });

  it('renders drivers with departments/cost centers and adds a driver', async () => {
    const user = userEvent.setup();
    renderPage('/fleet', <FleetPage />);

    await user.click(screen.getByRole('button', { name: 'drivers' }));

    expect((await screen.findAllByText('Sam')).length).toBeGreaterThan(0);
    expect(screen.getByText('sam@example.test')).toBeTruthy();
    expect(screen.getByText(/Departments: Support/)).toBeTruthy();
    expect(screen.getByText(/Cost centers: Field Ops/)).toBeTruthy();

    const openButton = screen
      .getAllByRole('button', { name: /add driver/i })
      .find((b) => !(b as HTMLButtonElement).disabled);
    expect(openButton).toBeTruthy();
    await user.click(openButton!);

    expect(screen.getAllByText('Add driver').length).toBeGreaterThan(0);

    const textboxes = screen.getAllByRole('textbox');
    await user.type(textboxes[0]!, 'Kim');

    await user.click(screen.getAllByRole('button', { name: 'Add driver' }).at(-1)!);

    await waitFor(() => {
      expect(apiMock).toHaveBeenCalledWith(
        '/api/v1/fleet/drivers',
        expect.objectContaining({ method: 'POST' }),
      );
    });
  });

  it('removes a driver and unassigns a vehicle', async () => {
    const user = userEvent.setup();
    renderPage('/fleet', <FleetPage />);

    await user.click(screen.getByRole('button', { name: 'drivers' }));

    const driverRow = (await screen.findAllByText('Sam'))[0]!.closest('li');
    expect(driverRow).toBeTruthy();
    await user.click(within(driverRow as HTMLElement).getByRole('button'));

    await waitFor(() => {
      expect(apiMock).toHaveBeenCalledWith(
        '/api/v1/fleet/drivers/d1',
        expect.objectContaining({ method: 'DELETE' }),
      );
    });

    const assignmentEl = screen.getAllByText(
      (_, el) => el?.textContent === 'Aurora → Sam',
    )[0]!;
    const assignmentRow = assignmentEl.closest('li') ?? assignmentEl.parentElement!;
    await user.click(within(assignmentRow as HTMLElement).getAllByRole('button')[0]!);

    await waitFor(() => {
      expect(apiMock).toHaveBeenCalledWith(
        '/api/v1/fleet/assignments/a1',
        expect.objectContaining({ method: 'DELETE' }),
      );
    });
  });

  it('assigns a vehicle to a driver from the assignments card', async () => {
    const user = userEvent.setup();
    renderPage('/fleet', <FleetPage />);

    await user.click(screen.getByRole('button', { name: 'drivers' }));

    const vehicleSelect = await screen.findByLabelText('Vehicle to assign');
    await screen.findByRole('option', { name: 'Borealis' });
    fireEvent.change(vehicleSelect, { target: { value: 'v1' } });

    const driverSelect = screen.getByLabelText('Driver');
    await screen.findByRole('option', { name: 'Sam' });
    fireEvent.change(driverSelect, { target: { value: 'd1' } });

    const assignButton = screen.getByRole('button', { name: 'Assign' });
    await waitFor(() => {
      expect((assignButton as HTMLButtonElement).disabled).toBe(false);
    });
    await user.click(assignButton);

    await waitFor(() => {
      expect(apiMock).toHaveBeenCalledWith(
        '/api/v1/fleet/assignments',
        expect.objectContaining({ method: 'POST', body: { vehicleId: 'v1', driverId: 'd1' } }),
      );
    });
  });

  it('renders maintenance records and completes an overdue record', async () => {
    const user = userEvent.setup();
    renderPage('/fleet', <FleetPage />);

    await user.click(screen.getByRole('button', { name: 'maintenance' }));

    expect(await screen.findByText('Tire rotation')).toBeTruthy();
    expect(screen.getByText('tires')).toBeTruthy();
    expect(screen.getByText('Registration renewal')).toBeTruthy();
    expect(screen.getByText('Reopen')).toBeTruthy();

    await user.click(screen.getByRole('button', { name: 'Complete' }));

    await waitFor(() => {
      expect(apiMock).toHaveBeenCalledWith(
        '/api/v1/fleet/maintenance/m1',
        expect.objectContaining({ method: 'PATCH' }),
      );
    });
  });

  it('reopens a completed maintenance record', async () => {
    const user = userEvent.setup();
    renderPage('/fleet', <FleetPage />);

    await user.click(screen.getByRole('button', { name: 'maintenance' }));

    await user.click(await screen.findByRole('button', { name: 'Reopen' }));

    await waitFor(() => {
      expect(apiMock).toHaveBeenCalledWith(
        '/api/v1/fleet/maintenance/m2',
        expect.objectContaining({ method: 'PATCH', body: { completedAt: null } }),
      );
    });
  });

  it('adds a maintenance record from the modal', async () => {
    const user = userEvent.setup();
    renderPage('/fleet', <FleetPage />);

    await user.click(screen.getByRole('button', { name: 'maintenance' }));

    const openButton = (await screen.findAllByRole('button', { name: /add record/i })).find(
      (b) => !(b as HTMLButtonElement).disabled,
    );
    expect(openButton).toBeTruthy();
    await user.click(openButton!);

    expect(screen.getByText('Add maintenance record')).toBeTruthy();

    const submit = screen
      .getAllByRole('button', { name: 'Add record' })
      .find((b) => (b as HTMLButtonElement).disabled);
    expect(submit).toBeTruthy();

    await screen.findByRole('option', { name: 'Aurora' });
    const combos = screen.getAllByRole('combobox');
    fireEvent.change(combos[0], { target: { value: 'v1' } });

    await user.type(screen.getByRole('textbox'), 'Oil change');

    await user.click(submit!);

    await waitFor(() => {
      expect(apiMock).toHaveBeenCalledWith(
        '/api/v1/fleet/maintenance',
        expect.objectContaining({
          method: 'POST',
          body: expect.objectContaining({ vehicleId: 'v1', title: 'Oil change' }),
        }),
      );
    });
  });
});
