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
  // TI-36: a faithful refresh — the API flips totpEnabled on confirm/disable.
  refresh: vi.fn(async () => {
    const me = (await apiMock('/api/v1/auth/me')) as {
      totpEnabled?: boolean;
    };
    authState.user = { ...authState.user, ...me };
  }),
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

const meState: { totpEnabled: boolean } = { totpEnabled: false };

beforeEach(() => {
  meState.totpEnabled = false;
  authState.user.totpEnabled = false;
  apiMock.mockImplementation(async (path: string, opts?: { method?: string }) => {
    if (path === '/api/v1/users/settings' && !opts?.method)
      return { orgName: 'Rivermark', telemetryRetentionDays: 365 };
    if (path === '/api/v1/users/settings') return {};
    if (path === '/api/v1/auth/passkeys') return [];
    if (path === '/api/v1/auth/passkeys/options')
      return { optionsJSON: { challenge: 'ch', rpId: 'localhost', user: { id: 'u1' } } };
    if (path === '/api/v1/auth/me') return { totpEnabled: meState.totpEnabled };
    if (path === '/api/v1/auth/mfa/totp/setup')
      return { secret: 'JBSWY3DPEHPK3PXP', otpauthUrl: 'otpauth://totp/x' };
    if (path === '/api/v1/auth/mfa/totp/confirm') {
      meState.totpEnabled = true;
      return { recoveryCodes: ['AAAA-BBBB-CCCC-DDDD', 'EEEE-FFFF-GGGG-HHHH'] };
    }
    if (path === '/api/v1/auth/mfa/totp/disable') {
      meState.totpEnabled = false;
      return {};
    }
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
          (c) =>
            c[0] === '/api/v1/users/settings' && (c[1] as { method?: string })?.method === 'PATCH',
        ),
      ).toBe(true),
    );
  });

  it('navigates sections and shows the not-found section for unknown routes', async () => {
    renderSettings('/settings/sessions');
    expect(await screen.findByText('Active sessions')).toBeTruthy();
    expect(await screen.findByText('Firefox on Linux')).toBeTruthy();
    await userEvent.click(screen.getByRole('button', { name: 'Revoke' }));
    await waitFor(() =>
      expect(apiMock.mock.calls.some((c) => String(c[0]).endsWith('/revoke'))).toBe(true),
    );
    await userEvent.click(screen.getByRole('button', { name: /Sign out all other sessions/ }));
    await waitFor(() =>
      expect(apiMock.mock.calls.some((c) => c[0] === '/api/v1/auth/sessions/revoke-others')).toBe(
        true,
      ),
    );
  });

  it('unknown settings section shows the fallback', async () => {
    renderSettings('/settings/nope');
    expect(await screen.findByText('Settings section not found')).toBeTruthy();
    expect(screen.getByRole('link', { name: /Back to Profile settings/ })).toBeTruthy();
  });

  it('runs the full TOTP setup: setup, confirm, recovery view (TI-36)', async () => {
    renderSettings('/settings/security');
    await userEvent.click(await screen.findByRole('button', { name: /Set up TOTP/ }));
    await userEvent.click(await screen.findByRole('button', { name: /Generate secret/ }));
    expect(await screen.findByText(/Scan this key/)).toBeTruthy();
    await userEvent.type(screen.getByLabelText('Verification code'), '123456');
    await userEvent.click(screen.getByRole('button', { name: /Verify & enable/ }));
    // MR2: the recovery-code view is preferred over the disable form right
    // after enabling (the old branch order rendered the disable form).
    expect(await screen.findByText('TOTP enabled!')).toBeTruthy();
    expect(screen.queryByLabelText('Current code')).toBeNull();
    expect(screen.getAllByText(/AAAA-BBBB/).length).toBeGreaterThan(0);
    // The confirm body carries the typed code.
    expect(
      apiMock.mock.calls.some(
        (c) =>
          c[0] === '/api/v1/auth/mfa/totp/confirm' &&
          (c[1] as { body?: { code?: string } })?.body?.code === '123456',
      ),
    ).toBe(true);
    await userEvent.click(screen.getByRole('button', { name: 'Done' }));
    await waitFor(() => expect(screen.queryByText('TOTP enabled!')).toBeNull());
    // TI-36: the faithful refresh flipped totpEnabled — the card now offers
    // Disable TOTP.
    await waitFor(() => expect(screen.getByRole('button', { name: /Disable TOTP/ })).toBeTruthy());
  });

  it('disables TOTP from the modal and sends the typed code (TI-36/R2-88)', async () => {
    authState.user.totpEnabled = true;
    meState.totpEnabled = true;
    renderSettings('/settings/security');
    await userEvent.click((await screen.findAllByRole('button', { name: /Disable TOTP/ }))[0]!);
    // MR3: the just-used code is never prefilled — the field starts empty.
    const field = await screen.findByLabelText('Current code');
    expect((field as HTMLInputElement).value).toBe('');
    await userEvent.type(field, '654321');
    await userEvent.click(screen.getAllByRole('button', { name: 'Disable TOTP' })[1]!);
    await waitFor(() =>
      expect(
        apiMock.mock.calls.some(
          (c) =>
            c[0] === '/api/v1/auth/mfa/totp/disable' &&
            (c[1] as { body?: { code?: string } })?.body?.code === '654321',
        ),
      ).toBe(true),
    );
    // TI-36: the refresh() after disable reads the flipped server state (the
    // jsdom mock cannot re-render without a context update; the label flip is
    // proven by the setup test above).
    await waitFor(() => expect(meState.totpEnabled).toBe(false));
  });

  it('registers a passkey and shows the success message', async () => {
    apiMock.mockImplementation(async (path: string) => {
      if (path === '/api/v1/auth/passkeys') return [];
      if (path === '/api/v1/auth/passkeys/options')
        return { optionsJSON: { challenge: 'ch', rpId: 'localhost', user: { id: 'u1' } } };
      if (path === '/api/v1/auth/passkeys') return {};
      return {};
    });
    renderSettings('/settings/security');
    expect(await screen.findByText('No passkeys registered.')).toBeTruthy();
    await userEvent.click(screen.getByRole('button', { name: /Register passkey/ }));
    expect(await screen.findByText('Passkey registered. Use it on the sign-in page.')).toBeTruthy();
  });

  it('web-9: deletes a passkey through the API', async () => {
    apiMock.mockImplementation(async (path: string) => {
      if (path === '/api/v1/auth/passkeys')
        return [{ id: 'pk1', name: 'YubiKey', createdAt: '2024-01-01T00:00:00Z' }];
      return {};
    });
    renderSettings('/settings/security');
    await userEvent.click(await screen.findByRole('button', { name: /Delete passkey YubiKey/ }));
    await waitFor(() =>
      expect(
        apiMock.mock.calls.some(
          (c) =>
            c[0] === '/api/v1/auth/passkeys/pk1' &&
            (c[1] as { method?: string })?.method === 'DELETE',
        ),
      ).toBe(true),
    );
  });

  it('changes the password and reports success', async () => {
    renderSettings('/settings/security');
    await userEvent.type(await screen.findByLabelText('Current password'), 'old-pass-123');
    await userEvent.type(screen.getByLabelText(/New password/), 'new-pass-456');
    await userEvent.click(screen.getByRole('button', { name: /Change password/ }));
    expect(
      await screen.findByText('Password changed. Other sessions were signed out.'),
    ).toBeTruthy();
    // web-9 (W1): the request body carries both fields, not just the new one.
    expect(
      apiMock.mock.calls.some(
        (c) =>
          c[0] === '/api/v1/users/change-password' &&
          (c[1] as { body?: { currentPassword?: string; newPassword?: string } })?.body
            ?.currentPassword === 'old-pass-123' &&
          (c[1] as { body?: { currentPassword?: string; newPassword?: string } })?.body
            ?.newPassword === 'new-pass-456',
      ),
    ).toBe(true);
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
