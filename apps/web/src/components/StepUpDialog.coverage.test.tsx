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

vi.mock('../lib/stepUpBus', () => ({
  setStepUpHandler: vi.fn(),
}));

import { act, fireEvent } from '@testing-library/react';
import { setStepUpHandler } from '../lib/stepUpBus';
import { StepUpDialogHost } from './StepUpDialog';

describe('StepUpDialogHost', () => {
  beforeEach(() => {
    vi.mocked(setStepUpHandler).mockClear();
    apiMock.mockImplementation(async (path: string) => {
      if (path === '/api/v1/auth/step-up') return {};
      if (path === '/api/v1/auth/step-up/passkey/options') {
        return {
          challenge: 'challenge',
          rpId: 'localhost',
          allowCredentials: [],
          timeout: 60000,
          userVerification: 'preferred',
        };
      }
      return {};
    });
  });

  function getInputByLabel(label: string): HTMLInputElement {
    const byLabel = screen.queryByLabelText(label);
    const input = (byLabel ?? document.querySelector('input')) as HTMLInputElement | null;
    expect(input).not.toBeNull();
    return input!;
  }

  async function triggerStepUp(methods: string[]): Promise<boolean> {
    const calls = vi.mocked(setStepUpHandler).mock.calls;
    const lastCall = calls[calls.length - 1];
    const handler = lastCall?.[0] as unknown as
      | ((methodsToUse: string[]) => Promise<boolean>)
      | undefined;
    expect(handler).toBeTruthy();

    let promise: Promise<boolean> = Promise.resolve(false);
    await act(async () => {
      promise = handler!(methods);
    });
    return promise;
  }

  it('renders nothing before a step-up is requested', async () => {
    renderPage('/overview', <StepUpDialogHost />);

    await waitFor(() => expect(setStepUpHandler).toHaveBeenCalled());
    expect(screen.queryByText('Step-up required')).toBeNull();
  });

  it('shows only the server-listed methods when step-up is requested', async () => {
    renderPage('/overview', <StepUpDialogHost />);

    await waitFor(() => expect(setStepUpHandler).toHaveBeenCalled());
    void triggerStepUp(['password', 'totp']);

    expect(await screen.findByText('Step-up required')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Password' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Authenticator code' })).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Passkey' })).toBeNull();
  });

  it('submits a password and resolves the pending step-up request', async () => {
    renderPage('/overview', <StepUpDialogHost />);

    await waitFor(() => expect(setStepUpHandler).toHaveBeenCalled());
    const pending = triggerStepUp(['password']);
    await screen.findByText('Step-up required');

    const passwordInput = getInputByLabel('Password');
    fireEvent.change(passwordInput, { target: { value: 'secret' } });

    const authorize = screen.getByRole('button', { name: 'Authorize & send' }) as HTMLButtonElement;
    expect(authorize.disabled).toBe(false);
    fireEvent.click(authorize);

    await waitFor(() => {
      expect(apiMock).toHaveBeenCalledWith('/api/v1/auth/step-up', {
        method: 'POST',
        body: { method: 'password', password: 'secret' },
      });
    });

    await expect(pending).resolves.toBe(true);
    await waitFor(() => expect(screen.queryByText('Step-up required')).toBeNull());
  });

  it('switches to authenticator code and requires a code before submitting', async () => {
    renderPage('/overview', <StepUpDialogHost />);

    await waitFor(() => expect(setStepUpHandler).toHaveBeenCalled());
    void triggerStepUp(['password', 'totp']);
    await screen.findByText('Step-up required');

    fireEvent.click(screen.getByRole('button', { name: 'Authenticator code' }));

    const codeInput = getInputByLabel('Authenticator code');
    const authorize = screen.getByRole('button', { name: 'Authorize & send' }) as HTMLButtonElement;
    expect(authorize.disabled).toBe(true);

    fireEvent.change(codeInput, { target: { value: '123456' } });
    expect(authorize.disabled).toBe(false);
  });
});
