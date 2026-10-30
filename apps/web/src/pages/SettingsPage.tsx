// Settings: profile, security (TOTP/passkeys/password), sessions,
// preferences, privacy & retention, data export and account deletion.

import { useState } from 'react';
import { useLocation } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Download, KeyRound, Laptop, Lock, Plus, ShieldCheck, Smartphone, Trash2, UserCircle } from 'lucide-react';
import { api, ApiError } from '../api/client';
import { useAuth } from '../auth/AuthContext';
import { Badge, Button, Card, Field, Input, Modal, Select } from '../components/ui';
import { fmtDateTime } from '../lib/format';
import type { SessionInfo } from '@voltlink/shared';

export default function SettingsPage() {
  const location = useLocation();
  const tab = location.pathname.split('/')[2] ?? 'profile';
  const navigate = (t: string) => window.history.pushState(null, '', `/settings/${t}`);
  const tabs = [
    { id: 'profile', label: 'Profile', icon: UserCircle },
    { id: 'security', label: 'Security', icon: ShieldCheck },
    { id: 'sessions', label: 'Sessions', icon: Laptop },
    { id: 'privacy', label: 'Privacy & data', icon: Lock },
  ];
  return (
    <div className="space-y-4">
      <h1 className="text-lg font-extrabold">Settings</h1>
      <div className="flex gap-1 overflow-x-auto rounded-lg border border-line bg-panel p-1" role="tablist">
        {tabs.map((t) => (
          <button key={t.id} role="tab" aria-selected={tab === t.id} onClick={() => navigate(t.id)} className={`flex shrink-0 items-center gap-1.5 rounded-md px-3 py-2 text-sm ${tab === t.id ? 'bg-panel2 text-ink' : 'text-subtle'}`}>
            <t.icon size={14} /> {t.label}
          </button>
        ))}
      </div>
      {tab === 'profile' && <ProfileTab />}
      {tab === 'security' && <SecurityTab />}
      {tab === 'sessions' && <SessionsTab />}
      {tab === 'privacy' && <PrivacyTab />}
    </div>
  );
}

function ProfileTab() {
  const { user, refresh } = useAuth();
  const [units, setUnits] = useState(user?.units ?? 'metric');
  const [timezone, setTimezone] = useState(user?.timezone ?? 'UTC');
  const [presentation, setPresentation] = useState(user?.presentationMode ?? false);
  const save = useMutation({
    mutationFn: () => api('/api/v1/users/settings', { method: 'PATCH', body: { units, timezone, presentationMode: presentation } }),
    onSuccess: () => refresh(),
  });
  const { data: settings } = useQuery({ queryKey: ['user-settings'], queryFn: () => api<{ orgName: string; telemetryRetentionDays: number }>('/api/v1/users/settings') });
  const timezones = useMemoTimezones();

  return (
    <div className="grid gap-4 lg:grid-cols-2">
      <Card title="Display & units">
        <div className="space-y-3">
          <Field label="Units">
            <Select value={units} onChange={(e) => setUnits(e.target.value as 'metric' | 'imperial')}>
              <option value="metric">Metric (km, °C, kW)</option>
              <option value="imperial">Imperial (mi, °F)</option>
            </Select>
          </Field>
          <Field label="Time zone">
            <Select value={timezone} onChange={(e) => setTimezone(e.target.value)}>
              {timezones.map((t) => <option key={t} value={t}>{t}</option>)}
            </Select>
          </Field>
          <label className="flex items-center gap-2 text-sm">
            <input type="checkbox" className="h-4 w-4 accent-[var(--vl-accent)]" checked={presentation} onChange={(e) => setPresentation(e.target.checked)} />
            Presentation mode (deterministic fictional data, no live providers)
          </label>
          <Button loading={save.isPending} onClick={() => save.mutate()}>Save preferences</Button>
        </div>
      </Card>
      <Card title="Instance information">
        <p className="text-sm text-subtle">Organization name: <strong>{settings?.orgName ?? 'VoltLink'}</strong></p>
        <p className="mt-1 text-sm text-subtle">Telemetry retention: {settings?.telemetryRetentionDays ?? 365} days</p>
        <p className="mt-2 text-xs text-faint">Organization branding is configured by the instance administrator.</p>
      </Card>
    </div>
  );
}

function useMemoTimezones(): string[] {
  try {
    return Intl.supportedValuesOf('timeZone');
  } catch {
    return ['UTC', 'America/New_York', 'America/Chicago', 'America/Denver', 'America/Los_Angeles', 'Europe/London', 'Europe/Berlin'];
  }
}

