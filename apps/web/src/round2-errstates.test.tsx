// R6: F-ERRSTATES — a slow vehicle list must read as loading (not "not found")
// and a failed list must show an error state with retry.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { render, screen, cleanup } from '@testing-library/react';
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
vi.mock('./webgl/VehicleViewer', () => ({
  default: () => <div data-testid="viewer" />,
}));

beforeEach(() => {
  vi.spyOn(window, 'scrollTo').mockImplementation(() => undefined);
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
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

describe('loading vs not-found (F-ERRSTATES)', () => {
  it('shows a loading state while the list is in flight', () => {
    apiMock.mockImplementation(() => new Promise(() => undefined));
    renderPage();
    expect(screen.getByText('Loading vehicle…')).toBeTruthy();
    expect(screen.queryByText('Vehicle not found.')).toBeNull();
  });

  it('shows an error state with retry when the list fails', async () => {
    const boom = new Error('backend down');
    apiMock.mockRejectedValue(boom);
    renderPage();
    expect(await screen.findByRole('button', { name: /retry/i })).toBeTruthy();
    expect(screen.queryByText('Vehicle not found.')).toBeNull();
  });
});
