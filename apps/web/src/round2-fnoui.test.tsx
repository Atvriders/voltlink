// R6: F-NOUI — manual automation trigger and department/cost-center creation
// exist in the UI.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { render, screen, waitFor, cleanup, fireEvent } from '@testing-library/react';
import FleetPage from './pages/FleetPage';
import AutomationsPage from './pages/AutomationsPage';

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

const automation = {
  id: 'a1',
  name: 'Night climate',
  description: '',
  enabled: true,
  vehicleId: null,
  trigger: { type: 'scheduled', params: {} },
  actions: [{ type: 'climate_start', params: {} }],
  runCount: 3,
  lastRunAt: null,
  lastResult: 'success',
};

beforeEach(() => {
  apiMock.mockImplementation(async (path: string) => {
    if (path === '/api/v1/automations') return [automation];
    if (path.startsWith('/api/v1/automations/a1/trigger')) return { ok: true };
    if (path === '/api/v1/fleet/drivers') return [];
    if (path === '/api/v1/fleet/departments') return [];
    if (path === '/api/v1/fleet/cost-centers') return [];
    if (path === '/api/v1/fleet/assignments') return [];
    if (path === '/api/v1/fleet/groups') return [];
    if (path === '/api/v1/fleet/overview')
      return { vehicles: [], groups: [] };
    if (path === '/api/v1/vehicles') return [];
    if (path === '/api/v1/status')
      return { overall: 'operational', components: [], incidents: [], maintenance: [], updatedAt: new Date().toISOString() };
    if (path === '/api/v1/auth/setup-status') return { needsSetup: false, registrationMode: 'invite' };
    return {};
  });
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

function renderPage(path: string, ui: React.ReactNode) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
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

describe('missing UI capabilities (F-NOUI)', () => {
  it('offers a manual automation trigger', async () => {
    renderPage('/automations', <AutomationsPage />);
    await waitFor(() => expect(screen.getByText('Night climate')).toBeTruthy());
    fireEvent.click(screen.getByRole('button', { name: /run now/i }));
    await waitFor(() =>
      expect(apiMock).toHaveBeenCalledWith(
        '/api/v1/automations/a1/trigger',
        expect.objectContaining({ method: 'POST' }),
      ),
    );
  });

  it('creates a department from the drivers tab', async () => {
    renderPage('/fleet', <FleetPage />);
    await waitFor(() => expect(screen.getByRole('button', { name: /drivers/i })).toBeTruthy());
    fireEvent.click(screen.getByRole('button', { name: /drivers/i }));
    fireEvent.click(await screen.findByRole('button', { name: /add department/i }));
    fireEvent.change(await screen.findByLabelText('Department name'), { target: { value: 'R&D' } });
    fireEvent.click(screen.getByRole('button', { name: /create department/i }));
    await waitFor(() =>
      expect(apiMock).toHaveBeenCalledWith(
        '/api/v1/fleet/departments',
        expect.objectContaining({ method: 'POST', body: { name: 'R&D' } }),
      ),
    );
  });

  it('creates a cost center from the drivers tab', async () => {
    renderPage('/fleet', <FleetPage />);
    await waitFor(() => expect(screen.getByRole('button', { name: /drivers/i })).toBeTruthy());
    fireEvent.click(screen.getByRole('button', { name: /drivers/i }));
    fireEvent.click(await screen.findByRole('button', { name: /add cost center/i }));
    fireEvent.change(await screen.findByLabelText('Cost center name'), { target: { value: 'CC-1' } });
    fireEvent.click(screen.getByRole('button', { name: /create cost center/i }));
    await waitFor(() =>
      expect(apiMock).toHaveBeenCalledWith(
        '/api/v1/fleet/cost-centers',
        expect.objectContaining({ method: 'POST', body: { name: 'CC-1' } }),
      ),
    );
  });
});