function SecurityTab() {
  const { user } = useAuth();
  const qc = useQueryClient();
  const [totpOpen, setTotpOpen] = useState(false);
  const [passkeyName, setPasskeyName] = useState('My passkey');
  const [password, setPassword] = useState('');
  const [newPassword, setNewPassword] = useState('');
  const [error, setError] = useState('');
  const [success, setSuccess] = useState('');

  const { data: passkeys } = useQuery({ queryKey: ['passkeys'], queryFn: () => api<{ id: string; name: string; createdAt: string }[]>('/api/v1/auth/passkeys') });

  const changePassword = useMutation({
    mutationFn: () => api('/api/v1/users/change-password', { method: 'POST', body: { currentPassword: password, newPassword } }),
    onSuccess: () => { setSuccess('Password changed. Other sessions were signed out.'); setPassword(''); setNewPassword(''); },
    onError: (e) => setError(e instanceof ApiError ? e.message : 'Change failed'),
  });

  const deletePasskey = useMutation({
    mutationFn: (id: string) => api(`/api/v1/auth/passkeys/${id}`, { method: 'POST' }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['passkeys'] }),
  });

  const registerPasskey = async () => {
    setError('');
    try {
      const options = await api<{ challenge: string; user: { id: string; name: string; displayName: string }; rp: { id: string; name: string }; excludeCredentials?: { id: string }[] }>('/api/v1/auth/passkey/register-options');
      const cred = (await navigator.credentials.create({
        publicKey: {
          challenge: b64decode(options.challenge),
          rp: options.rp,
          user: { id: b64decode(options.user.id), name: options.user.name, displayName: options.user.displayName },
          pubKeyCredParams: [
            { type: 'public-key', alg: -7 },
            { type: 'public-key', alg: -257 },
          ],
          excludeCredentials: (options.excludeCredentials ?? []).map((c) => ({ id: b64decode(c.id), type: 'public-key' as const })),
          authenticatorSelection: { residentKey: 'preferred', userVerification: 'preferred' },
          attestation: 'none',
        },
      })) as PublicKeyCredential;
      const response = cred.response as AuthenticatorAttestationResponse;
      await api('/api/v1/auth/passkey/register-verify', {
        method: 'POST',
        body: {
          id: cred.id,
          rawId: b64encode(cred.rawId),
          type: 'public-key',
          response: {
            clientDataJSON: b64encode(response.clientDataJSON),
            attestationObject: b64encode(response.attestationObject),
            transports: response.getTransports?.() ?? [],
          },
        },
      });
      setSuccess('Passkey registered. Use it on the sign-in page.');
      qc.invalidateQueries({ queryKey: ['passkeys'] });
    } catch (e) {
      setError(e instanceof ApiError ? e.message : 'Passkey registration failed.');
    }
  };

  return (
    <div className="grid gap-4 lg:grid-cols-2">
      <Card title="Two-factor authentication (TOTP)">
        <p className="text-sm text-subtle">
          {user?.totpEnabled ? 'TOTP is enabled. Your sign-in asks for a 6-digit code from your authenticator app.' : 'Add an authenticator-app second factor to protect your account.'}
        </p>
        <div className="mt-3">
          <Button variant="secondary" onClick={() => setTotpOpen(true)}>
            <Smartphone size={14} /> {user?.totpEnabled ? 'Disable TOTP' : 'Set up TOTP'}
          </Button>
        </div>
      </Card>

      <Card title="Passkeys (WebAuthn)">
        <ul className="space-y-2">
          {(passkeys ?? []).map((p) => (
            <li key={p.id} className="flex items-center justify-between rounded-lg border border-line bg-panel2 px-3 py-2 text-sm">
              <span className="flex items-center gap-2"><KeyRound size={13} className="text-accent" /> {p.name} <span className="text-xs text-faint">{fmtDateTime(p.createdAt)}</span></span>
              <Button variant="ghost" className="px-2 py-1 text-xs text-danger" onClick={() => deletePasskey.mutate(p.id)}><Trash2 size={12} /></Button>
            </li>
          ))}
          {(passkeys ?? []).length === 0 && <p className="py-1 text-sm text-faint">No passkeys registered.</p>}
        </ul>
        <div className="mt-3 flex items-end gap-2">
          <Field label="Passkey name">
            <Input value={passkeyName} onChange={(e) => setPasskeyName(e.target.value)} className="max-w-44" />
          </Field>
          <Button variant="secondary" onClick={registerPasskey}><Plus size={14} /> Register passkey</Button>
        </div>
      </Card>

      <Card title="Change password">
        {error && <div className="mb-3 rounded-lg border border-danger/40 bg-danger/10 px-3 py-2 text-sm text-danger" role="alert">{error}</div>}
        {success && <div className="mb-3 rounded-lg border border-ok/40 bg-ok/10 px-3 py-2 text-sm text-ok" role="status">{success}</div>}
        <div className="space-y-3">
          <Field label="Current password"><Input type="password" value={password} onChange={(e) => setPassword(e.target.value)} /></Field>
          <Field label="New password (10+ characters)"><Input type="password" value={newPassword} onChange={(e) => setNewPassword(e.target.value)} /></Field>
          <Button loading={changePassword.isPending} disabled={!password || newPassword.length < 10} onClick={() => changePassword.mutate()}>Change password</Button>
        </div>
      </Card>

      <TotpModal open={totpOpen} onClose={() => setTotpOpen(false)} />
    </div>
  );
}

