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

import type * as React from 'react';
import userEvent from '@testing-library/user-event';
import { fireEvent } from '@testing-library/react';
import OnboardingPage from './OnboardingPage';

describe('OnboardingPage', () => {
  let onboardingStep = 'welcome';
  let onboardingCompletedAt: string | null = null;
  let meVerified = false;

  beforeEach(() => {
    onboardingStep = 'welcome';
    onboardingCompletedAt = null;
    meVerified = false;
    apiMock.mockReset();
    apiMock.mockImplementation(async (path: string, init?: { method?: string; body?: unknown }) => {
      if (path === '/api/v1/users/onboarding') {
        if (init?.method === 'PUT') return { ok: true };
        return { step: onboardingStep, completedAt: onboardingCompletedAt };
      }
      if (path === '/api/v1/auth/resend-verification') return { ok: true };
      if (path === '/api/v1/auth/me') {
        return {
          user: { ...authState.user, emailVerified: meVerified },
          memberships: [{ organizationId: 'org1' }],
        };
      }
      if (path === '/api/v1/users/settings') return { ok: true };
      if (path === '/api/v1/orgs/org1/settings/retention') return { ok: true };
      if (path === '/api/v1/providers/demo/connect') return { vehiclesImported: 3 };
      return {};
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('renders the welcome step, enforces Back on step 1, and advances to privacy', async () => {
    const user = userEvent.setup();
    renderPage('/', <OnboardingPage />);

    await screen.findByText('Welcome to VoltLink');
    expect(screen.getByText(/step 1 of 16/)).toBeTruthy();
    const back = screen.getByRole('button', { name: /back/i }) as HTMLButtonElement;
    expect(back.disabled).toBe(true);

    await user.click(screen.getByRole('button', { name: /continue/i }));
    await screen.findByText('Your data stays yours');
    expect(screen.getByText(/step 2 of 16/)).toBeTruthy();

    const backNow = screen.getByRole('button', { name: /back/i }) as HTMLButtonElement;
    expect(backNow.disabled).toBe(false);
    await user.click(backNow);
    await screen.findByText('Welcome to VoltLink');
    expect(screen.getByText(/step 1 of 16/)).toBeTruthy();
  });

  it('resumes at the server-provided onboarding step', async () => {
    onboardingStep = 'security';
    renderPage('/', <OnboardingPage />);

    await screen.findByText('Secure your account');
    expect(apiMock).toHaveBeenCalledWith('/api/v1/users/onboarding');
    await waitFor(() =>
      expect(apiMock).toHaveBeenCalledWith(
        '/api/v1/users/onboarding',
        expect.objectContaining({ method: 'PUT', body: { step: 'security' } }),
      ),
    );
  });

  it('shows account info and can resend a verification email', async () => {
    onboardingStep = 'account';
    meVerified = false;
    const user = userEvent.setup();
    renderPage('/', <OnboardingPage />);

    await screen.findByText(/Signed in as/);
    await user.click(screen.getByRole('button', { name: /continue/i }));
    await screen.findByText('Check your inbox for the verification link.');

    await user.click(screen.getByRole('button', { name: /resend verification email/i }));
    await waitFor(() =>
      expect(apiMock).toHaveBeenCalledWith(
        '/api/v1/auth/resend-verification',
        expect.objectContaining({ method: 'POST' }),
      ),
    );
  });

  it('connects the demo fleet and advances to units', async () => {
    onboardingStep = 'provider';
    const user = userEvent.setup();
    renderPage('/', <OnboardingPage />);

    await screen.findByText('Vehicles');
    await user.click(screen.getByRole('button', { name: /enable demo fleet/i }));
    await waitFor(() =>
      expect(apiMock).toHaveBeenCalledWith(
        '/api/v1/providers/demo/connect',
        expect.objectContaining({ method: 'POST' }),
      ),
    );
    await screen.findByText(/step 7 of 16/);
  });

  it('can skip demo setup and continue to units', async () => {
    onboardingStep = 'provider';
    const user = userEvent.setup();
    renderPage('/', <OnboardingPage />);

    await screen.findByText('Vehicles');
    await user.click(screen.getByRole('button', { name: /no vehicles yet/i }));
    await screen.findByText(/step 7 of 16/);
  });

  it('saves units, time zone, and retention before advancing', async () => {
    onboardingStep = 'units';
    const user = userEvent.setup();
    renderPage('/', <OnboardingPage />);
    await screen.findByText(/step 7 of 16/);

    fireEvent.change(screen.getByRole('combobox'), { target: { value: 'imperial' } });
    await user.click(screen.getByRole('button', { name: /continue/i }));
    await screen.findByText(/step 8 of 16/);
    await waitFor(() =>
      expect(apiMock).toHaveBeenCalledWith(
        '/api/v1/users/settings',
        expect.objectContaining({ method: 'PATCH', body: { units: 'imperial', timezone: 'UTC' } }),
      ),
    );

    fireEvent.change(screen.getByRole('combobox'), { target: { value: 'America/New_York' } });
    await user.click(screen.getByRole('button', { name: /continue/i }));
    await screen.findByText(/step 9 of 16/);
    await waitFor(() =>
      expect(apiMock).toHaveBeenCalledWith(
        '/api/v1/users/settings',
        expect.objectContaining({
          method: 'PATCH',
          body: { units: 'imperial', timezone: 'America/New_York' },
        }),
      ),
    );

    fireEvent.change(screen.getByRole('combobox'), { target: { value: '90' } });
    await user.click(screen.getByRole('button', { name: /continue/i }));
    await screen.findByText(/step 10 of 16/);
    await waitFor(() =>
      expect(apiMock).toHaveBeenCalledWith(
        '/api/v1/orgs/org1/settings/retention',
        expect.objectContaining({ method: 'PATCH', body: { telemetryRetentionDays: 90 } }),
      ),
    );
  });

  it('toggles in-app notifications and advances to vehicle import', async () => {
    onboardingStep = 'notifications';
    const user = userEvent.setup();
    renderPage('/', <OnboardingPage />);

    const checkbox = (await screen.findByRole('checkbox')) as HTMLInputElement;
    expect(checkbox.checked).toBe(true);
    await user.click(checkbox);
    expect(checkbox.checked).toBe(false);

    await user.click(screen.getByRole('button', { name: /continue/i }));
    await screen.findByText(/step 12 of 16/);
    expect(screen.getByText('Import your vehicles')).toBeTruthy();
  });

  it('walks through sharing, freshness, controls, and completes onboarding', async () => {
    onboardingStep = 'sharing';
    const user = userEvent.setup();
    renderPage('/', <OnboardingPage />);
    await screen.findByText('Sharing & access');

    await user.click(screen.getByRole('button', { name: /continue/i }));
    await screen.findByText('How data freshness works');

    await user.click(screen.getByRole('button', { name: /continue/i }));
    await screen.findByText('Control safety');

    await user.click(screen.getByRole('button', { name: /continue/i }));
    const finish = await screen.findByRole('button', { name: /open voltlink/i });
    await user.click(finish);

    await waitFor(() =>
      expect(apiMock).toHaveBeenCalledWith(
        '/api/v1/users/onboarding',
        expect.objectContaining({ method: 'PUT', body: { step: 'done', done: true } }),
      ),
    );
  });
});
