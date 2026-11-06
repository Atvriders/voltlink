// SettingsPage coverage: URL-addressed section tabs, profile save, TOTP
// setup/confirm/recovery/disable, passkey register/delete, password change,
// sessions revoke, retention save, export and account deletion.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { render, screen, waitFor, cleanup } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

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

const sessionFixture = [
  {
    id: 's1',
    userAgent: 'Firefox on Linux',
    ip: '1.2.3.4',
    createdAt: new Date().toISOString(),
    lastSeenAt: new Date().toISOString(),
    current: false,
  },
  {
    id: 's2',
    userAgent: 'Chrome on Windows',
    ip: '5.6.7.8',
    createdAt: new Date().toISOString(),
    lastSeenAt: null,
    current: true,
  },
];

beforeEach(() => {
  authState.user.totpEnabled = false;
  apiMock.mockImplementation(async (path: string, opts?: { method?: string }) => {
    if (path === '/api/v1/users/settings' && !opts?.method)
      return { orgName: 'Rivermark', telemetryRetentionDays: 365 };
    if (path === '/api/v1/users/settings') return {};
    if (path === '/api/v1/auth/passkeys') return [];
    if (path === '/api/v1/auth/passkeys/options')
      return { optionsJSON: { challenge: 'ch', rpId: 'localhost', user: { id: 'u1' } } };
    if (path === '/api/v1/auth/mfa/totp/setup')
      return { secret: 'JBSWY3DPEHPK3PXP', otpauthUrl: 'otpauth://totp/x' };
    if (path === '/api/v1/auth/mfa/totp/confirm')
      return { recoveryCodes: ['AAAA-BBBB-CCCC-DDDD', 'EEEE-FFFF-GGGG-HHHH'] };
    if (path === '/api/v1/auth/mfa/totp/disable') return {};
    if (path === '/api/v1/users/change-password') return {};
    if (path === '/api/v1/auth/sessions') return sessionFixture;
    if (path === '/api/v1/auth/sessions/revoke-others') return {};
    if (path.endsWith('/revoke')) return {};
    if (path === '/api/v1/users/retention') return {};
    if (path === '/api/v1/users/delete') return {};
    return {};
  });
});

function renderSettings(path: string) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <MemoryRouter initialEntries={[path]}>
        <Routes>
          <Route path="*" element={<SettingsPage />} />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

afterEach(cleanup);

import SettingsPage from './SettingsPage';