function TotpModal({ open, onClose }: { open: boolean; onClose: () => void }) {
  const qc = useQueryClient();
  const { user, refresh } = useAuth();
  const [step, setStep] = useState<'setup' | 'confirm'>('setup');
  const [secret, setSecret] = useState('');
  const [code, setCode] = useState('');
  const [error, setError] = useState('');
  const [recovery, setRecovery] = useState<string[]>([]);

  const setup = useMutation({
    mutationFn: () => api<{ secret: string; otpauthUrl: string }>('/api/v1/auth/totp/setup', { method: 'POST' }),
    onSuccess: (d) => { setSecret(d.secret); setStep('confirm'); },
  });
  const confirm = useMutation({
    mutationFn: () => api<{ recoveryCodes: string[] }>('/api/v1/auth/totp/confirm', { method: 'POST', body: { code } }),
    onSuccess: (d) => { setRecovery(d.recoveryCodes ?? []); refresh(); qc.invalidateQueries(); },
    onError: (e) => setError(e instanceof ApiError ? e.message : 'Invalid code'),
  });
  const disable = useMutation({
    mutationFn: () => api('/api/v1/auth/totp/disable', { method: 'POST', body: { code } }),
    onSuccess: () => { refresh(); onClose(); },
    onError: (e) => setError(e instanceof ApiError ? e.message : 'Invalid code'),
  });

  return (
    <Modal open={open} onClose={onClose} title={user?.totpEnabled ? 'Disable TOTP' : 'Set up TOTP'}>
      <div className="space-y-3">
        {error && <div className="rounded-lg border border-danger/40 bg-danger/10 px-3 py-2 text-sm text-danger">{error}</div>}
        {user?.totpEnabled ? (
          <>
            <p className="text-sm text-subtle">Enter a current code from your authenticator app to disable TOTP.</p>
            <Field label="Current code"><Input inputMode="numeric" value={code} onChange={(e) => setCode(e.target.value)} /></Field>
            <div className="flex justify-end"><Button variant="danger" disabled={code.length !== 6} onClick={() => disable.mutate()}>Disable TOTP</Button></div>
          </>
        ) : recovery.length > 0 ? (
          <>
            <div className="rounded-lg border border-ok/40 bg-ok/10 px-3 py-2 text-sm text-ok">TOTP enabled!</div>
            <p className="text-sm text-subtle">Recovery codes (store them safely):</p>
            <ul className="grid grid-cols-2 gap-1 text-xs">{recovery.map((r) => <li key={r}><code>{r}</code></li>)}</ul>
            <div className="flex justify-end"><Button onClick={onClose}>Done</Button></div>
          </>
        ) : step === 'setup' ? (
          <>
            <p className="text-sm text-subtle">Add your account to an authenticator app (Authy, Google Authenticator, 1Password…).</p>
            <div className="flex justify-end"><Button onClick={() => setup.mutate()}>Generate secret</Button></div>
          </>
        ) : (
          <>
            <p className="text-sm text-subtle">Scan this key with your authenticator app:</p>
            <code className="break-all rounded-lg bg-panel2 p-2 text-xs">{secret}</code>
            <Field label="Verification code"><Input inputMode="numeric" value={code} onChange={(e) => setCode(e.target.value)} /></Field>
            <div className="flex justify-end"><Button disabled={code.length !== 6} loading={confirm.isPending} onClick={() => confirm.mutate()}>Verify & enable</Button></div>
          </>
        )}
      </div>
    </Modal>
  );
}

