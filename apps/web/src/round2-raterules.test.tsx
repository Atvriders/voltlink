// R6: F-NOUI — location-specific rate rules pick a real place, and rules can
// be deleted from the UI.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { render, screen, waitFor, cleanup, fireEvent, within } from '@testing-library/react';
import ChargingPage from './pages/ChargingPage';

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

const rules = [
  { id: 'r1', name: 'Night rate', type: 'location', pricePerKwh: 0.2, currency: 'USD', enabled: true, placeId: null, periods: [] },
];

beforeEach(() => {
  apiMock.mockImplementation(async (path: string) => {
    if (path === '/api/v1/charging/rates/list') return rules;
    if (path === '/api/v1/vehicles') return [{ id: 'v1', displayName: 'Aurora' }];
    if (path === '/api/v1/status')
      return { overall: 'operational', components: [], incidents: [], maintenance: [], updatedAt: new Date().toISOString() };
    if (path === '/api/v1/auth/setup-status') return { needsSetup: false, registrationMode: 'invite' };
    if (path === '/api/v1/vehicles/places/all')
      return [{ id: 'p1', name: 'Home', type: 'home', lat: 40, lon: -100 }];
    if (path.startsWith('/api/v1/charging')) return { items: [], total: 0 };
    if (path === '/api/v1/charging/totals') return { count: 0, energyKwh: 0, cost: 0 };
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
      <MemoryRouter initialEntries={['/charging']}>
        <Routes>
          <Route path="/charging" element={<ChargingPage />} />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

describe('rate rule editing (F-NOUI)', () => {
  it('sends placeId for a location-specific rule', async () => {
    renderPage();
    await waitFor(() => expect(screen.getByText('Night rate')).toBeTruthy());
    fireEvent.click(screen.getByRole('button', { name: /new rule/i }));
    const dialog = await screen.findByRole('dialog');
    fireEvent.change(within(dialog).getByRole('textbox'), { target: { value: 'Office rate' } });
    const selects = within(dialog).getAllByRole('combobox');
    fireEvent.change(selects[0]!, { target: { value: 'location' } });
    const placeSelect = await within(dialog).findByLabelText(/place/i);
    fireEvent.change(placeSelect, { target: { value: 'p1' } });
    fireEvent.click(within(dialog).getByRole('button', { name: /create rule/i }));
    await waitFor(() =>
      expect(apiMock).toHaveBeenCalledWith(
        '/api/v1/charging/rates/list',
        expect.objectContaining({
          method: 'POST',
          body: expect.objectContaining({ type: 'location', placeId: 'p1' }),
        }),
      ),
    );
  });

  it('deletes a rule from the list', async () => {
    vi.spyOn(window, 'confirm').mockReturnValue(true);
    renderPage();
    await waitFor(() => expect(screen.getByText('Night rate')).toBeTruthy());
    fireEvent.click(screen.getByRole('button', { name: /delete rule night rate/i }));
    await waitFor(() =>
      expect(apiMock).toHaveBeenCalledWith(
        '/api/v1/charging/rates/list/r1',
        expect.objectContaining({ method: 'DELETE' }),
      ),
    );
  });
});