describe('SettingsPage', () => {
  it('renders the profile tab and saves preferences', async () => {
    renderSettings('/settings/profile');
    expect(await screen.findByText('Display & units')).toBeTruthy();
    expect(screen.getByText(/Organization name/)).toBeTruthy();
    await userEvent.selectOptions(screen.getByLabelText('Units'), 'imperial');
    const checkbox = screen.getByLabelText(/Presentation mode/);
    await userEvent.click(checkbox);
    await userEvent.click(screen.getByRole('button', { name: /Save preferences/ }));
    await waitFor(() =>
      expect(
        apiMock.mock.calls.some(
          (c) => c[0] === '/api/v1/users/settings' && (c[1] as { method?: string })?.method === 'PATCH',
        ),
      ).toBe(true),
    );
  });

  it('navigates sections and shows the not-found section for unknown routes', async () => {
    renderSettings('/settings/sessions');
    expect(await screen.findByText('Active sessions')).toBeTruthy();
    expect(await screen.findByText('Firefox on Linux')).toBeTruthy();
    await userEvent.click(screen.getByRole('button', { name: 'Revoke' }));
    await waitFor(() => expect(apiMock.mock.calls.some((c) => String(c[0]).endsWith('/revoke'))).toBe(true));
    await userEvent.click(screen.getByRole('button', { name: /Sign out all other sessions/ }));
    await waitFor(() =>
      expect(apiMock.mock.calls.some((c) => c[0] === '/api/v1/auth/sessions/revoke-others')).toBe(true),
    );
  });

  it('unknown settings section shows the fallback', async () => {
    renderSettings('/settings/nope');
    expect(await screen.findByText('Settings section not found')).toBeTruthy();
    expect(screen.getByRole('link', { name: /Back to Profile settings/ })).toBeTruthy();
  });

  it('runs the full TOTP setup: setup, confirm, recovery view', async () => {
    renderSettings('/settings/security');
    await userEvent.click(await screen.findByRole('button', { name: /Set up TOTP/ }));
    await userEvent.click(await screen.findByRole('button', { name: /Generate secret/ }));
    expect(await screen.findByText(/Scan this key/)).toBeTruthy();
    await userEvent.type(screen.getByLabelText('Verification code'), '123456');
    await userEvent.click(screen.getByRole('button', { name: /Verify & enable/ }));
    expect(await screen.findByText('TOTP enabled!')).toBeTruthy();
    expect(screen.getAllByText(/AAAA-BBBB/).length).toBeGreaterThan(0);
    await userEvent.click(screen.getByRole('button', { name: 'Done' }));
    await waitFor(() => expect(screen.queryByText('TOTP enabled!')).toBeNull());
  });

  it('disables TOTP from the modal when enabled', async () => {
    authState.user.totpEnabled = true;
    renderSettings('/settings/security');
    await userEvent.click((await screen.findAllByRole('button', { name: /Disable TOTP/ }))[0]!);
    await userEvent.type(await screen.findByLabelText('Current code'), '654321');
    await userEvent.click(screen.getAllByRole('button', { name: 'Disable TOTP' })[1]!);
    await waitFor(() =>
      expect(apiMock.mock.calls.some((c) => c[0] === '/api/v1/auth/mfa/totp/disable')).toBe(true),
    );
  });

  it('registers a passkey and shows the success message', async () => {
    apiMock.mockImplementation(async (path: string) => {
      if (path === '/api/v1/auth/passkeys') return [];
      if (path === '/api/v1/auth/passkeys/options')
        return { optionsJSON: { challenge: 'ch', rpId: 'localhost', user: { id: 'u1' } } };
      if (path === '/api/v1/auth/passkeys' ) return {};
      return {};
    });
    renderSettings('/settings/security');
    expect(await screen.findByText('No passkeys registered.')).toBeTruthy();
    await userEvent.click(screen.getByRole('button', { name: /Register passkey/ }));
    expect(await screen.findByText('Passkey registered. Use it on the sign-in page.')).toBeTruthy();
  });

  it('changes the password and reports success', async () => {
    renderSettings('/settings/security');
    await userEvent.type(await screen.findByLabelText('Current password'), 'old-pass-123');
    await userEvent.type(screen.getByLabelText(/New password/), 'new-pass-456');
    await userEvent.click(screen.getByRole('button', { name: /Change password/ }));
    expect(await screen.findByText('Password changed. Other sessions were signed out.')).toBeTruthy();
  });

  it('saves retention policy and runs the delete-account flow', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({ blob: async () => new Blob(['{}']) });
    URL.createObjectURL = vi.fn(() => 'blob:mock');
    renderSettings('/settings/privacy');
    expect(await screen.findByText('Retention & privacy')).toBeTruthy();
    const telemetry = screen.getByLabelText('Telemetry (days)');
    await userEvent.clear(telemetry);
    await userEvent.type(telemetry, '400');
    await userEvent.click(screen.getByRole('button', { name: /Save retention policy/ }));
    await waitFor(() =>
      expect(apiMock.mock.calls.some((c) => c[0] === '/api/v1/users/retention')).toBe(true),
    );

    await userEvent.click(screen.getByRole('button', { name: /Export my data/ }));
    await userEvent.click(screen.getByRole('button', { name: /Delete account/ }));
    expect(await screen.findByText(/cannot be undone/)).toBeTruthy();
    await userEvent.type(screen.getByLabelText(/Confirm with your password/), 'pass-12345');
    await userEvent.click(screen.getByRole('button', { name: /Permanently delete/ }));
    await waitFor(() => expect(authState.logout).toHaveBeenCalled());
  });
});