function SessionsTab() {
  const qc = useQueryClient();
  const { data: sessions } = useQuery({ queryKey: ['sessions'], queryFn: () => api<SessionInfo[]>('/api/v1/auth/sessions') });
  const revoke = useMutation({ mutationFn: (id: string) => api(`/api/v1/auth/sessions/${id}/revoke`, { method: 'POST' }), onSuccess: () => qc.invalidateQueries({ queryKey: ['sessions'] }) });
  const revokeOthers = useMutation({ mutationFn: () => api('/api/v1/auth/sessions/revoke-others', { method: 'POST' }), onSuccess: () => qc.invalidateQueries({ queryKey: ['sessions'] }) });

  return (
    <Card title="Active sessions" actions={<Button variant="secondary" onClick={() => revokeOthers.mutate()}>Sign out all other sessions</Button>}>
      <ul className="space-y-2">
        {(sessions ?? []).map((s) => (
          <li key={s.id} className="flex flex-wrap items-center gap-3 rounded-lg border border-line bg-panel2 px-3 py-2.5 text-sm">
            <Laptop size={15} className="text-subtle" />
            <div className="min-w-0 flex-1">
              <p className="truncate">{s.userAgent || 'Unknown device'}</p>
              <p className="text-xs text-faint">{s.ip} · created {fmtDateTime(s.createdAt)} · {s.lastSeenAt ? `last seen ${fmtDateTime(s.lastSeenAt)}` : ''}</p>
            </div>
            {s.current ? <Badge tone="ok">this device</Badge> : <Button variant="ghost" className="px-2 py-1 text-xs text-danger" onClick={() => revoke.mutate(s.id)}>Revoke</Button>}
          </li>
        ))}
        {(sessions ?? []).length === 0 && <p className="py-2 text-sm text-faint">No active sessions.</p>}
      </ul>
    </Card>
  );
}

function PrivacyTab() {
  const { logout } = useAuth();
  const [retention, setRetention] = useState<{ telemetryRetentionDays?: number; locationRetentionDays?: number }>({});
  const [deletePassword, setDeletePassword] = useState('');
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [error, setError] = useState('');
  const save = useMutation({ mutationFn: () => api('/api/v1/users/retention', { method: 'PATCH', body: retention }) });
  const deleteAccount = useMutation({
    mutationFn: () => api('/api/v1/users/delete', { method: 'POST', body: { password: deletePassword } }),
    onSuccess: () => { setConfirmOpen(false); logout(); },
    onError: (e) => setError(e instanceof ApiError ? e.message : 'Deletion failed'),
  });
  const exportData = async () => {
    const res = await fetch('/api/v1/users/export', { credentials: 'same-origin' });
    const blob = await res.blob();
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = 'voltlink-export.json';
    a.click();
  };

  return (
    <div className="grid gap-4 lg:grid-cols-2">
      <Card title="Retention & privacy">
        <div className="space-y-3">
          <p className="text-sm text-subtle">Configure how long vehicle telemetry and precise location history are kept.</p>
          <div className="grid grid-cols-2 gap-2">
            <Field label="Telemetry (days)"><Input type="number" min={7} max={3650} defaultValue={365} onChange={(e) => setRetention((r) => ({ ...r, telemetryRetentionDays: Number(e.target.value) }))} /></Field>
            <Field label="Location history (days)"><Input type="number" min={7} max={3650} defaultValue={90} onChange={(e) => setRetention((r) => ({ ...r, locationRetentionDays: Number(e.target.value) }))} /></Field>
          </div>
          <Button loading={save.isPending} onClick={() => save.mutate()}>Save retention policy</Button>
          <p className="text-xs text-faint">Privacy zones redact displayed addresses. Disconnect a provider to remove its stored credentials.</p>
        </div>
      </Card>

      <Card title="Export & delete your data">
        <div className="space-y-3">
          <p className="text-sm text-subtle">Download everything VoltLink stores about you — vehicles, drives, charging, commands, and preferences.</p>
          <Button variant="secondary" onClick={exportData}><Download size={14} /> Export my data (JSON)</Button>
          <div className="border-t border-line pt-3">
            <p className="text-sm text-subtle">Permanently delete your account, vehicles, history, and encrypted provider credentials.</p>
            <Button variant="danger" className="mt-2" onClick={() => setConfirmOpen(true)}><Trash2 size={14} /> Delete account</Button>
          </div>
        </div>
      </Card>

      <Modal open={confirmOpen} onClose={() => setConfirmOpen(false)} title="Delete account?">
        <div className="space-y-3">
          {error && <div className="rounded-lg border border-danger/40 bg-danger/10 px-3 py-2 text-sm text-danger">{error}</div>}
          <p className="text-sm text-subtle">This removes your personal data, deactivates your vehicles, and removes provider credentials. It cannot be undone.</p>
          <Field label="Confirm with your password"><Input type="password" value={deletePassword} onChange={(e) => setDeletePassword(e.target.value)} /></Field>
          <div className="flex justify-end gap-2">
            <Button variant="ghost" onClick={() => setConfirmOpen(false)}>Cancel</Button>
            <Button variant="danger" loading={deleteAccount.isPending} disabled={!deletePassword} onClick={() => deleteAccount.mutate()}>Permanently delete</Button>
          </div>
        </div>
      </Modal>
    </div>
  );
}

function b64encode(buf: ArrayBuffer): string {
  return btoa(String.fromCharCode(...new Uint8Array(buf))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
function b64decode(s: string): Uint8Array<ArrayBuffer> {
  const pad = s.replace(/-/g, '+').replace(/_/g, '/');
  const bin = atob(pad);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}
